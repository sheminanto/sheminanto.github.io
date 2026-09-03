---
title: "Postgres advisory locks in Rails"
description: "A simple note on using Postgres advisory locks from Rails when only one process should run a critical section."
date: 2026-09-04
tags: [rails, postgres]
---

Sometimes an application needs to make sure that only one process runs a piece of code at a time.

For example:

- only one worker should sync a customer account
- only one request should generate a monthly report
- only one job should rebuild a cache for a given key

Postgres advisory locks are useful for this kind of coordination.

## What is an advisory lock?

An advisory lock is a lock that Postgres gives you, but does not automatically attach to a table row.

That is the important part. A normal row lock protects a row. An advisory lock protects an idea that your application defines.

The lock could mean:

```text
sync account 42
```

or:

```text
generate report for September 2026
```

Postgres does not know what the lock means. Your application gives it meaning by using the same lock key in every place that needs coordination.

## A small Rails wrapper

Postgres advisory locks use integer keys. One neat way to use them in Rails is to hide the lock and unlock calls behind a small wrapper:

```ruby
# frozen_string_literal: true

class Database::AdvisoryLock
  def self.with_lock(lock_key)
    raise ArgumentError, "block required" unless block_given?
    raise ArgumentError, "lock_key required" if lock_key.nil?

    ActiveRecord::Base.connection_pool.with_connection do |connection|
      quoted_key = connection.quote(lock_key.to_i)
      result = connection.execute("SELECT pg_try_advisory_lock(#{quoted_key}) AS locked")
      locked = result.first["locked"]

      unless locked
        Rails.logger.info("Failed to acquire advisory lock for key: #{lock_key}")
        next
      end

      Rails.logger.info("Acquired advisory lock for key: #{lock_key}")

      begin
        yield
      ensure
        connection.execute("SELECT pg_advisory_unlock(#{quoted_key})")
      end
    end
  end
end
```

Then the caller can keep the important code readable:

```ruby
lock_key = Zlib.crc32("account-sync-#{account.id}")

Database::AdvisoryLock.with_lock(lock_key) do
  AccountSync.call(account)
end
```

This version uses `pg_try_advisory_lock`. The word `try` matters.

If the lock is available, Postgres takes it and the block runs. If another process already has the same lock, Postgres returns false immediately and the block is skipped.

That is useful for background jobs where duplicate work should be avoided, not queued.

## A useful background job example

Imagine a recurring job that runs every 10 minutes:

```ruby
class RefreshReportsJob < ApplicationJob
  def perform
    Database::AdvisoryLock.with_lock(12345) do
      Reports::Refresh.call
    end
  end
end
```

Most of the time, the job finishes before the next run starts. But sometimes the work takes longer. Maybe the database is slow, an external API is delayed, or a deploy causes jobs to pile up.

Without a lock, several copies of the same job may run at the same time. That can waste resources, create noisy logs, and make the job harder to reason about.

With `pg_try_advisory_lock`, only the first job gets the lock and runs the block. If 10 more copies of the job are waiting or start around the same time, they fail to get the lock and skip the work.

That makes it a good fit for jobs where "someone should do this soon" matters more than "every queued copy must run."

## Always unlock

`pg_try_advisory_lock` creates a session-level lock. It stays held until the same database session unlocks it or the connection closes.

That is why the `ensure` block matters:

```ruby
begin
  yield
ensure
  connection.execute("SELECT pg_advisory_unlock(#{quoted_key})")
end
```

Even if the work raises an error, Rails still sends the unlock query before the connection goes back to the pool.

Without that cleanup, a reused connection could keep holding the lock longer than intended.

## Blocking vs non-blocking locks

Postgres gives you a few advisory-lock functions. The two common choices are:

```sql
SELECT pg_advisory_lock(123);
SELECT pg_try_advisory_lock(123);
```

`pg_advisory_lock` waits until the lock is available.

`pg_try_advisory_lock` returns immediately with true or false.

Use the waiting version when the work must happen eventually. Use the try version when it is fine to skip because another process is already doing the same work.

There are also transaction-level versions, such as `pg_advisory_xact_lock`, which release automatically when the transaction ends. Those are easier to reason about when the protected work naturally belongs inside a database transaction.

## When advisory locks are a good fit

Advisory locks work well when the thing you want to protect is not a single database row.

They are a good fit for coordinating background jobs, scheduled tasks, imports, exports, cache rebuilds, and other critical sections that may be triggered more than once.

They are not a replacement for database constraints. If a column must be unique, keep a unique index. If a row must not be updated by two transactions at once, use row locks.

## Keep the locked section small

The code inside the lock should be as small as possible.

Do the work that needs coordination, then release the lock quickly. Long locks can make other jobs wait and can turn a simple safety mechanism into a bottleneck.

The short version: use Postgres advisory locks in Rails when you need application-level coordination around a shared key. Use `pg_try_advisory_lock` when duplicate work should be skipped, and always unlock in an `ensure` block.
