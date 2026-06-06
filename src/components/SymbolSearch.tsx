import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Clock, Loader2 } from 'lucide-react';
import { useSymbolSearch, Instrument } from '../hooks/useSymbolSearch';

interface Props {
  onSelect: (instrument: Instrument) => void;
  currentSymbol: string;
}

export function SymbolSearch({ onSelect, currentSymbol }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const { query, setQuery, results, loading, recent, addRecent } = useSymbolSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const displayList = query.length >= 2 ? results : recent;

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(-1);
  }, [query, displayList.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev < displayList.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < displayList.length) {
        handleSelect(displayList[selectedIndex]);
      } else if (displayList.length > 0) {
        handleSelect(displayList[0]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleSelect = (instrument: Instrument) => {
    addRecent(instrument);
    onSelect(instrument);
    setIsOpen(false);
    setQuery('');
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  };

  const renderItem = (item: Instrument, index: number, isRecent = false) => {
    const isSelected = index === selectedIndex;
    return (
      <div
        key={item.instrument_token}
        className={`px-4 py-2 cursor-pointer flex items-center justify-between border-b border-slate-800/50 last:border-0 ${
          isSelected ? 'bg-slate-800' : 'hover:bg-slate-800/70'
        }`}
        onClick={() => handleSelect(item)}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            {isRecent && <Clock size={12} className="text-slate-500" />}
            <span className="font-semibold text-slate-200">{item.tradingsymbol}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
              {item.exchange}
            </span>
          </div>
          <span className="text-xs text-slate-500 mt-0.5 truncate max-w-[200px] sm:max-w-[300px]">
            {item.name}
          </span>
        </div>
        <div className="flex flex-col items-end text-xs text-slate-400">
          <span className="text-slate-500">{item.instrument_type}</span>
          {(item.strike || item.expiry) && (
            <span>
              {item.strike ? `${item.strike} ` : ''}
              {formatDate(item.expiry)}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="relative w-[250px] shrink-0" ref={containerRef}>
      <div 
        className="flex items-center bg-[#0d1117] border border-slate-700/50 rounded transition-all cursor-text group w-full px-3 h-9"
        onClick={() => {
          setIsOpen(true);
          inputRef.current?.focus();
        }}
      >
        <Search size={16} className={`mr-2 shrink-0 transition-colors ${isOpen ? 'text-slate-400' : 'text-slate-400 group-hover:text-indigo-400'}`} />
        
        {isOpen ? (
          <div className="flex items-center w-full flex-1">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search symbol, name..."
              className="bg-transparent border-none outline-none ring-0 focus:ring-0 focus:outline-none text-sm text-white w-full placeholder:text-slate-500 p-0 m-0 shadow-none !border-transparent !border-0 focus:!border-transparent focus:!ring-0 min-w-0"
              style={{ boxShadow: 'none' }}
              autoFocus
            />
            {query.length > 0 && (
              <X
                size={14}
                className="text-slate-500 hover:text-white cursor-pointer shrink-0 ml-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setQuery('');
                  inputRef.current?.focus();
                }}
              />
            )}
            {loading && <Loader2 size={14} className="text-indigo-400 animate-spin shrink-0 ml-2" />}
          </div>
        ) : (
          <span className="text-sm font-medium text-slate-200 truncate flex-1">
            {currentSymbol}
          </span>
        )}
      </div>

      {isOpen && (query.length > 0 || recent.length > 0) && (
        <div className="absolute top-full left-0 mt-1 w-[350px] sm:w-[450px] max-h-[400px] overflow-y-auto bg-slate-900 border border-slate-700/50 rounded-md shadow-xl z-[100] flex flex-col custom-scrollbar">
          {!query && recent.length > 0 && (
            <div className="py-2">
              <div className="px-4 pb-1 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                Recent Symbols
              </div>
              {recent.map((item, i) => renderItem(item, i, true))}
            </div>
          )}
          
          {query.length > 0 && query.length < 2 && (
            <div className="px-4 py-3 text-sm text-slate-500 text-center">
              Type at least 2 characters to search...
            </div>
          )}

          {query.length >= 2 && !loading && results.length === 0 && (
            <div className="px-4 py-4 text-sm text-slate-500 text-center">
              No symbols found for "{query}"
            </div>
          )}

          {query.length >= 2 && results.length > 0 && (
            <div className="py-1">
              {results.map((item, i) => renderItem(item, i, false))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
