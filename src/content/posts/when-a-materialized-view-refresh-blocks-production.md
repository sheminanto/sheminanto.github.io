---
title: "When a materialized view refresh blocks production"
description: "How a PostgreSQL materialized view refresh blocked API reads, and what the incident revealed about connection capacity."
date: 2026-09-16
tags: [postgres, databases, rails, performance]
---

An API query that returned a short list of options started taking minutes:

```sql
SELECT option_code
FROM organization_option_codes
WHERE organization_id = $1;
```

The query was not spending minutes finding rows. `pg_stat_activity` showed requests waiting on a relation lock:

```text
state           = active
wait_event_type = Lock
wait_event      = relation
```

The blocker was a background job running:

```sql
REFRESH MATERIALIZED VIEW organization_option_codes;
```

## The failure mode

A materialized view stores the result of its defining query. A refresh recomputes that query and replaces the stored contents.

The default refresh acquires an `ACCESS EXCLUSIVE` lock on the materialized view. A plain `SELECT` takes an `ACCESS SHARE` lock, and those modes conflict. Reads therefore wait until the refresh releases its lock.

The sequence was:

```text
refresh starts
  -> materialized view is locked
  -> API reads wait
  -> waiting requests retain connections and web workers
  -> request and connection capacity is consumed
```

This is lock contention, not necessarily a deadlock or a CPU problem. A deadlock requires a cycle of sessions waiting on one another. Here, readers were waiting behind one long-running operation.

## What the connection count showed

The primary had 629 connections. Most were idle:

| Application | State | Count |
| --- | --- | ---: |
| `bin/jobs` (Solid Queue) | idle | 142 |
| `bin/jobs` | idle | 140 |
| `bin/jobs` | idle | 140 |
| `bin/jobs` | idle | 135 |
| `puma` (web) | active | 16 |
| `puma` | active | 16 |
| `puma` | active | 14 |
| `puma` | active | 12 |
| `puma` | idle | 3 |
| `puma` | idle | 2 |
| `bin/rails` (console) | idle/active | 4 (one per host) |
| Everything else | small idle/active tails | 5 |

The Solid Queue processes accounted for 557 idle connections. Puma had 58 active and 5 idle connections. CPU and memory usage for both Puma and Solid Queue were normal.

That distinction matters: 629 connections does not mean 629 queries were actively using CPU. However, a connection can still be a capacity problem. A request waiting on a lock may retain its connection and web worker, leaving less room for new work even while CPU and memory look healthy. The connection count must be interpreted alongside `state`, wait events, pool limits, and request latency.

## Finding the blocker

Start by finding sessions waiting on locks and the sessions blocking them:

```sql
SELECT
  blocked.pid AS blocked_pid,
  clock_timestamp() - blocked.query_start AS blocked_for,
  blocked.wait_event_type,
  blocked.wait_event,
  blocking.pid AS blocking_pid,
  clock_timestamp() - blocking.query_start AS blocking_for,
  left(blocking.query, 200) AS blocking_query
FROM pg_stat_activity AS blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker(pid)
JOIN pg_stat_activity AS blocking ON blocking.pid = blocker.pid
WHERE blocked.wait_event_type = 'Lock';
```

Then inspect the materialized view and its refresh job. `pg_locks` is useful when you need the lock mode and relation involved. A query that is merely `active` is not necessarily doing useful work; its `wait_event` tells you whether it is running or waiting.

## The usual fix: refresh concurrently

For a populated materialized view, PostgreSQL can refresh without blocking ordinary reads:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY organization_option_codes;
```

The existing version remains available while PostgreSQL builds the replacement. `CONCURRENTLY` requires:

- the view is already populated;
- a unique index exists on the view;
- the index uses only column names, covers every row, and is not partial;
- no other refresh is running for that view.

If `(organization_id, option_code)` is genuinely unique, the index could be:

```sql
CREATE UNIQUE INDEX CONCURRENTLY
  index_option_codes_on_organization_and_code
ON organization_option_codes (organization_id, option_code);
```

Do not add this index merely to satisfy `CONCURRENTLY`: it must represent a real invariant in the materialized-view result.

In Rails, execute the exact PostgreSQL command rather than relying on a helper whose refresh mode is unclear:

```ruby
class RefreshOrganizationOptionCodesJob < ApplicationJob
  def perform
    ApplicationRecord.connection.execute(<<~SQL)
      REFRESH MATERIALIZED VIEW CONCURRENTLY organization_option_codes
    SQL
  end
end
```

Run the refresh outside an explicit application transaction. If the refresh can be enqueued more than once, also serialize it—for example, with a PostgreSQL advisory lock or a job uniqueness mechanism. `CONCURRENTLY` still permits only one refresh of a given materialized view at a time.

## Guardrails

Concurrent refresh removes the main reader-blocking failure mode, but it does not make a refresh free or bounded. Add operational guardrails:

- measure and log refresh duration;
- set an appropriate `statement_timeout` for the refresh session;
- set a short `lock_timeout` so startup lock contention fails quickly;
- alert on blocked reads, refresh duration, and connection-pool saturation;
- prevent duplicate refresh jobs;
- schedule expensive refreshes away from the busiest periods when practical.

Be deliberate about timeout scope. A session-level setting can affect subsequent statements on a pooled Rails connection, so reset it or use a dedicated refresh connection.

## Do you need a materialized view?

For a small lookup list, a materialized view may add more operational risk than value. Consider an indexed query against ordinary tables, a lookup table, or an application cache if the data and freshness requirements allow it.

The important design question is not only how quickly the view can be read. It is what happens to a user-facing request while the view is being rebuilt.

## The lesson

A materialized view is not just a cached table; its refresh strategy is part of the availability design.

Before putting one behind an API endpoint, verify:

1. whether it can be refreshed concurrently;
2. whether the required unique index is valid for the data;
3. what happens when a refresh is slow, duplicated, or fails.

For lookup data, slightly stale results are often preferable to blocked reads.

## Further reading

- [PostgreSQL: `REFRESH MATERIALIZED VIEW`](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html)
- [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL: Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring-stats.html)
