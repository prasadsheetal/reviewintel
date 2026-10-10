import { useEffect, useState } from 'react';
import { fetchProducts, type ProductSummary } from '../api';

interface Props {
  onSelect: (productId: string) => void;
}

export default function ProductList({ onSelect }: Props) {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProducts()
      .then((res) => setProducts(res.products))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading products…</div>;
  if (error) return <div className="error">Failed to load products: {error}</div>;
  if (products.length === 0)
    return <div className="loading">No products yet — run the ingest worker first.</div>;

  return (
    <div>
      {products.map((p) => (
        <div key={p.product_id} className="card" onClick={() => onSelect(p.product_id)}>
          <h3 style={{ margin: '0 0 8px' }}>{p.product_id}</h3>
          <span className={`badge ${p.overall_sentiment ?? 'neutral'}`}>
            {p.overall_sentiment ?? 'unknown'}
          </span>
          <span style={{ marginLeft: 12, color: '#666', fontSize: 13 }}>
            {p.review_count} reviews
          </span>
        </div>
      ))}
    </div>
  );
}
