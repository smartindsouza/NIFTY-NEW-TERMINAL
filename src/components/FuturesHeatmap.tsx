import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import axios from 'axios';
import { UpDownArrows } from './ChipBar';

// THE FUTURES HEATMAP (17 Nov 2026). Martin, with a screen recording of
// Upstox's: "I want this exact futures heat map in my homepage below at the
// end". What the recording shows, and so what this is:
//   - "Futures Heatmap", then the bar of chips: "Index ⇕" with Nifty 50,
//     Sensex, Nifty Bank, Nifty Financial Services, Nifty Midcap 50, Nifty 100,
//     Nifty 500 — a tap on "Index ⇕" turns it into "Sector ⇕" with the sectors
//     (Auto, Banks, Metals, ...) and picks the first;
//   - the expiry in a pill ("23 Nov 2026 ▾"), which opens a sheet of the
//     expiries; "Price ⇕" on the right;
//   - a grid of the chosen stocks' futures, three a row on a phone, edge to
//     edge: the stock, its change on the day, its price — coloured by the
//     change, highest first.
// "Price ⇕" turns the grid to OI: the change in open interest since the
// previous day's close, and what the price and the OI did together (long
// build-up, short covering, short build-up, long unwinding), coloured by that.
// The data is /api/futures-heatmap (server/futures_heatmap.ts); it is asked
// for every 5 seconds while the market is open, every minute otherwise.
//
// Every size, colour and distance is measured off the recording (1290 x 2796,
// 3 pixels a point).

type Row = { s: string; p: number; c: number | null; oi: number | null; oc: number | null };
type Group = { name: string; symbols: string[] };
type Payload = {
  ok: boolean; error?: string; expiries: string[]; expiry: string | null;
  index: Group[]; sector: Group[]; rows: Row[]; asOf: number; oiBase: string | null;
};

const INDEX_CHIPS = ['Nifty 50', 'Sensex', 'Nifty Bank', 'Nifty Financial Services', 'Nifty Midcap 50', 'Nifty 100', 'Nifty 500'] as const;
const SECTOR_CHIPS = ['Auto', 'Banks', 'Metals', 'Finance', 'IT', 'Pharma', 'FMCG', 'Energy', 'Oil & Gas', 'Realty', 'Media', 'PSU Banks', 'Pvt Banks', 'Healthcare', 'Consumer Durables'] as const;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "23 Nov 2026" — written out by hand, as en-GB now spells September "Sept". */
export const expiryLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? `${d} ${MON[m - 1]} ${y}` : iso;
};

function marketOpen(now = Date.now()) {
  const ist = new Date(now + 5.5 * 3600 * 1000);
  const wd = ist.getUTCDay(), m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return wd >= 1 && wd <= 5 && m >= 555 && m < 930;
}

// The six shades of the recording, by the day's change: 2% and more, 1 to 2,
// 0 to 1, and the same three below nought.
export function priceTone(c: number | null): string {
  if (c === null) return '#262626';
  if (c >= 2) return '#108e4d';
  if (c >= 1) return '#0b5130';
  if (c >= 0) return '#052417';
  if (c > -1) return '#561c22';
  if (c > -2) return '#812a32';
  return '#e24654';
}

/** What price and OI did together, in the recording's green and red. */
export function buildUp(c: number | null, oc: number | null): { label: string; tone: string } | null {
  if (c === null || oc === null) return null;
  if (oc === 0) return { label: 'Unchanged', tone: '#262626' };
  if (c >= 0) return oc >= 0 ? { label: 'Long build-up', tone: '#108e4d' } : { label: 'Short covering', tone: '#0b5130' };
  return oc >= 0 ? { label: 'Short build-up', tone: '#e24654' } : { label: 'Long unwinding', tone: '#812a32' };
}

