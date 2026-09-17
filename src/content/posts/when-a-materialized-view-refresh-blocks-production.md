---
title: "A materialized view refresh can block production"
description: "What blocked production, how we found it, and how to make PostgreSQL materialized view refreshes safer."
date: 2026-09-16
tags: [postgres, databases, rails, performance]
---

Materialized views are useful because they make expensive queries fast. But a refresh can also make a fast query wait—and that wait can spread through the application.

This is what happened to an API endpoint that read a small list of options:

```sql
SELECT option_code
FROM organization_option_codes
WHERE organization_id = $1;
```

The query suddenly took minutes. The problem was not the query plan or the number of rows returned. It was waiting for a lock held by this background job:

```sql
REFRESH MATERIALIZED VIEW organization_option_codes;
```

## Why production was blocked

A materialized view stores the result of its defining query. A refresh runs that query again and replaces the stored result.

The default refresh takes an `ACCESS EXCLUSIVE` lock on the materialized view. A normal `SELECT` takes an `ACCESS SHARE` lock. These locks conflict, so reads cannot proceed until the refresh finishes.

The failure looked like this:

```text
refresh starts
  -> materialized view is locked
  -> API requests wait
  -> waiting requests hold database connections and web workers
  -> new requests have less capacity available
```

This is lock contention. It is not necessarily a deadlock, and it does not require high CPU usage. The database can look mostly idle while requests are stuck waiting.

## What the connection count told us

The primary had 629 connections, but most were idle. The useful summary was:

| Application group | State | Connections |
| --- | --- | ---: |
| Solid Queue (`bin/jobs`) | idle | 557 |
| Puma | active | 58 |
| Puma | idle | 5 |
| Rails consoles | idle/active | 4 |
| Other sessions | idle/active | 5 |
| **Total** |  | **629** |

Puma and Solid Queue CPU and memory usage were normal. So the connection count was not evidence that 629 queries were actively consuming resources. It did show how much connection capacity was occupied, and lock-waiting requests could consume that capacity even when CPU and memory looked healthy.

## How we identified the blocker

`pg_stat_activity` showed API requests in this state:

```text
state           = active
wait_event_type = Lock
wait_event      = relation
```

`wait_event_type = 'Lock'` told us that the sessions were waiting for a lock, rather than executing the query. We then matched the waiting sessions to the session holding the lock:

```sql
SELECT
  blocked.pid AS blocked_pid,
  blocking.pid AS blocking_pid,
  clock_timestamp() - blocked.query_start AS blocked_for,
  left(blocking.query, 200) AS blocking_query
FROM pg_stat_activity AS blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker(pid)
JOIN pg_stat_activity AS blocking ON blocking.pid = blocker.pid
WHERE blocked.wait_event_type = 'Lock';
```

The blocking query was the materialized view refresh. `pg_locks` can provide more detail when the lock mode or relation needs to be inspected.

## How to prevent it

### Refresh concurrently

For a populated materialized view, use:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY organization_option_codes;
```

This keeps the existing data available to ordinary reads while PostgreSQL builds the replacement. It requires:

- the materialized view is already populated;
- a unique, non-partial index exists on the view;
- the index uses columns rather than expressions and covers every row;
- only one refresh runs for that view at a time.

For example, if the data guarantees that an organization cannot have the same option code twice:

```sql
CREATE UNIQUE INDEX CONCURRENTLY
  index_option_codes_on_organization_and_code
ON organization_option_codes (organization_id, option_code);
```

The uniqueness must be true in the data. Do not add an index only to satisfy the refresh requirement.

### Make the Rails refresh explicit

The application should execute the concurrent form directly, or use a library only after confirming the SQL it generates:

```ruby
class RefreshOrganizationOptionCodesJob < ApplicationJob
  def perform
    ApplicationRecord.connection.execute(<<~SQL)
      REFRESH MATERIALIZED VIEW CONCURRENTLY organization_option_codes
    SQL
  end
end
```

Run this outside an explicit application transaction. Also prevent duplicate refresh jobs with a PostgreSQL advisory lock or a job-uniqueness mechanism. Concurrent refreshes do not allow two refreshes of the same view to run at once.

### Add operational guardrails

- Set an appropriate `statement_timeout` for the refresh.
- Set a short `lock_timeout` so it fails quickly if it cannot start.
- Log refresh duration and failures.
- Alert on blocked reads and connection-pool saturation.
- Schedule expensive refreshes away from peak traffic when possible.

Be careful with timeout scope: a setting left on a pooled Rails connection can affect later work. Reset it or use a dedicated refresh connection.

## Do you need a materialized view?

For a small lookup list, a normal indexed query, lookup table, or application cache may be simpler and safer. The right choice depends on query cost, data size, and how much staleness the application can tolerate.

The important question is not only how fast the view is to read. It is also what happens to user-facing requests while the view is being rebuilt.

## The takeaway

A materialized view can improve read performance and still threaten availability if it is refreshed with the blocking default.

Before using one in a user-facing path, make sure:

1. the refresh uses `CONCURRENTLY` where appropriate;
2. the required unique index is valid for the data;
3. refreshes are bounded, observable, and not duplicated;
4. the application has a fallback if fresh data is temporarily unavailable.

For lookup data, slightly stale results are often better than blocked reads.

## Further reading

- [PostgreSQL: `REFRESH MATERIALIZED VIEW`](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html)
- [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL: Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring-stats.html)
