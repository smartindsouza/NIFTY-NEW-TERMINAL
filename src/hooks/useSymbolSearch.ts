import { useState, useEffect } from 'react';

export interface Instrument {
  tradingsymbol: string;
  name: string;
  exchange: string;
  instrument_type: string;
  expiry?: string;
  strike?: number;
  instrument_token: number;
}

export function useSymbolSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Instrument[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<Instrument[]>(() => {
    try {
      const saved = localStorage.getItem('recent_symbols');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch(`/api/instruments/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data);
        }
      } catch (e) {
        console.error("Search failed", e);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const addRecent = (instrument: Instrument) => {
    setRecent(prev => {
      const filtered = prev.filter(i => i.instrument_token !== instrument.instrument_token);
      const updated = [instrument, ...filtered].slice(0, 10);
      localStorage.setItem('recent_symbols', JSON.stringify(updated));
      return updated;
    });
  };

  return {
    query,
    setQuery,
    results,
    loading,
    recent,
    addRecent
  };
}
