---
title: "When a materialized view refresh blocks production"
description: "How a routine PostgreSQL materialized view refresh turned a small lookup query into a production incident, and what we changed afterward."
date: 2026-09-16
tags: [postgres, databases, rails, performance]
---

The query that alerted us looked almost impossible to blame:

```sql
SELECT option_code
FROM organization_option_codes
WHERE organization_id = $1;
```

It was a small lookup used by an API endpoint. There was no complicated join, no large report, and no obvious reason for it to take minutes.

Then we looked at `pg_stat_activity` and found many copies of the query in this state:

```text
state           = active
wait_event_type = Lock
wait_event      = relation
```

The query was not slow because PostgreSQL was struggling to find the rows. It had not started reading them yet. It was waiting to acquire a relation-level lock.

The blocker was another deceptively ordinary query:

```sql
REFRESH MATERIALIZED VIEW organization_option_codes;
```

That was the beginning of a long morning.

## The setup

The names in this post are intentionally generic, but the shape of the system was common:

- a materialized view held organization-specific option data;
- the application read it directly from user-facing API paths;
- a background job refreshed it periodically;
- the refresh used PostgreSQL's default, non-concurrent mode.

In a Rails application, the refresh was hidden behind a model or database-view helper. That abstraction made the job easy to call, but it also made the lock behavior easy to miss. The effective SQL was still:

```sql
REFRESH MATERIALIZED VIEW organization_option_codes;
```

The important word is not `MATERIALIZED`. It is the missing `CONCURRENTLY`.

## What a normal refresh locks

A materialized view stores the result of a query on disk. Refreshing it means PostgreSQL runs the defining query again and replaces the stored result.

For a regular refresh, PostgreSQL takes an `ACCESS EXCLUSIVE` lock on the materialized view. A plain `SELECT` takes an `ACCESS SHARE` lock. Those lock modes conflict, so readers wait while the refresh is in progress. PostgreSQL's documentation calls this out directly: a refresh without `CONCURRENTLY` can block connections trying to read the materialized view, while only `ACCESS EXCLUSIVE` blocks an ordinary `SELECT`.

That gave us this sequence:

```text
refresh job starts
  -> materialized view gets ACCESS EXCLUSIVE lock
  -> API request tries to SELECT from the view
  -> SELECT waits on a relation lock
  -> more requests arrive and wait
  -> connection pools and web workers begin to fill
```

This was not a deadlock. A deadlock is a cycle: transaction A waits for B while B waits for A. Here, many readers were waiting behind one long-running refresh. It was a lock convoy.

## What the database told us

The production snapshot made the relationship visible once we read it as a timeline rather than as a list of unrelated queries.

The refresh had been running for more than half an hour and was waiting on a data-file read:

```text
state           = active
wait_event_type = IO
wait_event      = DataFileRead
query           = REFRESH MATERIALIZED VIEW organization_option_codes;
```

At the same time, several ordinary option lookups had been waiting on:

```text
wait_event_type = Lock
wait_event      = relation
```

The refresh was doing real work: reading source tables and rebuilding the view. The waiting `SELECT`s were not consuming much CPU individually, but they occupied database connections and application workers. Other expensive reporting queries were also active and competing for disk bandwidth, which made the refresh slower. The longer the refresh ran, the longer the API requests remained blocked.

That is how a lock problem can show up as a database CPU alarm. The lock itself does not necessarily burn CPU. Instead, a long-running rebuild can create IO pressure, while blocked requests accumulate and the rest of the workload competes for the same database resources. CPU saturation may be part of the feedback loop or a parallel symptom, not proof that the lock is doing the computation.

## Why the query said `active`

`active` does not mean “currently using CPU.” In `pg_stat_activity`, a backend can be active while waiting for a lock or an IO event.

The useful columns are:

```sql
SELECT
  pid,
  clock_timestamp() - query_start AS running_for,
  state,
  wait_event_type,
  wait_event,
  left(query, 160) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY query_start;
```

`wait_event_type = 'Lock'` tells us that the backend is waiting on a lock. `wait_event = 'relation'` means the lock concerns a relation such as a table or materialized view. PostgreSQL documents these wait events and provides `pg_locks` for examining the locks themselves.

To find the blocker, a query like this is useful during an incident:

