/**
 * ReviewIntel read-path smoke test.
 *
 * Usage:
 *   API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com/prod k6 run loadtest/smoke.js
 *
 * Stages: 30s ramp to 20 VUs, 2m steady, 30s ramp-down.
 * Paste the p50/p95 numbers into the README load-test table.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const API_URL = __ENV.API_URL;
if (!API_URL) {
  throw new Error('Set API_URL env var, e.g. API_URL=https://... k6 run loadtest/smoke.js');
}

export default function () {
  const list = http.get(`${API_URL}/products`);
  check(list, { 'GET /products 200': (r) => r.status === 200 });

  let productId = null;
  try {
    productId = JSON.parse(list.body).products?.[0]?.product_id;
  } catch {
    /* empty catalog: skip detail call */
  }

  if (productId) {
    const detail = http.get(`${API_URL}/products/${productId}/summary`);
    check(detail, { 'GET /products/{id}/summary 200': (r) => r.status === 200 });
  }

  sleep(1);
}
