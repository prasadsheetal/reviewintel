# Load-test results — 2026-10-10

Target: live read API (`https://34r6afhfx3.execute-api.us-east-1.amazonaws.com/prod/`),
endpoints `GET /products` and `GET /products/{id}/summary` (100 requests each).

Harness: Python `ThreadPoolExecutor`, 20 concurrent workers, 200 total requests
(same endpoints as `loadtest/smoke.js`; k6 was not installed in this environment).

## Cold run (Lambda cold)

| metric | value |
|---|---|
| requests | 200 |
| ok | 190 (95%) |
| failed | 10 (5%) |
| total time | 14.6s (~13.7 rps) |
| p50 | 1302ms |
| p95 | 2892ms |
| p99 | 3200ms |

## Warm run (steady state)

| metric | value |
|---|---|
| requests | 200 |
| ok | 200 (100%) |
| failed | 0 |
| total time | 14.1s (~14.2 rps) |
| p50 | 1350ms |
| p95 | 2006ms |
| p99 | 2064ms |

## Notes

- DynamoDB table held 3 items; scan latency is single-digit ms, so it is not
  the bottleneck.
- p50 tracks Lambda cold-start time (~1s for Python + boto3 init) because 20
  concurrent workers force that many parallel execution environments.
- The 5% cold-run errors were burst-timeout flakes during environment init.
- Cheapest fixes in order: provisioned concurrency on the read Lambda, then the
  ElastiCache caching layer described in DESIGN_DOC.md.
