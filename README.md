# ReviewIntel

AI-powered product review intelligence on AWS. Ingests product reviews, generates
sentiment and aspect-level summaries with Amazon Bedrock, and serves them through
a React dashboard. Built as a portfolio project for Amazon SDE-1 readiness:
event-driven, single-table DynamoDB, infrastructure as code, operational
excellence from day one.

## Architecture

```
[Review dataset] --cron--> [EC2 t3.micro worker] --raw JSON--> [S3 data lake]
                                                        \--> [SQS queue]
[SQS] --event--> [Lambda: processor] --Bedrock Haiku--> [DynamoDB single table]
[React dashboard] <--CloudFront-- [S3 site bucket]
[API Gateway] --> [Lambda: api] --> [DynamoDB]
[EventBridge: nightly 03:00 UTC] --> [Lambda: processor] (recompute)
[CloudWatch alarms] watches Lambda errors + DLQ depth
```

Data model (single table):
- `PK=PRODUCT#<id>`, `SK=REVIEW#<id>` — one item per processed review
- `PK=PRODUCT#<id>`, `SK=SUMMARY` — aggregated product summary
- GSI `SentimentIndex`: `sentiment` (PK), `SK` — faceted browsing by sentiment

## Free-tier cost table

| Service | Free tier | This project |
|---|---|---|
| EC2 t3.micro | 750 hrs/mo, 12 mo | One worker, destroy when not demoing |
| Lambda | 1M req + 400k GB-s/mo, always | Two functions, well under limits |
| DynamoDB | 25 GB + 25 RCU/WCU, always | Pay-per-request, tiny dataset |
| SQS | 1M req/mo, always | One queue + DLQ |
| S3 | 5 GB, 12 mo | Two small buckets |
| API Gateway | 1M calls/mo, 12 mo | Read API |
| CloudFront | 1 TB + 10M req/mo | Static dashboard |
| CloudWatch | 10 metrics/alarms | 3 alarms |
| EventBridge | Scheduled rules free | One nightly rule |
| IAM | Always free | Least-privilege roles |

Deliberately NOT deployed: NAT gateway (~$32/mo — worker uses a public
subnet), ElastiCache (no free tier — in-memory cache in the API Lambda
instead), Route 53 domain ($0.50/mo — CloudFront default URL).

Bedrock is pay-per-token; a demo's worth of Haiku summaries costs a few cents.
Process each review once and cache results.

## Prerequisites

- AWS account with Free Tier available (check Billing > Free Tier)
- AWS CLI configured (`aws configure`) — credentials stay on your machine,
  never in this repo
- Node.js 20+, Python 3.12+, AWS CDK (`npm install -g aws-cdk`)
- Bedrock model access enabled for the Haiku model in your region
  (Console > Bedrock > Model access)

## Deploy

```bash
make install     # install CDK, frontend, and Python deps
make synth       # sanity-check the CloudFormation template (no creds needed)
make deploy      # build frontend + deploy stack + sync site to S3
```

After deploy, the CloudFront URL is printed and also in stack outputs
(`SiteUrl`, `ApiUrl`).

Set a $5 billing budget with an 80% alert in the console after first deploy.

## Teardown (important)

The EC2 worker burns free-tier hours while running. When not demoing:

```bash
make destroy
```

## k6 load-test plan

Target: the read path (`GET /products`, `GET /products/{id}/summary`).

1. `k6 run loadtest/smoke.js` with `API_URL` set to the deployed API.
2. Stages: 30s ramp to 20 VUs, 2m steady, 30s ramp-down.
3. Record p50/p95 latency and error rate; paste results into the README table
   below. Expect p95 < 500ms at 20 VUs on pay-per-request DynamoDB.

| Endpoint | VUs | p50 | p95 | Errors |
|---|---|---|---|---|
| GET /products + /products/{id}/summary (mixed) | 20 | 1350ms | 2006ms | 0% (warm); 5% on cold start |

Measured 2026-10-10 against the live API with 200 requests at 20 concurrent
workers (Python harness; k6 smoke script in `loadtest/smoke.js` covers the same
endpoints). p99 was 2064ms. Latency is dominated by Lambda cold starts: each
concurrent execution spins up a fresh Python+boto3 environment (~1s), so p50
tracks cold-start time under burst concurrency rather than DynamoDB (the table
holds 3 items; scans are single-digit ms). Production mitigations, in order of
leverage: provisioned concurrency for the read Lambda, then the ElastiCache
layer from the design doc. Full numbers in `loadtest/results.md`.

## Project layout

- `cdk/` — TypeScript CDK app (VPC, S3, SQS, DynamoDB, Lambdas, API Gateway,
  CloudFront, EventBridge, CloudWatch alarms, IAM)
- `lambdas/processor/` — SQS consumer: Bedrock summarization → DynamoDB
- `lambdas/api/` — API Gateway handler: product list + summaries
- `worker/` — EC2 ingest worker (user-data + Python cron job)
- `frontend/` — Vite + React + TypeScript dashboard
- `loadtest/` — k6 smoke script
- `DESIGN_DOC.md` — narrative design doc (Amazon style)
