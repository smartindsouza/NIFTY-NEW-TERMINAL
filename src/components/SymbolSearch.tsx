import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Clock, Loader2, Plus, Check } from 'lucide-react';
import { useSymbolSearch, Instrument } from '../hooks/useSymbolSearch';
import { searchLabel } from '../lib/optionName';

interface Props {
  onSelect: (instrument: Instrument) => void;
  currentSymbol: string;
  // The phone chart's header shows this only after its search button is tapped:
  // it starts with the field open and the keyboard up, and tells the header
  // when it has closed (a tap elsewhere, Escape, or a symbol chosen) so the
  // header can put the chart's name back.
  autoOpen?: boolean;
  onClose?: () => void;
  // THE + BESIDE A RESULT (17 Nov 2026): puts it on the list of charts beside
  // the index's tab, or takes it off, without opening it. `takes` says which
  // results may go on that list at all (the desktop's option half holds options
  // only); `has` whether one is on it. Not given, no + is shown.
  list?: {
    takes: (instrument: Instrument) => boolean;
    has: (tradingsymbol: string) => boolean;
    toggle: (instrument: Instrument) => void;
  };
}

export function SymbolSearch({ onSelect, currentSymbol, autoOpen, onClose, list }: Props) {
  const [isOpen, setIsOpen] = useState(!!autoOpen);
  const wasOpen = useRef(!!autoOpen);
  useEffect(() => {
    if (wasOpen.current && !isOpen) onClose?.();
    wasOpen.current = isOpen;
  }, [isOpen]);
  // NO MESSAGES OVER AN OPEN SEARCH (17 Nov 2026). Martin: "do not show any
  // alert or notifications when I search in the search bar because it blocks my
  // search". The app's messages come down from the top of the screen, which is
  // where the field and its first results are. While the search is open the
  // page says so (data-search-open on the body) and the messages are not drawn
  // (src/index.css). Nothing is thrown away: one still due when the search
  // closes is shown then, and anything spoken or sent to Telegram still is.
  useEffect(() => {
    if (!isOpen) return;
    document.body.setAttribute('data-search-open', '');
    return () => document.body.removeAttribute('data-search-open');
  }, [isOpen]);
  const { query, setQuery, results, loading, recent, addRecent } = useSymbolSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const displayList = query.length >= 2 ? results : recent;

  // A TAP OUTSIDE CLOSES IT (17 Nov 2026). Martin, of the search open on his
  // phone: "Also close it when I tap outside the search bar." This listened for
  // mousedown, which a phone only makes up after a touch that nothing claimed —
  // and the chart claims every touch on it, so a tap on the chart, which is
  // most of what is outside, never arrived. pointerdown is the touch itself; it
  // is heard on the way down (capture), before anything under the finger can
  // stop it. The tap still does whatever it would have done where it landed.
  useEffect(() => {
    const handleOutside = (e: Event) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('pointerdown', handleOutside, true);
    }
    return () => document.removeEventListener('pointerdown', handleOutside, true);
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
    // HALF THE SIZE (17 Nov 2026). Martin, with a picture of the results: "The
    // search results fonts can be reduced to half the size. Also add a plus icon
    // next to it to add them to the list beside the nifty chart in the main
    // charts screen." The lines were 16px over 12px in rows 59 tall; they are
    // 11px over 9px in rows 42 tall. (8px would be half to the letter, and too
    // small to read on a phone.)
    // THE +: puts the result on the list beside the index's tab (the option
    // charts' list), without opening it, so several can be lined up from one
    // search. On the list already, it is a tick, and a tap takes it off. Not on
    // an index — the indices have the index tab's own list. A finger on it does
    // not take the keyboard away (pointerdown is not let blur the field).
    const onList = !!list && (item as any).segment !== 'INDICES' && list.takes(item);
    const isListed = onList && list!.has(item.tradingsymbol);
    const plus = onList ? (
      <button
        type="button"
        data-search-add={item.tradingsymbol}
        data-listed={isListed ? 'yes' : 'no'}
        aria-label={isListed ? 'Take off the chart list' : 'Add to the chart list'}
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); list!.toggle(item); }}
        className={`shrink-0 h-9 w-9 -my-[7px] -mr-3 flex items-center justify-center active:bg-foreground/10 hover:bg-foreground/5 ${isListed ? 'text-emerald-400' : 'text-foreground/70'}`}
      >
        {isListed ? <Check size={15} strokeWidth={2.4} /> : <Plus size={15} strokeWidth={2.2} />}
      </button>
    ) : null;
    // AN OPTION OR A FUTURE IS TWO LINES, IN WORDS (17 Nov 2026). Martin: "Show
    // the search in this format
    // NIFTY 17th (w) NOV 23500 CE
    // 17 NOV WEEKLY".
    // The row was Zerodha's symbol (NIFTY26N1723500CE) with the exchange, the
    // name, the type, the strike and the date around it — everything the two
    // lines now say once. A share, an index or a fund has no such lines
    // (searchLabel gives none) and is listed as it was.
    const label = searchLabel(item);
    if (label) {
      return (
        <div
          key={item.instrument_token}
          data-search-row={item.tradingsymbol}
          className={`px-4 py-[7px] cursor-pointer flex items-center gap-2 border-b /50 last:border-0 ${
            isSelected ? 'bg-muted' : 'hover:bg-muted/70'
          }`}
          onClick={() => handleSelect(item)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          {isRecent && <Clock size={10} className="text-muted-foreground shrink-0" />}
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[11px] leading-[14px] font-semibold text-foreground/90 truncate">{label.title}</span>
            <span className="text-[9px] leading-[12px] text-muted-foreground mt-px truncate">{label.sub}</span>
          </div>
          {plus}
        </div>
      );
    }
    return (
      <div
        key={item.instrument_token}
        data-search-row={item.tradingsymbol}
        className={`px-4 py-[7px] cursor-pointer flex items-center justify-between gap-2 border-b /50 last:border-0 ${
          isSelected ? 'bg-muted' : 'hover:bg-muted/70'
        }`}
        onClick={() => handleSelect(item)}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5">
            {isRecent && <Clock size={10} className="text-muted-foreground" />}
            <span className="text-[11px] leading-[14px] font-semibold text-foreground/90">{item.tradingsymbol}</span>
            <span className="text-[8px] leading-none px-1 py-0.5 rounded bg-muted text-muted-foreground">
              {item.exchange}
            </span>
          </div>
          <span className="text-[9px] leading-[12px] text-muted-foreground mt-px truncate max-w-[200px] sm:max-w-[300px]">
            {item.name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-end text-[9px] leading-[12px] text-muted-foreground">
            <span className="text-muted-foreground">{item.instrument_type}</span>
            {(item.strike || item.expiry) && (
              <span>
                {item.strike ? `${item.strike} ` : ''}
                {formatDate(item.expiry)}
              </span>
            )}
          </div>
          {plus}
        </div>
      </div>
    );
  };

  return (
    <div className="relative w-full max-w-full sm:w-[250px] sm:shrink-0" ref={containerRef}>
      <div 
        className="flex items-center bg-card border border-0 rounded-full transition-all cursor-text group w-full px-2 sm:px-3 h-9"
        onClick={() => {
          setIsOpen(true);
          inputRef.current?.focus();
        }}
      >
        <Search size={16} className={`mr-1.5 sm:mr-2 shrink-0 transition-colors ${isOpen ? 'text-muted-foreground' : 'text-muted-foreground group-hover:text-primary'}`} />
        
        {isOpen ? (
          <div className="flex items-center w-full flex-1">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search symbol, name..."
              className="bg-transparent border-none outline-none ring-0 focus:ring-0 focus:outline-none text-sm text-foreground w-full placeholder:text-muted-foreground p-0 m-0 !border-transparent !border-0 focus:!border-transparent focus:!ring-0 min-w-0"
              style={{ boxShadow: 'none' }}
              autoFocus
            />
            {loading && <Loader2 size={14} className="text-primary animate-spin shrink-0 ml-2" />}
            {/* THE × IS ALWAYS THERE (17 Nov 2026). Martin, with a picture of
                the field open and empty: "there's no close button inside the
                search to close the empty search bar." The × stood only while
                there was something typed, and what it did was rub that out, so
                an empty field had no way shut but choosing a symbol. It is
                there whenever the field is: with text it clears the text and
                keeps the keyboard, as it did; with none it closes the search.
                A button the height of the field, so a thumb finds it. */}
            <button
              type="button"
              data-search="close"
              aria-label={query.length > 0 ? 'Clear search' : 'Close search'}
              title={query.length > 0 ? 'Clear' : 'Close'}
              className="shrink-0 h-9 w-8 -mr-1.5 sm:-mr-2 flex items-center justify-center text-muted-foreground hover:text-foreground active:opacity-60"
              onClick={(e) => {
                e.stopPropagation();
                if (query.length > 0) {
                  setQuery('');
                  inputRef.current?.focus();
                } else {
                  setIsOpen(false);
                }
              }}
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <span className="text-sm font-medium text-muted-foreground truncate flex-1">
            {/* The chart already names the instrument in its title and tab, so
                repeating it here made the control look like a label rather than
                the search it is. */}
            Search
          </span>
        )}
      </div>

      {isOpen && (query.length > 0 || recent.length > 0) && (
        <div className="absolute top-full left-0 mt-1 w-full sm:w-[450px] max-h-[400px] overflow-y-auto bg-card border border-0 rounded-2xl z-[100] flex flex-col custom-scrollbar">
          {!query && recent.length > 0 && (
            <div className="py-2">
              <div className="px-4 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Recent Symbols
              </div>
              {recent.map((item, i) => renderItem(item, i, true))}
            </div>
          )}
          
          {query.length > 0 && query.length < 2 && (
            <div className="px-4 py-3 text-sm text-muted-foreground text-center">
              Type at least 2 characters to search...
            </div>
          )}

          {query.length >= 2 && !loading && results.length === 0 && (
            <div className="px-4 py-4 text-sm text-muted-foreground text-center">
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
