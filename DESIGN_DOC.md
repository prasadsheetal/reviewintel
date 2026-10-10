# ReviewIntel — design doc

## Problem

Shoppers drown in reviews. A product with 10,000 reviews is effectively
unreadable, and star averages hide the details that drive decisions ("is the
shipping slow?", "does the quality hold up?"). ReviewIntel turns raw review
text into structured, queryable intelligence: per-product sentiment, aspect
summaries (shipping, quality, value), and faceted browsing.

## Goals

- Ingest product reviews on a schedule and keep summaries fresh.
- Serve per-product AI summaries with p95 latency under 500ms.
- Run the whole system inside AWS Free Tier at demo scale (target: $0,
  Bedrock usage a few cents).
- Demonstrate production-shaped engineering: IaC, least-privilege IAM,
  alarms, runbooks, load-test numbers.

## Non-goals

- Real-time streaming ingestion (batch is fine for this use case).
- Multi-tenant auth, payments, or user accounts.
- Training custom models — foundation models via Bedrock are sufficient.
- A custom domain (CloudFront default URL keeps it free).

## Proposed design

**Ingest (batch).** A t3.micro EC2 worker in a public subnet runs a daily
cron job: download a slice of public review data, upload raw JSON to S3 (the
data lake), and enqueue one SQS message per batch. Public subnet is a
deliberate choice — it avoids the NAT gateway (~$32/mo) that private subnets
would require. The worker is torn down when not demoing.

**Process (event-driven).** SQS triggers the processor Lambda. Each batch is
sent to Bedrock (Haiku-class model, cheapest capable option) with a prompt
that returns structured JSON: sentiment per review plus aspect summaries.
Results land in a single DynamoDB table:

- `PK=PRODUCT#<id>`, `SK=REVIEW#<id>` — processed reviews
- `PK=PRODUCT#<id>`, `SK=SUMMARY` — aggregated product summary
- GSI `SentimentIndex` on `sentiment` — faceted browsing ("show me negative
  reviews about shipping")

A DLQ captures poison batches; CloudWatch alarms fire on Lambda errors and
DLQ depth.

**Serve.** API Gateway fronts a read Lambda (`GET /products`,
`GET /products/{id}/summary`). A 60-second in-memory cache in the Lambda
covers hot products. The React dashboard is static-hosted on S3 behind
CloudFront.

**Refresh.** An EventBridge rule triggers a nightly recompute pass so
summaries stay fresh as new batches arrive.

## Alternatives considered and tradeoffs

- **Lambda vs EC2 for ingestion.** Lambda is cheaper and simpler, but the
  worker pattern demonstrates EC2/VPC/user-data skills and handles long,
  stateful downloads naturally. EC2 also gives a clean teardown story for
  free-tier hour management.
- **RDS vs DynamoDB.** RDS would be familiar, but DynamoDB's always-free
  tier, single-digit-millisecond reads, and natural fit for key-based access
  patterns win at this scale. Single-table design keeps all product data in
  one queryable place; the tradeoff is that ad-hoc analytics are harder —
  acceptable for a serving workload.
- **ElastiCache.** Considered for the hot-product cache, rejected for
  deployment: no reliable free tier. Documented as the production upgrade
  path; the in-memory Lambda cache plus DynamoDB TTL is sufficient now.
- **SageMaker custom model.** Rejected: Bedrock foundation models need no
  training infra and cost cents at demo scale.

## Operational excellence

- All infrastructure in CDK (TypeScript), one stack, reproducible deploys.
- Least-privilege IAM: separate roles for the EC2 worker and each Lambda.
- Alarms: processor errors, DLQ messages visible, API 5xx rate.
- Billing budget ($5) with 80% alert; Free Tier dashboard checked after deploy.
- Runbook: DLQ alarm → inspect message in console → fix or purge; Bedrock
  throttling → reduce batch size via the `BATCH_SIZE` env var.

## Open questions

- Which public review dataset slice to standardize on for the demo seed?
- Should the nightly recompute be incremental (DynamoDB Streams) once the
  dataset grows? (Deferred — scan is fine at demo scale.)
- k6 numbers to fill in after first deploy (see README).
