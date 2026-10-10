/** Typed client for the ReviewIntel read API (API Gateway + Lambda). */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');

if (!API_URL || API_URL.includes('REPLACE_WITH')) {
  // eslint-disable-next-line no-console
  console.warn('VITE_API_URL is not set — API calls will fail. See .env.example.');
}

export interface ProductSummary {
  product_id: string;
  review_count: number;
  overall_sentiment: 'positive' | 'neutral' | 'negative' | null;
  sentiment_counts: Record<string, number>;
}

export interface ProductListResponse {
  products: ProductSummary[];
  next_token?: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export function fetchProducts(nextToken?: string): Promise<ProductListResponse> {
  const qs = nextToken ? `?next_token=${encodeURIComponent(nextToken)}` : '';
  return get<ProductListResponse>(`/products${qs}`);
}

export function fetchSummary(productId: string): Promise<ProductSummary> {
  return get<ProductSummary>(`/products/${encodeURIComponent(productId)}/summary`);
}
