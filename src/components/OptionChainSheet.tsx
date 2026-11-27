import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { lockPageScroll } from '../lib/scrollLock';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { navigate } from 'wouter/use-browser-location';
import { ChevronsUpDown, LineChart, ShoppingBasket, X } from 'lucide-react';
import { toast } from 'sonner';
import { addWsMessageListener } from '../hooks/useWebSocket';
import { optionGreeks, yearsToExpiry, type Greeks } from '../lib/optionGreeks';
import { jodiBasket, useJodiBasket, basketFull } from '../lib/jodiBasket';

// THE OPTION CHAIN IS LEMONN'S (17 Nov 2026). Martin: "I also want to completely
// redesign the option chain screen same as in the lemon app. So remove the
// option chain screen already present in my app completely and redesign it as
// shown in the videos with the Greeks button and horizontal inward scrolling
// when Greeks are enabled. I also want the option strike chart to open/selected
// for scalp pro when I tap in the strike price in the option chain."
// Everything below is measured off his recording of Lemonn's chain (1290 x 2796,
// three pixels to the point):
//   - a sheet that comes up over what is on screen, from 152pt down;
//   - a row of controls 54pt tall — All, the expiry, and the Greeks switch in
//     an outlined pill at the right;
//   - a line of four facts 36pt tall: the trend, PCR, Max Pain, ATM IV;
//   - the table: Strike is a column 88pt wide down the middle, a shade lighter
//     than the rest, and never moves. Rows are 54pt. With Greeks off each side
//     is one column, the price with its change on the day under it. With
//     Greeks on each side is eight columns of half the width — LTP, OI, IV,
//     Delta, Gamma, Vega, Theta, Rho, counting outward from the Strike — two of
//     them in view, and the two sides slide TOWARDS each other under the Strike
//     as a finger drags either of them: "inward";
//   - cells in the money are a shade of blue; a thin bar along the foot of each
//     row, out from the Strike, is that strike's open interest against the
//     largest on its side (calls red, puts green); the strike everyone is
//     hurt most at carries "Max Pain", the strikes with most put and call open
//     interest "OI Support" and "OI Resistance";
//   - between the last strike under the index and the first above it, a white
//     pill with the index and its change on the day.
// The broker gives prices and open interest; the implied volatility and the
// Greeks are worked out here, by the model Lemonn's own figures fit (see
// lib/optionGreeks).
// A TAP ON A PRICE OPENS THAT OPTION IN SCALPPRO: anything on the call side of
// a row is its Call, anything on the put side its Put. The strike itself opens
// the one that is out of the money — the Call above the index, the Put below.

const STRIKE_W = 88, ROW_H = 54, SPOT_H = 43;
// THE DESKTOP'S CHAIN (18 Nov 2026). Martin: "option chain is missing in the
// desktop version. Re work the option chain ... in the desktop version to fit
// the desktop screen. Option chain does not need the Greeks button in desktop.
// Show it with the Greeks". On a screen 1,024px wide or more the sheet fills
// the screen bar a margin, and every column is in view at once — the eight of
// each side, counting outward from the Strike, as the phone shows them two at
// a time — so there is no Greeks switch, no "All" jump list and nothing to
// slide. Rows are a little shorter (more strikes in view), the Strike column a
// little wider (its tags), and the index is named, since nothing else on the
// sheet says which chain it is. A phone, even held sideways, is not this wide
// and keeps the sheet exactly as it was.
export const WIDE_CHAIN_QUERY = '(min-width: 1024px)';
const WIDE = { strikeW: 104, rowH: 46, spotH: 40, minCol: 58 };
const GREEN = '#2EA068', RED = '#E24556', BLUE = 'var(--primary)', TREND_BLUE = 'var(--primary)';
const SIDE_COLS = ['ltp', 'oi', 'iv', 'delta', 'gamma', 'vega', 'theta', 'rho'] as const;
type Col = typeof SIDE_COLS[number];
const HEAD: Record<Col, [string, string]> = {
  ltp: ['Call LTP', 'Put LTP'], oi: ['Call OI', 'Put OI'], iv: ['IV', 'IV'], delta: ['Call Delta', 'Put Delta'],
  gamma: ['Gamma', 'Gamma'], vega: ['Vega', 'Vega'], theta: ['Theta', 'Theta'], rho: ['Rho', 'Rho'],
};
const JUMPS: [string, number][] = [['All', 0], ['IV', 2], ['Delta', 3], ['Gamma', 4], ['Vega', 5], ['Theta', 6], ['Rho', 6]];

type Leg = { strikePrice: number; ltp: number; chgLtp?: number | null; oi?: number | null; chgOi?: number | null; tradingsymbol?: string; instrument_token?: string | number; lot_size?: number; exchange?: string; expiry?: string };
type Chain = { spot: number; spotToken?: number | string; strikes: number[]; ceData: Record<string, Leg>; peData: Record<string, Leg>; expiryDate: string; expiries: string[]; analytics?: any };
type Cell = { main: string; sub?: string; tone?: 'up' | 'down' };

const inr = (v: number) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctText = (v: number) => `${Math.abs(v).toFixed(2)}%`;
/** Open interest, which the server gives in lakhs. */
const oiText = (lakh: number) => (lakh >= 100 ? `${(lakh / 100).toFixed(1)}Cr` : lakh >= 1 ? `${lakh.toFixed(1)}L` : `${(lakh * 100).toFixed(1)}K`);
const expiryText = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  return m ? `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]}` : '—';
};

