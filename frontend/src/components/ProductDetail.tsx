import { useEffect, useState } from 'react';
import { fetchSummary, type ProductSummary } from '../api';

interface Props {
  productId: string;
  onBack: () => void;
}

export default function ProductDetail({ productId, onBack }: Props) {
  const [summary, setSummary] = useState<ProductSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchSummary(productId)
      .then(setSummary)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [productId]);

  return (
    <div>
      <button className="back-btn" onClick={onBack}>
        ← All products
      </button>
      {loading && <div className="loading">Loading summary…</div>}
      {error && <div className="error">Failed to load summary: {error}</div>}
      {summary && (
        <div className="detail-grid">
          <div className="card" style={{ cursor: 'default' }}>
            <h3>Overall sentiment</h3>
            <span className={`badge ${summary.overall_sentiment ?? 'neutral'}`}>
              {summary.overall_sentiment ?? 'unknown'}
            </span>
            <p style={{ color: '#666' }}>{summary.review_count} reviews analyzed</p>
          </div>
          <div className="card" style={{ cursor: 'default' }}>
            <h3>Sentiment breakdown</h3>
            {Object.entries(summary.sentiment_counts).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ textTransform: 'capitalize' }}>{k}</span>
                <strong>{v}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
