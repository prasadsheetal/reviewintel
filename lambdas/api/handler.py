"""ReviewIntel read API Lambda (behind API Gateway).

Routes:
  GET /products                 -> paginated list of product summaries
  GET /products/{id}/summary    -> single product summary

Caching: a short in-memory TTL cache. ElastiCache is documented as the
production upgrade path in DESIGN_DOC.md but is NOT deployed (no free tier).
"""

import json
import logging
import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ["TABLE_NAME"]
table = boto3.resource("dynamodb").Table(TABLE_NAME)

# Poor-man's cache: (value, timestamp). Enough for demo traffic.
_CACHE_TTL_SECONDS = 60
_cache: dict = {}


def _cached(key, loader):
    now = time.time()
    entry = _cache.get(key)
    if entry and now - entry[1] < _CACHE_TTL_SECONDS:
        return entry[0]
    value = loader()
    _cache[key] = (value, now)
    return value


def _json_default(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body, default=_json_default),
    }


def list_products(next_token=None):
    """Scan SUMMARY items. Scan is fine at demo scale; add a PRODUCTS GSI
    or a dedicated index table once the catalog grows (see TODO below)."""
    kwargs = {
        "FilterExpression": "SK = :sk",
        "ExpressionAttributeValues": {":sk": "SUMMARY"},
        "Limit": 50,
    }
    if next_token:
        kwargs["ExclusiveStartKey"] = json.loads(next_token)
    resp = table.scan(**kwargs)
    items = [
        {
            "product_id": i["product_id"],
            "review_count": i.get("review_count", 0),
            "overall_sentiment": i.get("overall_sentiment"),
            "sentiment_counts": i.get("sentiment_counts", {}),
        }
        for i in resp.get("Items", [])
    ]
    out = {"products": items}
    if "LastEvaluatedKey" in resp:
        out["next_token"] = json.dumps(resp["LastEvaluatedKey"], default=_json_default)
    return out


def get_summary(product_id):
    resp = table.get_item(Key={"PK": f"PRODUCT#{product_id}", "SK": "SUMMARY"})
    return resp.get("Item")


def lambda_handler(event, context):
    # API Gateway REST API (v1) proxy event.
    path = event.get("path", "")
    method = event.get("httpMethod", "GET")
    params = event.get("queryStringParameters") or {}
    logger.info("Request %s %s", method, path)

    if method != "GET":
        return _response(405, {"error": "method not allowed"})

    if path == "/products":
        data = _cached(
            f"products:{params.get('next_token', '')}",
            lambda: list_products(params.get("next_token")),
        )
        return _response(200, data)

    if path.startswith("/products/") and path.endswith("/summary"):
        # /products/{id}/summary
        product_id = path[len("/products/") : -len("/summary")]
        item = _cached(f"summary:{product_id}", lambda: get_summary(product_id))
        if not item:
            return _response(404, {"error": "product not found"})
        return _response(
            200,
            {
                "product_id": item["product_id"],
                "review_count": item.get("review_count", 0),
                "overall_sentiment": item.get("overall_sentiment"),
                "sentiment_counts": item.get("sentiment_counts", {}),
            },
        )

    return _response(404, {"error": "not found"})