function cellOf(col: Col, leg: Leg | undefined, ltp: number, g: Greeks | null): Cell {
  if (!leg) return { main: '—' };
  if (col === 'ltp') {
    if (!(ltp > 0)) return { main: '—' };
    const prev = Number(leg.ltp) - (Number(leg.chgLtp) || 0);            // yesterday's close: from the quote as it was read, whatever has ticked since
    const chg = prev > 0 ? ((ltp - prev) / prev) * 100 : NaN;
    return { main: inr(ltp), sub: Number.isFinite(chg) ? pctText(chg) : undefined, tone: chg < 0 ? 'down' : 'up' };
  }
  if (col === 'oi') {
    const oi = Number(leg.oi);
    if (!(oi > 0)) return { main: '—' };
    const prev = oi - (Number(leg.chgOi) || 0);
    const chg = leg.chgOi !== null && leg.chgOi !== undefined && prev > 0 ? (Number(leg.chgOi) / prev) * 100 : NaN;
    return { main: oiText(oi), sub: Number.isFinite(chg) ? pctText(chg) : undefined, tone: chg < 0 ? 'down' : 'up' };
  }
  if (!g) return { main: '—' };
  return { main: col === 'iv' ? g.iv.toFixed(2) : g[col].toFixed(4) };
}

/**
 * WHAT THE SHEET OPENS ON (17 Nov 2026): an index and an expiry (YYYY-MM-DD),
 * either left out. ScalpPro's names open it: the index's name on that index,
 * the option's name on the option's own index and expiry, so the strikes he
 * sees beside it are the ones he can swap it for. Left out, the index is the
 * chart's and the expiry the nearest, as before.
 */
export interface ChainStart { underlying?: string; expiry?: string;
  /** Opened to pick a Jodi's two options (Strategy > Jodi): the basket starts on. See lib/jodiBasket. */
  basket?: boolean }

// `token` is the index's own, for its daily candles when the chain does not say which it is.
const underlyingOf = (asked?: string): { symbol: string | null; ta: string; name: string; token: number } => {
  let u = String(asked || '').toUpperCase();
  if (u !== 'NIFTY' && u !== 'BANKNIFTY' && u !== 'NIFTY BANK' && u !== 'SENSEX') u = '';
  if (!u) try { u = String(localStorage.getItem('chartUnderlying') || '').toUpperCase(); } catch (e) {}
  if (u === 'SENSEX') return { symbol: 'SENSEX', ta: 'BSE:SENSEX', name: 'SENSEX', token: 265 };
  if (u === 'BANKNIFTY' || u === 'NIFTY BANK') return { symbol: 'NIFTY BANK', ta: 'NSE:NIFTY BANK', name: 'BANKNIFTY', token: 260105 };
  return { symbol: null, ta: 'NSE:NIFTY 50', name: 'NIFTY', token: 256265 };
};

/** Hands an option to ScalpPro: written to the session first (a chart mounting later starts from it), then announced. */
export function openInScalpPro(leg: Leg, type: 'CE' | 'PE', name: string) {
  if (!leg?.tradingsymbol || !leg?.instrument_token) return false;
  const instr = {
    tradingsymbol: leg.tradingsymbol, instrument_token: String(leg.instrument_token), exchange: leg.exchange || 'NFO',
    lot_size: leg.lot_size, instrument_type: type, strike: leg.strikePrice, expiry: leg.expiry, name,
  };
  // On a desktop there is no ScalperX (ChartWorkspace shows the two halves at
  // 768px and wider): the option opens in the split view's option half, and
  // ScalperX's flag is not left set behind it.
  let desk = false;
  try { desk = window.matchMedia('(min-width: 768px)').matches; } catch (e) {}
  // ON THE PHONE, OUTSIDE SCALPERX, IT IS ADDED TO THE CHART PAGE'S LIST ONLY
  // (22 Nov 2026). Martin: "I want the options to be just added to list in the
  // chart screen instead of opening in Split View. In the scalperX let it open
  // in Split View as well as add to list." So ScalperX is not opened and the
  // chart on screen is not changed: the contract goes on the session's list
  // (read by a chart page that mounts later) and is announced to the one that
  // is up (see AN OPTION PICKED IN THE CHAIN JOINS THIS LIST in AdvancedChart).
  // With ScalperX already open it opens there, as before. The desktop is as it was.
  let inScalp = false;
  try { inScalp = sessionStorage.getItem('scalpPro') === '1'; } catch (e) {}
  if (!desk && !inScalp) {
    const entry = { tradingsymbol: instr.tradingsymbol, instrument_token: instr.instrument_token, exchange: instr.exchange, ...(instr.lot_size ? { lot_size: instr.lot_size } : {}) };
    try {
      const raw = JSON.parse(sessionStorage.getItem('openOptionCharts') || '[]');
      const list = Array.isArray(raw) ? raw : [];
      if (!list.some((c: any) => c?.tradingsymbol === entry.tradingsymbol)) sessionStorage.setItem('openOptionCharts', JSON.stringify([...list, entry]));
    } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('terminal:add-option', { detail: entry })); } catch (e) {}
    try { toast(`${name} ${leg.strikePrice} ${type} added to the chart's options`, { duration: 2500 }); } catch (e) {}
    if (window.location.pathname !== '/advanced-chart') navigate('/advanced-chart');
    return true;
  }
  try { sessionStorage.setItem('selectedInstrument', JSON.stringify(instr)); if (!desk) sessionStorage.setItem('scalpPro', '1'); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('terminal:open-option', { detail: instr })); } catch (e) {}
  if (!desk) try { window.dispatchEvent(new CustomEvent('terminal:scalp', { detail: true })); } catch (e) {}
  if (window.location.pathname !== '/advanced-chart') navigate('/advanced-chart');
  return true;
}

