"""ReviewIntel processor Lambda.

Consumes SQS batches from the EC2 ingest worker, calls Amazon Bedrock
(Haiku-class model) for sentiment + aspect summaries, and writes results
to the DynamoDB single table.

Event shapes:
  - SQS record body: {"product_id": str, "reviews": [...]} or
    {"product_id": str, "s3_key": str} (raw batch in S3).
  - EventBridge scheduled event: {"action": "recompute"} for the nightly pass.
"""

import json
import logging
import os
from decimal import Decimal

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ["TABLE_NAME"]
RAW_BUCKET_NAME = os.environ.get("RAW_BUCKET_NAME", "")
BEDROCK_MODEL_ID = os.environ.get(
    "BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0"
)

dynamodb = boto3.resource("dynamodb")
s3 = boto3.client("s3")
bedrock = boto3.client("bedrock-runtime")
table = dynamodb.Table(TABLE_NAME)

PROMPT_TEMPLATE = """\
You are a review-analysis assistant. Given the product reviews below as JSON,
return ONLY a JSON array, one object per review, with this exact shape:
{{"review_id": "...", "sentiment": "positive|neutral|negative",
  "aspects": {{"shipping": "...", "quality": "...", "value": "..."}},
  "summary": "one sentence"}}
Aspect values are one of: "praised", "criticized", "not mentioned".

Reviews:
{reviews_json}
"""


def _to_decimal(value):
    """Recursively convert floats to Decimal for DynamoDB."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_decimal(v) for v in value]
    return value


def analyze_reviews(reviews):
    """Call Bedrock for sentiment + aspect summaries. Returns a list of dicts."""
    response = bedrock.converse(
        modelId=BEDROCK_MODEL_ID,
        messages=[
            {
                "role": "user",
                "content": [
                    {"text": PROMPT_TEMPLATE.format(reviews_json=json.dumps(reviews))}
                ],
            }
        ],
        inferenceConfig={"maxTokens": 2000, "temperature": 0.2},
    )
    text = response["output"]["message"]["content"][0]["text"].strip()
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        # TODO: harden parsing (strip code fences, retry once). For the
        # scaffold we degrade gracefully instead of failing the batch.
        logger.warning("Bedrock returned non-JSON; storing raw text as summary")
        return [
            {
                "review_id": r.get("review_id", "unknown"),
                "sentiment": "neutral",
                "aspects": {},
                "summary": text[:500],
            }
            for r in reviews
        ]


def write_results(product_id, analyses):
    """Write review items + one aggregated SUMMARY item via batch writer."""
    counts = {"positive": 0, "neutral": 0, "negative": 0}
    for a in analyses:
        counts[a.get("sentiment", "neutral")] = (
            counts.get(a.get("sentiment", "neutral"), 0) + 1
        )

    with table.batch_writer() as batch:
        for a in analyses:
            batch.put_item(
                Item=_to_decimal(
                    {
                        "PK": f"PRODUCT#{product_id}",
                        "SK": f"REVIEW#{a.get('review_id')}",
                        "product_id": product_id,
                        "sentiment": a.get("sentiment", "neutral"),
                        "aspects": a.get("aspects", {}),
                        "summary": a.get("summary", ""),
                    }
                )
            )
        batch.put_item(
            Item={
                "PK": f"PRODUCT#{product_id}",
                "SK": "SUMMARY",
                "product_id": product_id,
                "review_count": len(analyses),
                "sentiment_counts": counts,
                "overall_sentiment": max(counts, key=counts.get),
            }
        )
    logger.info("Wrote %d reviews + summary for %s", len(analyses), product_id)


def _load_batch(body):
    """Resolve an SQS body into (product_id, reviews list)."""
    product_id = body.get("product_id", "unknown")
    if "reviews" in body:
        return product_id, body["reviews"]
    if "s3_key" in body and RAW_BUCKET_NAME:
        obj = s3.get_object(Bucket=RAW_BUCKET_NAME, Key=body["s3_key"])
        data = json.loads(obj["Body"].read().decode("utf-8"))
        # Accept either a raw list or {"product_id": ..., "reviews": [...]}.
        if isinstance(data, list):
            return product_id, data
        return data.get("product_id", product_id), data.get("reviews", [])
    raise ValueError("SQS body must contain 'reviews' or 's3_key'")


def handle_sqs_record(record):
    body = json.loads(record["body"])
    product_id, reviews = _load_batch(body)
    if not reviews:
        logger.info("Empty batch for %s, skipping", product_id)
        return
    analyses = analyze_reviews(reviews)
    write_results(product_id, analyses)


def handle_recompute():
    """Nightly pass: re-aggregate summaries from stored reviews.

    TODO: at scale, replace the scan with DynamoDB Streams for incremental
    updates. Fine for demo-size data.
    """
    logger.info("Starting nightly recompute pass")
    # Group REVIEW items by product. Scan is acceptable at demo scale.
    products = {}
    scan_kwargs = {
        "FilterExpression": "begins_with(SK, :prefix)",
        "ExpressionAttributeValues": {":prefix": "REVIEW#"},
    }
    while True:
        resp = table.scan(**scan_kwargs)
        for item in resp.get("Items", []):
            products.setdefault(item["product_id"], []).append(item)
        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    for product_id, items in products.items():
        counts = {"positive": 0, "neutral": 0, "negative": 0}
        for item in items:
            s = item.get("sentiment", "neutral")
            counts[s] = counts.get(s, 0) + 1
        table.put_item(
            Item={
                "PK": f"PRODUCT#{product_id}",
                "SK": "SUMMARY",
                "product_id": product_id,
                "review_count": len(items),
                "sentiment_counts": counts,
                "overall_sentiment": max(counts, key=counts.get),
            }
        )
    logger.info("Recomputed %d product summaries", len(products))


def lambda_handler(event, context):
    if isinstance(event, dict) and event.get("action") == "recompute":
        handle_recompute()
        return {"status": "recomputed"}
    for record in event.get("Records", []):
        try:
            handle_sqs_record(record)
        except Exception:
            # Raising lets SQS retry, then the DLQ after maxReceiveCount.
            logger.exception("Failed to process SQS record")
            raise
    return {"status": "ok"}
