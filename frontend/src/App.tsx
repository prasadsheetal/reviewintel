import { useState } from 'react';
import ProductList from './components/ProductList';
import ProductDetail from './components/ProductDetail';
import ArchitectureDiagram from './components/ArchitectureDiagram';

export default function App() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="app">
      <header>
        <h1>ReviewIntel</h1>
        <p>AI-powered product review intelligence, running on AWS.</p>
      </header>

      {selected ? (
        <ProductDetail productId={selected} onBack={() => setSelected(null)} />
      ) : (
        <ProductList onSelect={setSelected} />
      )}

      <ArchitectureDiagram />
    </div>
  );
}
