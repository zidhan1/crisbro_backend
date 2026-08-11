# Sales worker isolated load test — 2026-08-11

## Safety and profile

- Fixture-only; no production database, cron, customer sync, or Runchise API.
- Stages: 1, 5, 10, and 29 outlets.
- Load: 5 pages x 100 transactions per outlet.
- Mix per page: 84 synced, 14 zero-point skipped, and 2 invalid skipped.
- A deterministic transient timeout is injected every 37 requests. A retry
  represents the next worker invocation repeating the unchanged cursor.
- DB query count is the number of logical Prisma/worker operations observed by
  the adapter, not PostgreSQL wire-protocol statements.
- Duration measures local fixture/JavaScript overhead. It does not include real
  network or PostgreSQL latency and must not be treated as production capacity.

## Baseline results (before bulk write)

| Outlets | Records | Duration | Peak RSS | Peak heap | DB operations | Runchise requests | Retry | Request failure | Final record failure |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 500 | 15.33 ms | 70.38 MiB | 12.05 MiB | 510 | 5 | 0 | 0% | 0% |
| 5 | 2,500 | 15.44 ms | 74.31 MiB | 14.35 MiB | 2,550 | 25 | 0 | 0% | 0% |
| 10 | 5,000 | 23.88 ms | 77.78 MiB | 14.47 MiB | 5,100 | 51 | 1 | 1.961% | 0% |
| 29 | 14,500 | 56.09 ms | 81.46 MiB | 14.89 MiB | 14,790 | 149 | 4 | 2.685% | 0% |

All injected failures were recovered by retrying the same cursor. No record was
lost and every stage completed.

## Main finding before bulk-write optimization

Memory remained bounded because the worker retains one page at a time. The main
remaining scaling risk is database round trips: the 29-outlet fixture produced
14,790 logical DB operations, largely one upsert/delete per transaction. Before
calling this production-ready at full volume, run the same profile against an
ephemeral PostgreSQL database and replace per-row report writes with a bulk
`INSERT ... ON CONFLICT` page operation.

## Result after bulk-write optimization

Each page now uses two customer lookups, one transaction, at most two bulk data
statements (zero-point delete and report upsert), and one cursor checkpoint. The
fixture therefore observes six logical database operations per completed page.

| Outlets | Records | DB operations before | DB operations after | Reduction | Retry | Final record failure |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 500 | 510 | 30 | 94.12% | 0 | 0% |
| 5 | 2,500 | 2,550 | 150 | 94.12% | 0 | 0% |
| 10 | 5,000 | 5,100 | 300 | 94.12% | 1 | 0% |
| 29 | 14,500 | 14,790 | 870 | 94.12% | 4 | 0% |

## Disposable PostgreSQL integration profile

The same stages were executed against PostgreSQL 17 on loopback. The database
was initialized solely for this test. The runner requires
`LOAD_TEST_DATABASE_URL` and refuses non-loopback hosts or database names that
do not contain `load` or `test`.

| Outlets | Records | Stored | Duration | Peak RSS | Peak heap | PostgreSQL queries | Queries/page | Failure |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 500 | 420 | 347.03 ms | 80.01 MiB | 14.47 MiB | 30 | 6 | 0% |
| 5 | 2,500 | 2,100 | 492.67 ms | 94.38 MiB | 20.69 MiB | 150 | 6 | 0% |
| 10 | 5,000 | 4,200 | 1,076.36 ms | 119.61 MiB | 35.87 MiB | 300 | 6 | 0% |
| 29 | 14,500 | 12,180 | 3,160.83 ms | 142.46 MiB | 51.27 MiB | 870 | 6 | 0% |

`stored` excludes the deterministic zero-point and invalid fixtures. Its value
matched the expected `synced` count at every stage. These local timings validate
the SQL shape, conflict handling, bounded page processing, and data integrity;
they are not a substitute for production network-latency monitoring.