const pct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const rupees = (v: number) => '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Tile({ r, view }: { r: Row; view: 'Price' | 'OI' }) {
  const b = view === 'OI' ? buildUp(r.c, r.oc) : null;
  const tone = view === 'OI' ? (b ? b.tone : '#262626') : priceTone(r.c);
  const line2 = view === 'OI' ? pct(r.oc) : pct(r.c);
  const line3 = view === 'OI' ? (b ? b.label : '') : rupees(r.p);
  // The three lines sit where the recording has them: the stock's capitals
  // 20.3 from the top, the change's figures 66, the price's 89.
  return (
    <div data-heatmap-tile={r.s} className="relative h-[119px] text-white text-center" style={{ background: tone }}>
      <div className="absolute inset-x-1 top-[16.4px] text-[12px] leading-4 font-bold truncate">{r.s}</div>
      <div className="absolute inset-x-1 top-[60.7px] text-[14px] leading-5 font-semibold whitespace-nowrap">{line2}</div>
      <div className="absolute inset-x-1 top-[83.7px] text-[14px] leading-5 font-semibold whitespace-nowrap">{line3}</div>
    </div>
  );
}

function ExpirySheet({ expiries, chosen, onPick, onClose, title = 'Expiry', label = expiryLabel }: { expiries: readonly string[]; chosen: string | null; onPick: (e: string) => void; onClose: () => void; /** The same sheet lists the indices or sectors (18 Nov 2026). */ title?: string; label?: (k: string) => string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div data-heatmap-sheet="" className="fixed inset-0 z-[200] text-left">
      <div className="absolute inset-0 bg-black/80" aria-hidden="true" onClick={onClose} />
      {/* #161616, 24 round at the top; "Expiry" 16px, its capitals 21.3 down;
          the × 8.7 square, 19.7 in from the right; the expiries in 42-tall
          boxes with a 1pt #222 edge, the first 53.7 down, 16 apart; the
          chosen one white with a blue tick, the rest grey. */}
      <div role="dialog" aria-label={title}
        className="heatmap-sheet absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto rounded-t-[24px] bg-[#161616] pt-[53.7px] pb-[calc(67.7px+env(safe-area-inset-bottom))] md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-[430px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-[24px] md:pb-6">
        <div className="absolute left-4 top-[15.4px] text-[16px] leading-6 font-semibold text-[#ebebeb]">{title}</div>
        <button type="button" aria-label="Close" onClick={() => onClose()}
          className="absolute right-[14px] top-[17px] h-5 w-5 flex items-center justify-center text-[#e6e6e6]">
          <svg width="8.7" height="8.7" viewBox="0 0 8.7 8.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M0.75 0.75 7.95 7.95M7.95 0.75 0.75 7.95" />
          </svg>
        </button>
        <div className="mx-4 flex flex-col gap-4">
          {expiries.map((e) => (
            <button key={e} type="button" data-heatmap-option={e} aria-pressed={e === chosen}
              onClick={() => onPick(e)}
              className={`h-[42px] rounded-[12px] border border-[#222222] pl-3 pr-[14.3px] flex items-center justify-between text-[12px] font-medium active:bg-white/[0.04] ${e === chosen ? 'text-[#e8e8e8]' : 'text-[#b5b5b5]'}`}>
              <span className="relative top-px">{label(e)}</span>
              {e === chosen && (
                <svg width="11.3" height="9.3" viewBox="0 0 11.3 9.3" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M0.75 4.9 4 8.2 10.55 0.75" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FuturesHeatmap() {
  const [mode, setMode] = useState<'Index' | 'Sector'>('Index');
  const [chip, setChip] = useState<string>(INDEX_CHIPS[0]);
  const [view, setView] = useState<'Price' | 'OI'>('Price');
  const [asked, setAsked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [groupSheet, setGroupSheet] = useState(false);

  const { data, isError } = useQuery<Payload>({
    queryKey: ['futures-heatmap', asked || 'nearest'],
    queryFn: async () => (await axios.get('/api/futures-heatmap', { params: asked ? { expiry: asked } : {} })).data,
    refetchInterval: () => (marketOpen() ? 5000 : 60000),
    staleTime: 4000,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => {
    if (!data || !data.ok) return [];
    const groups = mode === 'Index' ? data.index : data.sector;
    const g = groups.find((x) => x.name === chip);
    const keep = new Set(g ? g.symbols : []);
    const key = (r: Row) => (view === 'OI' ? r.oc : r.c);
    return data.rows.filter((r) => keep.has(r.s)).sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
      return y - x;
    });
  }, [data, mode, chip, view]);

  const expiry = data?.expiry || asked;
  const chips = mode === 'Index' ? INDEX_CHIPS : SECTOR_CHIPS;

  return (
    // tracking-normal: the home page sets its letters a little apart
    // (tracking-wide); the recording's are at the face's own spacing.
    <section data-heatmap="" className="pt-2 tracking-normal">
      <h2 className="text-center text-[18px] leading-6 font-bold text-white">Futures Heatmap</h2>
      {/* ONE LINE: Index ⇕ · the index (a list) · the expiry · Price ⇕ (18 Nov
          2026). Martin, with a picture of the two rows: "Change the indices
          shown separately in a horizontal line to a list and bring all the
          options in one single line including the Expiry and price/OI option
          below". The chips are gone; the chosen index or sector stands in a
          pill that opens the same sheet the expiry's does. Pills 34 tall, as
          measured for the expiry's; a long name is cut short in its pill. */}
      <div className="mt-5 flex items-center gap-2">
        <button type="button" data-chipbar-toggle={mode}
          onClick={() => {
            const next = mode === 'Index' ? 'Sector' : 'Index';
            setMode(next);
            setChip(next === 'Index' ? INDEX_CHIPS[0] : SECTOR_CHIPS[0]);
          }}
          className="shrink-0 h-[34px] rounded-full border border-primary pl-3 pr-[13px] flex items-center gap-[7px] text-[12px] font-semibold text-white whitespace-nowrap active:bg-white/10">
          {mode}
          <UpDownArrows />
        </button>
        <button type="button" data-heatmap-group={chip} onClick={() => setGroupSheet(true)} className="h-[34px] min-w-0 rounded-full border border-primary bg-[#191919] px-3 flex items-center gap-[5px] text-[12px] font-medium text-white whitespace-nowrap active:bg-white/10">
          <span className="relative top-px truncate">{chip}</span>
          <svg width="10" height="5.3" viewBox="0 0 10 5.3" className="relative -top-[0.8px] shrink-0" aria-hidden="true"><path d="M0 0H10L5 5.3Z" fill="currentColor" /></svg>
        </button>
        <button type="button" data-heatmap-expiry={expiry || ''} disabled={!data?.expiries?.length}
          onClick={() => setSheet(true)} className="shrink-0 h-[34px] min-w-0 rounded-full border border-primary bg-[#191919] px-3 flex items-center gap-[5px] text-[12px] font-medium text-white whitespace-nowrap active:bg-white/10">
          <span className="relative top-px">{expiry ? expiryLabel(expiry) : 'Expiry'}</span>
          <svg width="10" height="5.3" viewBox="0 0 10 5.3" className="relative -top-[0.8px] shrink-0" aria-hidden="true"><path d="M0 0H10L5 5.3Z" fill="currentColor" /></svg>
        </button>
        <button type="button" data-heatmap-view={view} onClick={() => setView(view === 'Price' ? 'OI' : 'Price')}
          className="shrink-0 ml-auto h-[34px] flex items-center gap-[7px] pl-1 mr-[1.9px] text-[12px] font-semibold text-white">
          {view}
          <UpDownArrows scale={0.85} />
        </button>
      </div>
      <div className="mt-4">
        {data && !data.ok ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{data.error || 'Futures heatmap unavailable'}</p>
        ) : isError && !data ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Futures heatmap unavailable</p>
        ) : data && !rows.length ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No futures in {chip}</p>
        ) : (
          // Three a row and edge to edge on a phone, as recorded; more a row on
          // wider screens. The 1pt lines between are the page showing through.
          <div className="-mx-4 md:mx-0 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-px">
            {data
              ? rows.map((r) => <Tile key={r.s} r={r} view={view} />)
              : Array.from({ length: 9 }, (_, i) => <div key={i} className="h-[119px] bg-white/[0.04] animate-pulse" />)}
          </div>
        )}
      </div>
      {sheet && data?.expiries?.length ? createPortal(
        <ExpirySheet expiries={data.expiries} chosen={expiry}
          onPick={(e) => { setAsked(e); setSheet(false); }}
          onClose={() => setSheet(false)} />, document.body) : null}
      {groupSheet ? createPortal(
        <ExpirySheet title={mode} label={(k) => k} expiries={chips as readonly string[]} chosen={chip}
          onPick={(c) => { setChip(c); setGroupSheet(false); }}
          onClose={() => setGroupSheet(false)} />, document.body) : null}
    </section>
  );
}
