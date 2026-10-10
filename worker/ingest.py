"""ReviewIntel ingest worker.

Runs on the EC2 t3.micro via cron (see user-data.sh). Each run:
  1. Downloads a small sample of product reviews (configurable URL, with a
     synthetic fallback so the pipeline works end to end with no network).
  2. Uploads the raw JSON batch to S3 (data lake).
  3. Sends one SQS message per product batch to trigger the processor Lambda.

Environment (injected by the cron file created in user-data.sh):
  RAW_BUCKET, QUEUE_URL, SAMPLE_DATA_URL (optional), BATCH_SIZE (optional).
"""

import datetime
import json
import logging
import os
import urllib.request

import boto3

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ingest")

RAW_BUCKET = os.environ["RAW_BUCKET"]
QUEUE_URL = os.environ["QUEUE_URL"]
SAMPLE_DATA_URL = os.environ.get("SAMPLE_DATA_URL", "")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))

s3 = boto3.client("s3")
sqs = boto3.client("sqs")


def synthetic_sample():
    """Tiny built-in dataset so the pipeline is testable offline.

    TODO: replace with a real slice, e.g. a small partition of the Amazon
    Reviews 2023 dataset, hosted at SAMPLE_DATA_URL.
    """
    products = {
        "headphones-x1": "Aurora X1 Wireless Headphones",
        "kettle-pro": "KettlePro Electric Kettle",
    }
    templates = [
        (5, "positive", "Sound quality is amazing and shipping was fast."),
        (4, "positive", "Great value for the price, works as expected."),
        (2, "negative", "Stopped working after a week, poor quality."),
        (3, "neutral", "It is okay, nothing special, shipping took long."),
        (5, "positive", "Excellent build quality, highly recommended."),
        (1, "negative", "Terrible value, broke on arrival."),
    ]
    reviews = []
    rid = 0
    for pid in products:
        for stars, _sent, text in templates:
            rid += 1
            reviews.append(
                {
                    "review_id": f"r{rid}",
                    "product_id": pid,
                    "product_name": products[pid],
                    "stars": stars,
                    "text": text,
                }
            )
    return reviews


def download_sample():
    if not SAMPLE_DATA_URL:
        logger.info("SAMPLE_DATA_URL not set; using synthetic sample")
        return synthetic_sample()
    try:
        with urllib.request.urlopen(SAMPLE_DATA_URL, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        reviews = data["reviews"] if isinstance(data, dict) else data
        logger.info("Downloaded %d reviews from %s", len(reviews), SAMPLE_DATA_URL)
        return reviews
    except Exception:
        logger.exception("Download failed; falling back to synthetic sample")
        return synthetic_sample()


def main():
    reviews = download_sample()
    if not reviews:
        logger.info("No reviews; nothing to do")
        return

    # Group by product so each SQS message is one product batch.
    batches = {}
    for r in reviews:
        batches.setdefault(r.get("product_id", "unknown"), []).append(r)

    today = datetime.date.today().isoformat()
    for product_id, items in batches.items():
        for i in range(0, len(items), BATCH_SIZE):
            chunk = items[i : i + BATCH_SIZE]
            s3_key = f"raw/{today}/{product_id}-{i // BATCH_SIZE}.json"
            s3.put_object(
                Bucket=RAW_BUCKET,
                Key=s3_key,
                Body=json.dumps(chunk).encode("utf-8"),
                ContentType="application/json",
            )
            sqs.send_message(
                QueueUrl=QUEUE_URL,
                MessageBody=json.dumps(
                    {"product_id": product_id, "reviews": chunk, "s3_key": s3_key}
                ),
            )
            logger.info("Enqueued batch %s (%d reviews)", s3_key, len(chunk))

    logger.info("Done: %d reviews across %d products", len(reviews), len(batches))


if __name__ == "__main__":
    main()