```sql
SELECT
  blocked.pid AS blocked_pid,
  blocking.pid AS blocking_pid,
  blocked.query AS blocked_query,
  blocking.query AS blocking_query,
  blocking.state AS blocking_state,
  clock_timestamp() - blocking.query_start AS blocking_for
FROM pg_stat_activity AS blocked
JOIN pg_locks AS blocked_lock
  ON blocked_lock.pid = blocked.pid
  AND NOT blocked_lock.granted
JOIN pg_locks AS blocking_lock
  ON blocking_lock.locktype = blocked_lock.locktype
  AND blocking_lock.database IS NOT DISTINCT FROM blocked_lock.database
  AND blocking_lock.relation IS NOT DISTINCT FROM blocked_lock.relation
  AND blocking_lock.page IS NOT DISTINCT FROM blocked_lock.page
  AND blocking_lock.tuple IS NOT DISTINCT FROM blocked_lock.tuple
  AND blocking_lock.virtualxid IS NOT DISTINCT FROM blocked_lock.virtualxid
  AND blocking_lock.transactionid IS NOT DISTINCT FROM blocked_lock.transactionid
  AND blocking_lock.classid IS NOT DISTINCT FROM blocked_lock.classid
  AND blocking_lock.objid IS NOT DISTINCT FROM blocked_lock.objid
  AND blocking_lock.objsubid IS NOT DISTINCT FROM blocked_lock.objsubid
  AND blocking_lock.pid <> blocked_lock.pid
JOIN pg_stat_activity AS blocking
  ON blocking.pid = blocking_lock.pid
WHERE blocking_lock.granted;
```

On newer PostgreSQL versions, `pg_blocking_pids(blocked.pid)` is often a simpler way to get the blocking process IDs. The exact diagnostic query matters less than asking two questions quickly: “Who is waiting?” and “Who is holding the conflicting lock?”

## The safer refresh mode

PostgreSQL supports:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY organization_option_codes;
```

This mode refreshes the view without locking out concurrent `SELECT`s. It does more work and is not automatically faster, but it trades some refresh efficiency for reader availability—which is usually the right trade for a view used on a production request path.

There are requirements:

- the materialized view must already be populated;
- it must have a qualifying unique index;
- the index must use only column names, cover every row, and not be a partial or expression index;
- only one refresh can run against a given materialized view at a time, even with `CONCURRENTLY`.

For example, if the data model guarantees that an organization can have each option code only once:

```sql
CREATE UNIQUE INDEX CONCURRENTLY
  index_organization_option_codes_on_organization_and_code
ON organization_option_codes (organization_id, option_code);
```

That index is valid only if `(organization_id, option_code)` is genuinely unique. An index added merely to satisfy the command is dangerous: duplicate rows would make the index creation fail, and changing the view's uniqueness assumptions can hide a data problem.

In a Rails application, the call should make the behavior explicit:

```ruby
DatabaseViews.refresh(
  :organization_option_codes,
  concurrently: true
)
```

The helper name will vary by library. The thing worth checking is the SQL it sends, not the name of the Ruby method.

## What we changed

Concurrent refresh was the primary fix, but it was not the whole operating model. We also added guardrails:

1. Set a `statement_timeout` for refresh jobs so a rebuild cannot run without a ceiling.
2. Set a small `lock_timeout` so a job fails quickly if it cannot acquire its initial lock.
3. Prevent overlapping refresh jobs with a scheduler-level uniqueness rule or a PostgreSQL advisory lock.
4. Record the view name, start time, end time, row count if available, and failure reason.
5. Alert on refresh duration, blocked sessions, and connection-pool pressure—not only CPU.
6. Run heavy reporting work away from the busiest refresh window where possible.
7. Test the refresh path against production-sized data, because a refresh that takes seconds on a laptop can take tens of minutes at scale.

Timeouts do not make a refresh faster. They limit the blast radius. `statement_timeout` covers the statement's total execution time; `lock_timeout` covers time spent waiting to acquire a lock. They should be chosen deliberately and logged as expected operational failures.

## When a materialized view is the wrong cache

Materialized views are a good fit for expensive derived data that can tolerate some staleness. They are less attractive when all of the following are true:

- the view is read on almost every page or request;
- the view is rebuilt from a large and frequently changing dataset;
- stale values are acceptable, but temporary unavailability is not;
- a small lookup table or an indexed query could answer the request directly.

For a simple option list, a normalized lookup table may be easier to update incrementally and easier to operate. A carefully indexed query, an application cache, or a separately refreshed table may also be a better boundary than rebuilding a large result set synchronously in the primary database.

The right choice depends on freshness requirements and write volume. The important question is not “Can this query be materialized?” It is “What happens to the user-facing path while this result is being rebuilt?”

## The lesson

A materialized view is not just a read-only table. Its refresh strategy is part of the availability design.

The production failure came from a reasonable-looking combination: a user-facing `SELECT`, a background refresh, and PostgreSQL's default refresh mode. Individually, none of those looked alarming. Together, they created a long lock convoy, exhausted application capacity, and contributed to a database resource spike.

Before putting a materialized view behind an API endpoint, answer three questions:

1. Can it be refreshed concurrently?
2. What unique index makes that possible?
3. What is the fallback if the refresh is slow, fails, or overlaps with another run?

For user-facing lookup data, a slightly stale answer is usually better than no answer. Availability is a feature too.

## Further reading

- [PostgreSQL: `REFRESH MATERIALIZED VIEW`](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html)
- [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL: The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