export function OptionChainView({ onPicked, start, wide = false, onClose }: { onPicked?: () => void; start?: ChainStart; wide?: boolean; onClose?: () => void }) {
  const under = useMemo(() => underlyingOf(start?.underlying), []);
  const strikeW = wide ? WIDE.strikeW : STRIKE_W, rowH = wide ? WIDE.rowH : ROW_H, spotH = wide ? WIDE.spotH : SPOT_H;
  // An expiry the server no longer lists (an option kept past its day) is not
  // an error: the server answers with the nearest, and the menu shows that.
  const [expiry, setExpiry] = useState<string>(() => (/^\d{4}-\d{2}-\d{2}/.test(String(start?.expiry || '')) ? String(start?.expiry).slice(0, 10) : ''));
  const [greeks, setGreeks] = useState<boolean>(() => { try { return localStorage.getItem('chainGreeks') === '1'; } catch (e) { return false; } });
  useEffect(() => { try { localStorage.setItem('chainGreeks', greeks ? '1' : '0'); } catch (e) {} }, [greeks]);
  const [menu, setMenu] = useState<null | 'expiry' | 'all'>(null);

  const { data: chain } = useQuery<Chain>({
    queryKey: ['option-chain-sheet', under.symbol, expiry],
    queryFn: async () => {
      const p = new URLSearchParams({ withAnalytics: '1' });
      if (under.symbol) p.set('symbol', under.symbol);
      if (expiry) p.set('expiry', expiry);
      const r = await fetch(`/api/option-chain?${p.toString()}`);
      if (!r.ok) throw new Error('chain unavailable');
      return r.json();
    },
    refetchInterval: 5000,
  });
  // The index's close of the day before, for the change in the pill: the daily candles the chart itself uses.
  const { data: prevClose } = useQuery<number | null>({
    queryKey: ['option-chain-prev-close', under.ta],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const r = await fetch(`/api/ta?timeframe=1440&token=${under.token}&symbol=${encodeURIComponent(under.ta)}`);
      if (!r.ok) return null;
      const cs: any[] = (await r.json())?.candles || [];
      if (cs.length < 2) return null;
      // The newest daily candle is today's once today has traded, and the one
      // before it is then the close the change is measured from. Only in the
      // first minutes of a session, with today's candle not yet in the daily
      // series, is the newest one itself that close.
      const secs = (t: any) => (typeof t === 'number' ? (t > 1e12 ? t / 1000 : t) : Date.parse(String(t)) / 1000);
      const istDay = (s: number) => Math.floor((s + 19800) / 86400);
      const now = Date.now() / 1000, mins = Math.floor(((now + 19800) % 86400) / 60);
      const last = cs[cs.length - 1];
      const inSession = mins >= 9 * 60 && mins <= 15 * 60 + 30;
      const prev = istDay(secs(last.time)) < istDay(now) && inSession ? last : cs[cs.length - 2];
      return Number(prev?.close) || null;
    },
  });

  // Prices that tick between two reads of the chain.
  const ticks = useRef(new Map<string, number>());
  const [, setTickN] = useState(0);
  useEffect(() => {
    let due = false;
    const unsub = addWsMessageListener((msg: any) => {
      if (!msg || msg.type !== 'optionTick' || msg.token == null || !(Number(msg.ltp) > 0)) return;
      ticks.current.set(String(msg.token), Number(msg.ltp));
      if (!due) { due = true; setTimeout(() => { due = false; setTickN((n) => n + 1); }, 400); }
    });
    return () => { unsub(); };
  }, []);

  const strikes = useMemo(() => [...(chain?.strikes || [])].sort((a, b) => a - b), [chain?.strikes]);
  const spot = Number(chain?.spot) || 0;
  const below = strikes.filter((k) => k <= spot).length;           // rows above the pill
  const ltpOf = (leg?: Leg) => (leg ? (ticks.current.get(String(leg.instrument_token)) ?? Number(leg.ltp)) || 0 : 0);
  const years = chain?.expiryDate ? yearsToExpiry(chain.expiryDate, Date.now()) : NaN;
  const greeksOf = (leg: Leg | undefined, k: number, isCall: boolean) => (leg && spot > 0 && years > 0 ? optionGreeks(spot, k, years, ltpOf(leg), isCall) : null);

  const maxOi = useMemo(() => {
    let ce = 0, pe = 0;
    for (const k of strikes) { ce = Math.max(ce, Number(chain?.ceData?.[k]?.oi) || 0); pe = Math.max(pe, Number(chain?.peData?.[k]?.oi) || 0); }
    return { ce, pe };
  }, [chain, strikes]);
  const a = chain?.analytics || {};
  const tags = (k: number): [string, string][] => {
    const out: [string, string][] = [];
    if (Number(a.maxPain) === k) out.push(['Max Pain', BLUE]);
    if (Number(a.supportZone?.strikePrice) === k) out.push(['OI Support', GREEN]);
    if (Number(a.resistanceZone?.strikePrice) === k) out.push(['OI Resistance', RED]);
    return out;
  };
  const atmIv = (() => {
    if (!strikes.length || !(spot > 0)) return null;
    const atm = strikes.reduce((x, y) => (Math.abs(y - spot) < Math.abs(x - spot) ? y : x), strikes[0]);
    const c = greeksOf(chain?.ceData?.[atm], atm, true), p = greeksOf(chain?.peData?.[atm], atm, false);
    const vs = [c?.iv, p?.iv].filter((v): v is number => typeof v === 'number');
    return vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : null;
  })();
  const bias = String(a.marketBias || '');
  const trend = /bull/i.test(bias) ? { text: bias, color: GREEN } : /bear/i.test(bias) ? { text: bias, color: RED } : { text: bias || 'Sideways', color: TREND_BLUE };
  const dayChg = prevClose && spot > 0 ? ((spot - prevClose) / prevClose) * 100 : null;

  // ── the width, and the slide ──
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => setW(el.clientWidth);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sideW = Math.max(0, (w - strikeW) / 2);
  // Wide, every column is shown, whatever the phone's switch was last left at.
  const allCols = wide || greeks;
  const cols: Col[] = allCols ? [...SIDE_COLS] : ['ltp'];
  // Wide: an eighth of the side each, never narrower than a price needs — below
  // that the sides slide as the phone's do (a window only just 1,024 wide).
  const colW = wide ? Math.max(WIDE.minCol, sideW / SIDE_COLS.length) : greeks ? sideW / 2 : sideW;
  const maxSlide = Math.max(0, cols.length * colW - sideW);
  // How far the sides have slid inward, in px. Kept out of React while a finger
  // is on it: the four strips are moved directly, sixty times a second.
  const slide = useRef(0);
  const strips = useRef<{ callHead: HTMLDivElement | null; putHead: HTMLDivElement | null; callBody: HTMLDivElement | null; putBody: HTMLDivElement | null }>({ callHead: null, putHead: null, callBody: null, putBody: null });
  const place = (to: number, glide: boolean) => {
    const o = Math.min(maxSlide, Math.max(0, to));
    slide.current = o;
    const s = strips.current;
    for (const [el, x] of [[s.callHead, -(maxSlide - o)], [s.callBody, -(maxSlide - o)], [s.putHead, -o], [s.putBody, -o]] as [HTMLDivElement | null, number][]) {
      if (!el) continue;
      const at = x.toFixed(2);
      if (el.dataset.at === at) continue;                           // where it is, or on its way there: left alone
      el.dataset.at = at;
      el.style.transition = glide ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
      el.style.transform = `translate3d(${x}px, 0, 0)`;
    }
  };
  // Greeks switched, or the sheet a different width: back to the first two columns.
  useLayoutEffect(() => { place(0, false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [allCols, w]);
  // A strip that has only just been put on the page (the rows arrive after the
  // heading does) starts where the others are.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { place(slide.current, false); });

  const drag = useRef<{ x: number; y: number; from: number; side: 1 | -1; on: boolean; t: number; lastX: number; v: number } | null>(null);
  const dragged = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    if (!allCols || maxSlide <= 0 || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x > sideW && x < sideW + strikeW) return;                   // the Strike column does not slide
    drag.current = { x: e.clientX, y: e.clientY, from: slide.current, side: x <= sideW ? 1 : -1, on: false, t: e.timeStamp, lastX: e.clientX, v: 0 };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.on) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      d.on = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch (err) {}
    }
    const dt = Math.max(1, e.timeStamp - d.t);
    d.v = (e.clientX - d.lastX) / dt; d.t = e.timeStamp; d.lastX = e.clientX;
    place(d.from + d.side * dx, false);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.on) return;
    dragged.current = Date.now();
    // Comes to rest on a column; a flick carries it one further the way it was going.
    const flick = Math.abs(d.v) > 0.35 ? Math.sign(d.v) * d.side * 0.5 : 0;
    place(Math.round(slide.current / colW + flick) * colW, true);
  };

  // ── the rows, and where the list opens ──
  const listRef = useRef<HTMLDivElement | null>(null);
  const opened = useRef('');
  useLayoutEffect(() => {
    const el = listRef.current;
    const key = `${chain?.expiryDate || ''}`;
    if (!el || !strikes.length || opened.current === key) return;
    opened.current = key;
    el.scrollTop = Math.max(0, below * rowH + spotH / 2 - el.clientHeight / 2);
  }, [strikes.length, below, chain?.expiryDate]);
  const rowTop = (i: number) => i * rowH + (i >= below ? spotH : 0);
  const total = strikes.length * rowH + (strikes.length ? spotH : 0);

  // THE BASKET (27 Nov 2026; lib/jodiBasket has what he asked for). With it on,
  // a tap on a price puts that option on the Jodi list instead of opening its
  // chart — the chain stays open, and the foot of the sheet shows the list.
  const basket = useJodiBasket();
  const pick = (k: number, type: 'CE' | 'PE') => {
    if (Date.now() - dragged.current < 350) return;                 // the end of a slide is not a tap
    if (menu) return;                                               // a tap with a menu open only puts the menu away
    const leg = (type === 'CE' ? chain?.ceData : chain?.peData)?.[k];
    if (basket.on) {
      if (!leg?.tradingsymbol || !leg?.instrument_token) return;
      jodiBasket.tap({ type, tradingsymbol: leg.tradingsymbol, instrument_token: String(leg.instrument_token), exchange: leg.exchange || (under.name === 'SENSEX' ? 'BFO' : 'NFO'),
        lot_size: leg.lot_size, strike: k, expiry: leg.expiry || chain?.expiryDate, underlying: under.name, ltp: ltpOf(leg) });
      return;
    }
    if (leg && openInScalpPro(leg, type, under.name)) onPicked?.();
  };
  const inBasket = (k: number, put: boolean) => { const b = put ? basket.PE : basket.CE; return !!b && basket.on && b.strike === k && b.underlying === under.name && String(b.expiry || '').slice(0, 10) === String(chain?.expiryDate || '').slice(0, 10); };
  const basketLtp = (b: { instrument_token: string; ltp: number } | null) => (b ? (ticks.current.get(String(b.instrument_token)) ?? b.ltp) || 0 : 0);

  const headCell = (c: Col, put: boolean) => (
    <div key={c} className="shrink-0 flex items-center justify-center text-[12px] leading-none text-foreground/60 whitespace-nowrap" style={{ width: colW }}>{HEAD[c][put ? 1 : 0]}</div>
  );
  const bodyCell = (c: Col, cell: Cell) => (
    <div key={c} className={`shrink-0 flex flex-col items-center justify-center ${wide ? 'gap-[5px]' : 'gap-[6px]'} whitespace-nowrap`} style={{ width: colW, height: rowH }}>
      <span className={`${colW < 64 ? 'text-[11px]' : 'text-[12px]'} leading-none text-foreground/85 tabular-nums`}>{cell.main}</span>
      {cell.sub && <span className="text-[10px] leading-none tabular-nums" style={{ color: cell.tone === 'down' ? RED : GREEN }}>{cell.sub}</span>}
    </div>
  );
  const side = (put: boolean) => (
    <div className="relative overflow-hidden" style={{ width: sideW, height: total }}>
      {strikes.map((k, i) => {
        const leg = (put ? chain?.peData : chain?.ceData)?.[k];
        const itm = put ? k > spot : k < spot;
        const max = put ? maxOi.pe : maxOi.ce;
        const len = max > 0 ? Math.min(1, (Number(leg?.oi) || 0) / max) * sideW : 0;
        return (
          <div key={k} data-chain-cell={put ? 'pe' : 'ce'} data-in-basket={inBasket(k, put) ? '' : undefined} onClick={() => pick(k, put ? 'PE' : 'CE')}
            className={`absolute inset-x-0 border-b border-foreground/[0.07] ${inBasket(k, put) ? 'bg-primary/25 shadow-[inset_0_0_0_1.5px_var(--primary)]' : itm ? 'bg-primary/[0.08]' : ''} ${wide ? 'cursor-pointer hover:bg-foreground/[0.05]' : ''}`} style={{ top: rowTop(i), height: rowH }}>
            {len > 1 && <div className="absolute bottom-[-1px] h-[2px] rounded-full z-[1]" style={{ width: len, ...(put ? { left: 0, background: `linear-gradient(to right, ${GREEN}55, ${GREEN})` } : { right: 0, background: `linear-gradient(to left, ${RED}55, ${RED})` }) }} />}
          </div>
        );
      })}
      <div ref={(el) => { strips.current[put ? 'putBody' : 'callBody'] = el; }} className="absolute left-0 top-0 pointer-events-none will-change-transform" style={{ width: cols.length * colW }}>
        {strikes.map((k, i) => {
          const leg = (put ? chain?.peData : chain?.ceData)?.[k];
          const g = allCols ? greeksOf(leg, k, !put) : null;
          const ltp = ltpOf(leg);
          return (
            <div key={k} className="absolute left-0 flex" style={{ top: rowTop(i), height: rowH }}>
              {(put ? cols : [...cols].reverse()).map((c) => bodyCell(c, cellOf(c, leg, ltp, g)))}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div ref={boxRef} data-chain="" className="relative flex flex-col h-full min-h-0 bg-background text-foreground select-none" onClick={() => menu && setMenu(null)}>
      {/* controls */}
      <div className="shrink-0 h-[54px] flex items-center pl-4 pr-[17px] bg-card">
        {wide ? (
          <span data-chain="index" className="text-[14px] leading-none font-semibold">{under.name === 'BANKNIFTY' ? 'BANK NIFTY' : under.name === 'NIFTY' ? 'NIFTY 50' : under.name}<span className="ml-2 font-normal text-foreground/60">Option Chain</span></span>
        ) : (
          <button type="button" data-chain="all" disabled={!greeks} onClick={(e) => { e.stopPropagation(); setMenu(menu === 'all' ? null : 'all'); }}
            className={`flex items-center gap-1 text-[12px] leading-none ${greeks ? 'text-foreground/85' : 'text-foreground/45'}`}>
            All{greeks && <ChevronsUpDown size={11} strokeWidth={2.4} />}
          </button>
        )}
        <span className="mx-[10px] h-[18px] w-px bg-foreground/20" aria-hidden="true" />
        <button type="button" data-chain="expiry" onClick={(e) => { e.stopPropagation(); setMenu(menu === 'expiry' ? null : 'expiry'); }} className="flex items-center gap-1 text-[12px] leading-none">
          <span className="text-foreground/60">Expiry:</span><span className="font-semibold">{expiryText(chain?.expiryDate || '')}</span>
          <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M0 0h8L4 5z" fill="currentColor" /></svg>
        </button>
        {/* The basket button (27 Nov 2026): on, a tap on a price adds that option to the Jodi list. */}
        <button type="button" data-chain="basket" role="switch" aria-checked={basket.on} aria-label="Basket: add options to the Jodi list" title="Basket: add options to the Jodi list"
          onClick={(e) => { e.stopPropagation(); jodiBasket.toggle(); }}
          className={`ml-auto h-[29px] px-[9px] flex items-center gap-[5px] rounded-full border text-[12px] leading-none ${basket.on ? 'border-primary text-primary bg-primary/10' : 'border-foreground/20 text-foreground/70'}`}>
          <ShoppingBasket size={15} strokeWidth={2} />{basket.on && <span className="font-semibold tabular-nums">{(basket.CE ? 1 : 0) + (basket.PE ? 1 : 0)}/2</span>}
        </button>
        {wide ? (
          onClose && (
            <button type="button" data-chain="close" aria-label="Close the option chain" title="Close (Esc)" onClick={onClose}
              className="ml-3 h-8 w-8 flex items-center justify-center rounded-full text-foreground/70 hover:bg-foreground/10 hover:text-foreground">
              <X size={18} />
            </button>
          )
        ) : (
          <>
          <button type="button" data-chain="greeks" role="switch" aria-checked={greeks} onClick={() => setGreeks((v) => !v)}
            className="ml-[8px] h-[29px] pl-[9px] pr-[8px] flex items-center gap-[7px] rounded-full border border-foreground/20 text-[12px] leading-none text-foreground/70">
            Greeks
            <span className="relative h-3 w-[22px] rounded-full transition-colors" style={{ background: greeks ? BLUE : 'rgba(128,128,128,0.35)' }}>
              <span className="absolute top-[2px] h-2 w-2 rounded-full bg-white transition-[left]" style={{ left: greeks ? 12 : 2 }} />
            </span>
          </button>
          {/* A close button beside it (18 Nov 2026; Martin: "add a small close
              screen button beside the Greeks button on the extreme right"). A
              tap above the sheet still closes it too. */}
          {onClose && (
            <button type="button" data-chain="close" aria-label="Close the option chain" onClick={onClose}
              className="ml-[10px] -mr-[6px] h-[29px] w-[29px] flex items-center justify-center rounded-full border border-foreground/20 text-foreground/70 active:bg-foreground/10">
              <X size={15} />
            </button>
          )}
          </>
        )}
      </div>
      {menu && (
        <div data-chain-menu={menu} className="absolute z-20 top-[46px] max-h-[60%] overflow-y-auto rounded-xl border border-foreground/15 bg-card py-1 shadow-2xl" style={{ left: menu === 'all' ? 10 : wide ? 190 : 44 }} onClick={(e) => e.stopPropagation()}>
          {menu === 'expiry'
            ? (chain?.expiries || []).map((d) => (
              <button key={d} type="button" onClick={() => { setExpiry(d); setMenu(null); }} className={`block w-full px-4 h-9 text-left text-[13px] ${d.slice(0, 10) === (chain?.expiryDate || '').slice(0, 10) ? 'font-semibold text-foreground' : 'text-foreground/70'}`}>{expiryText(d)}</button>
            ))
            : JUMPS.map(([name, col]) => (
              <button key={name} type="button" onClick={() => { place(col * colW, true); setMenu(null); }} className="block w-full px-4 h-9 text-left text-[13px] text-foreground/80">{name}</button>
            ))}
        </div>
      )}
      {/* the four facts */}
      <div className="shrink-0 h-9 flex items-center gap-[9px] px-[14px] border-b border-foreground/15 text-[11px] leading-none whitespace-nowrap overflow-hidden">
        <span className="flex items-center gap-[6px] font-semibold" style={{ color: trend.color }}><LineChart size={15} strokeWidth={2.2} />{trend.text}</span>
        <span className="text-foreground/50">•</span>
        <span><span className="text-foreground/60">PCR: </span>{Number.isFinite(Number(a.pcr)) ? Number(a.pcr).toFixed(2) : '—'}</span>
        <span className="text-foreground/50">•</span>
        <span><span className="text-foreground/60">Max Pain: </span>{Number(a.maxPain) > 0 ? Number(a.maxPain).toFixed(2) : '—'}</span>
        <span className="text-foreground/50">•</span>
        <span><span className="text-foreground/60">ATM IV: </span>{atmIv !== null ? atmIv.toFixed(2) : '—'}</span>
      </div>
      {/* the table: only up and down is the browser's to scroll; sideways is the slide */}
      <div className="flex-1 min-h-0 flex flex-col" style={{ touchAction: 'pan-y' }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="shrink-0 h-10 flex border-b border-foreground/[0.07]">
          <div className="overflow-hidden" style={{ width: sideW }}><div ref={(el) => { strips.current.callHead = el; }} className="flex h-full will-change-transform" style={{ width: cols.length * colW }}>{[...cols].reverse().map((c) => headCell(c, false))}</div></div>
          <div className="shrink-0 flex items-center justify-center bg-card text-[12px] leading-none font-semibold" style={{ width: strikeW }}>Strike</div>
          <div className="overflow-hidden" style={{ width: sideW }}><div ref={(el) => { strips.current.putHead = el; }} className="flex h-full will-change-transform" style={{ width: cols.length * colW }}>{cols.map((c) => headCell(c, true))}</div></div>
        </div>
        {/* The list is a scroller of its own, so it must say for itself that only
            up and down is the browser's: what its parent says stops at it. */}
        <div ref={listRef} data-chain="list" className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ touchAction: 'pan-y' }}>
          {!strikes.length
            ? <div className="h-40 flex items-center justify-center text-[12px] text-foreground/50">Loading…</div>
            : (
              <div className="relative flex" style={{ height: total }}>
                {side(false)}
                <div className="relative shrink-0 bg-card" style={{ width: strikeW, height: total }}>
                  {strikes.map((k, i) => {
                    const t = tags(k);
                    return (
                      <div key={k} data-chain-strike={k} onClick={() => pick(k, k >= spot ? 'CE' : 'PE')}
                        className={`absolute inset-x-0 flex flex-col items-center justify-center gap-[5px] border-b border-foreground/[0.07] ${wide ? 'cursor-pointer hover:bg-foreground/[0.05]' : ''}`} style={{ top: rowTop(i), height: rowH }}>
                        <span className="text-[12px] leading-none font-semibold text-foreground/95 tabular-nums">{k.toLocaleString('en-IN')}</span>
                        {t.map(([name, color]) => <span key={name} className="px-[6px] h-[15px] flex items-center rounded-[4px] text-[10px] leading-none font-medium text-white whitespace-nowrap" style={{ background: color }}>{name}</span>)}
                      </div>
                    );
                  })}
                </div>
                {side(true)}
                {/* the index, between the strikes on either side of it */}
                <div className="absolute inset-x-0 pointer-events-none" style={{ top: below * rowH, height: spotH }}>
                  <div className="absolute inset-x-0 top-1/2 h-px bg-foreground/20" />
                  <div data-chain="spot" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-7 px-[9px] flex items-center gap-[6px] rounded-lg bg-foreground text-background text-[12px] leading-none font-semibold tabular-nums whitespace-nowrap">
                    {spot.toFixed(2)}
                    {dayChg !== null && (
                      <span className="flex items-center gap-[3px]" style={{ color: dayChg < 0 ? RED : GREEN }}>
                        <svg width="8" height="7" viewBox="0 0 8 7" aria-hidden="true" style={{ transform: dayChg < 0 ? 'rotate(180deg)' : undefined }}><path d="M4 0l4 7H0z" fill="currentColor" /></svg>
                        {pctText(dayChg)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
        </div>
      </div>
      {/* THE JODI LIST, while the basket is on: the two options picked, what they
          cost together now, and Done — which closes the chain, as its own cross
          does, and with a Call and a Put on the list that opens the Jodi card. */}
      {basket.on && (
        <div data-chain="basket-list" className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-foreground/15 bg-card pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <div className="flex-1 min-w-0">
            {!basket.CE && !basket.PE
              ? <div className="text-[12px] leading-snug text-foreground/60">Jodi list: tap one Call and one Put.</div>
              : (
                <>
                  <div className="flex flex-wrap items-center gap-[6px]">
                    {([basket.CE, basket.PE] as const).map((b) => b && (
                      <span key={b.type} data-basket-leg={b.type} className="h-[26px] pl-[9px] pr-[3px] flex items-center gap-[5px] rounded-full border border-primary/50 text-[12px] leading-none whitespace-nowrap">
                        <span className="font-semibold tabular-nums">{b.strike} {b.type}</span><span className="text-foreground/60 tabular-nums">{basketLtp(b) > 0 ? basketLtp(b).toFixed(2) : '—'}</span>
                        <button type="button" aria-label={`Remove ${b.strike} ${b.type} from the Jodi list`} onClick={(e) => { e.stopPropagation(); jodiBasket.remove(b.type); }} className="h-[22px] w-[22px] flex items-center justify-center rounded-full text-foreground/55 active:bg-foreground/10"><X size={13} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="mt-[5px] text-[11px] leading-none text-foreground/60">
                    {basketFull(basket)
                      ? <>Combined now <span data-basket="combined" className="font-semibold text-foreground tabular-nums">{(basketLtp(basket.CE) + basketLtp(basket.PE)).toFixed(2)}</span></>
                      : `Now tap one ${basket.CE ? 'Put' : 'Call'}.`}
                  </div>
                </>
              )}
          </div>
          <button type="button" data-basket="done" disabled={!basketFull(basket)} onClick={(e) => { e.stopPropagation(); onClose?.(); }}
            className={`shrink-0 h-9 px-4 rounded-full text-[13px] font-semibold ${basketFull(basket) ? 'bg-primary text-primary-foreground active:opacity-80' : 'bg-foreground/10 text-foreground/40'}`}>Done</button>
        </div>
      )}
    </div>
  );
}

function useWideChain() {
  const [wide, setWide] = useState(() => { try { return window.matchMedia(WIDE_CHAIN_QUERY).matches; } catch (e) { return false; } });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(WIDE_CHAIN_QUERY); } catch (e) { return; }
    const on = (e: MediaQueryListEvent) => setWide(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on as any);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on as any); };
  }, []);
  return wide;
}

/** The chain as a sheet over whatever is on screen; a tap above it, or a price picked, puts it away.
 *  On a desktop screen (WIDE_CHAIN_QUERY) it is the screen, bar a margin, with every column shown. */
export function OptionChainSheet({ onClose, start }: { onClose: () => void; start?: ChainStart }) {
  const wide = useWideChain();
  // THE PAGE BEHIND STAYS PUT (18 Nov 2026). Martin: "The screen behind the
  // option chain also scrolls behind. Disable it." A finger that reached the
  // end of the chain's list, or landed on the dimmed part, scrolled the chart
  // page under it. While the sheet is up the page does not scroll — the same
  // lock the Market Context sidebar uses.
  useEffect(() => {
    // The counted lock (see ONE LOCK, COUNTED in lib/scrollLock): it is let go, not "put back as it was".
    return lockPageScroll(true);
  }, []);
  // CLOSING: on a phone the sheet slides back down first and is taken away when
  // it has gone (see chain-sheet-down in index.css). Anywhere the slide does not
  // run — the desktop, a phone asking for reduced motion — it closes at once. A
  // strike picked from the chain closes at once too: the screen is changing
  // under it. The slide's own end is the close (onAnimationEnd), so the sheet is
  // never taken away part of the way down; the timer is for a slide that never
  // reports its end.
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<any>(null);
  const leave = () => {
    if (leaveTimer.current) return;
    let slide = false;
    try { slide = window.innerWidth < 768 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (!slide) { onClose(); return; }
    setLeaving(true);
    leaveTimer.current = setTimeout(onClose, 700);
  };
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') leaveRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // THE TOP STAYS IN USE ON THE PHONE'S CHART (18 Nov 2026). Martin, with the
  // chain open over the chart: "Show the top part which is dimmed so that option
  // chain can be changed for sensex and bank nifty from the same screen". The
  // sheet starts 152pt down and the dark layer covered the header above it — a
  // tap there closed the chain. On the chart page of a phone there is no dark
  // layer and nothing over the header: the index tab and its list work, and the
  // chain shows whichever index is chosen there (the chart announces it as
  // terminal:chart-underlying). The cross beside Greeks closes it. Anywhere
  // else — another page, the desktop — it is as it was: dimmed, a tap outside
  // closes.
  const [openTop] = useState(() => {
    try { return !wide && window.innerWidth < 768 && window.location.pathname === '/advanced-chart' && sessionStorage.getItem('scalpPro') !== '1'; } catch (e) { return false; }
  });
  const [follow, setFollow] = useState<ChainStart | undefined>(() => ({ ...start, underlying: underlyingOf(start?.underlying).name }));
  useEffect(() => {
    if (!openTop) return;
    const on = (e: any) => {
      const u = String(e?.detail || '').toUpperCase();
      if (u !== 'NIFTY' && u !== 'BANKNIFTY' && u !== 'SENSEX') return;
      // The expiry asked for was the first index's; the new one starts at its nearest.
      // Compared with what the sheet was ASKED for, never with underlyingOf() of
      // nothing: that reads the saved index, which the chart has just changed.
      setFollow((f) => (f?.underlying && underlyingOf(f.underlying).name === u ? f : { underlying: u }));
    };
    window.addEventListener('terminal:chart-underlying', on as any);
    return () => window.removeEventListener('terminal:chart-underlying', on as any);
  }, [openTop]);
  // The index list hangs from the header down over the sheet's first rows, so
  // while the chain is up it is lifted above the sheet (it is under it otherwise).
  useEffect(() => {
    if (!openTop) return;
    const st = document.createElement('style');
    st.textContent = '[data-index-menu]{z-index:160}';
    document.head.appendChild(st);
    return () => { try { st.remove(); } catch (e) {} };
  }, [openTop]);
  const shown = openTop ? follow : start;
  // SQUARE TOP CORNERS OVER THE CHART (18 Nov 2026). Martin, with dark wedges at
  // both top corners in the light theme: "Make the top corner edges of the
  // option chain card pointed instead of curved so that these dark areas around
  // the corners are fixed". The rounded corners left a little of what was behind
  // showing, and the sheet's dark upward shadow filled it. Over the chart the
  // sheet now meets the price line square, with no shadow; elsewhere (dimmed,
  // desktop) it keeps its rounded corners.
  // NO STRIP OF CHART BETWEEN THE PRICE AND THE SHEET (18 Nov 2026). Martin,
  // marking it in red: "There appears to be a small gap here ... Fill that up".
  // The sheet began 152pt down whatever was above it, and on his phone the price
  // line ends a few points higher: a sliver of the chart showed between them.
  // With the top in use the sheet begins where the price line ends, measured
  // (and again if the screen changes); the layer behind its rounded corners is
  // the price line's own colour.
  const [topPx, setTopPx] = useState<number | null>(null);
  useEffect(() => {
    if (!openTop) return;
    const read = () => {
      try {
        const el = document.querySelector('[data-layout="price"]') as HTMLElement | null;
        const b = el ? Math.round(el.getBoundingClientRect().bottom) : 0;
        setTopPx(b > 60 && b < window.innerHeight * 0.4 ? b : null);
      } catch (e) {}
    };
    read();
    const t = [150, 600].map((ms) => setTimeout(read, ms));
    window.addEventListener('resize', read);
    return () => { t.forEach(clearTimeout); window.removeEventListener('resize', read); };
  }, [openTop, follow]);
  return createPortal(
    <div data-chain-sheet={wide ? 'wide' : openTop ? 'open-top' : ''}
      className={openTop
        ? `${leaving ? 'chain-sheet-down' : 'chain-sheet-up'} fixed inset-x-0 bottom-0 z-[150] flex flex-col justify-end ${topPx != null ? 'bg-card' : ''}`
        : `${leaving ? 'chain-dim-out' : 'chain-dim-in'} fixed inset-0 z-[150] flex flex-col justify-end md:items-center md:justify-center bg-black/75`}
      style={openTop && topPx != null ? { top: topPx } : undefined}
      onAnimationEnd={(e) => { if (leaving && e.animationName === 'chain-sheet-down') onClose(); }}
      onClick={openTop ? undefined : leave}>
      <div style={openTop && topPx != null ? { height: '100%', minHeight: 0 } : undefined} className={wide
        ? 'w-[min(1600px,calc(100vw-48px))] h-[calc(100dvh-48px)] rounded-xl overflow-hidden border border-foreground/10'
        : `${openTop ? '' : leaving ? 'chain-sheet-down ' : 'chain-sheet-up '}w-full md:w-[430px] h-[calc(100dvh-152px)] min-h-[60dvh] md:h-[min(780px,90dvh)] ${openTop ? 'rounded-none' : 'rounded-t-xl'} md:rounded-xl overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <OptionChainView key={`${wide ? 'wide' : 'narrow'}|${underlyingOf(shown?.underlying).name}`} onPicked={onClose} start={shown} wide={wide} onClose={leave} />
      </div>
    </div>,
    document.body,
  );
}

/** Mounted once for the app: any screen opens the sheet by announcing terminal:option-chain, with a ChainStart as its detail or none. */
export function OptionChainHost() {
  const [open, setOpen] = useState<ChainStart | null>(null);
  useEffect(() => {
    const onOpen = (e: any) => {
      const d = e?.detail && typeof e.detail === 'object' ? { ...e.detail } : {};
      jodiBasket.open(d.basket === true);                 // the basket on only when asked for; the list always starts empty
      setOpen(d);
    };
    window.addEventListener('terminal:option-chain', onOpen as any);
    return () => window.removeEventListener('terminal:option-chain', onOpen as any);
  }, []);
  // CLOSED WITH A CALL AND A PUT ON THE LIST: the Jodi card opens (27 Nov 2026;
  // Martin: "Once the 2 are added and I close it, open a small card..."). By the
  // cross, by Done, by a tap outside — however it is closed. With fewer than
  // two, nothing follows and the list is forgotten.
  const close = () => {
    const b = jodiBasket.get();
    setOpen(null);
    if (b.on && b.CE && b.PE) { try { window.dispatchEvent(new CustomEvent('terminal:jodi-setup', { detail: { ce: b.CE, pe: b.PE } })); } catch (e) {} }
    jodiBasket.clear();
  };
  return open ? <OptionChainSheet start={open} onClose={close} /> : null;
}
