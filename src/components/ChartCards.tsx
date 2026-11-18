import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Zap } from 'lucide-react';
import { toast } from 'sonner';

/**
 * THE CARDS UNDER THE CHART (phone, 17 Nov 2026).
 *
 * Martin, with three screenshots of Lemonn's chart screen scrolled down: "I want
 * a vertical scrolling screen in the charts section which scrolls down to show
 * the things shown in the screenshot." Last on it, a list of the top traded
 * options "with all, put and call separated. Use the Zerodha volume data to
 * build this list. You can ignore the order history".
 *
 * So, under the chart and its row of five, in Lemonn's order:
 *   Your Positions      one row: today's P&L, opening the Trade Journal.
 *   Open Interest (OI)  put and call totals of the expiry, and their ratio.
 *   Daily Performance   the day's low and high of the chart on screen, with
 *                       where the last price stands between them.
 *   Top Options         the five most traded contracts of the expiry — all, calls
 *                       or puts — by the day's volume as Zerodha reports it.
 *
 * WHERE THE NUMBERS COME FROM. Nothing here asks the broker for anything the app
 * was not already asking for:
 *   - the option chain is GET /api/option-chain, the same answer the Option Chain
 *     page and the chart's OI bars use. Each contract in it carries Zerodha's
 *     `volume` (traded today), `ltp`, the day's change and `oi`, and the answer
 *     carries the open interest of EVERY strike of the expiry (`oiAll`).
 *     Zerodha has no "most traded" list of its own, so the list is that chain
 *     sorted by volume. The chain covers the strikes within 1,500 points of the
 *     index (NIFTY); the most traded contracts are always among them.
 *   - today's P&L is GET /api/positions-live, the figure the positions banner
 *     shows.
 *   - the day's low and high are read off the candles of the chart on screen
 *     (handed in as `getDay`), so they are that chart's — an option's on an
 *     option chart — and cost no request at all.
 * It asks only while some of it is on screen.
 *
 * THE LOOK IS MEASURED, not judged by eye: his screenshots are 1290px wide, a
 * 430pt phone at 3 pixels a point, and every size and distance below is a pixel
 * count off them divided by three (the text sizes by comparing each text's
 * width with Manrope's at whole sizes). Colours that carry meaning are Lemonn's
 * own; surfaces and text are the app's theme, so a light theme still works.
 */

type Day = { low: number; high: number; ltp: number };
type Leg = { tradingsymbol: string; instrument_token: number | string; ltp: number; chgLtp: number; volume: number; oi: number; strike: number; type: 'CE' | 'PE'; expiry: any; exchange?: string; lot_size?: number };

const RED = '#db3a4c', GREEN = '#5baa79', CHANGE_RED = '#e5505f', OI_GREEN = '#68a146', LIME = 'var(--primary)', BLUE = 'var(--primary)';
const inr = (v: number, dp = 2) => v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "17 Nov 26" from the expiry as the chain sends it (a date or an ISO string). */
const expiryLabel = (e: any): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof e === 'string' ? e : (() => { try { return new Date(e).toISOString(); } catch (err) { return ''; } })());
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}` : '';
};
/** Shares traded, short: 4,02,000 → "4.02L", 1,25,00,000 → "1.25Cr". */
const volLabel = (v: number): string => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v)));

/** A section's heading: Lemonn's 16px name (and, for the list, what it is ordered
 *  by), with the round "i" some of them carry at the right. `gap` is the room
 *  above it. The distances differ a little from one section to the next in
 *  Lemonn's screen, and they are his: each is set where it is used. */
function Heading({ children, sub, gap, onInfo, bright = false }: { children: React.ReactNode; sub?: string; gap: number; onInfo?: () => void; bright?: boolean }) {
  return (
    <div className="relative" style={{ paddingTop: gap }}>
      <div className="flex items-baseline gap-[6px] whitespace-nowrap">
        <h3 className={`text-[16px] leading-[20px] font-[650] ${bright ? 'text-foreground' : 'text-foreground/95'}`}>{children}</h3>
        {sub && <span className="text-[12px] leading-[20px] font-medium text-foreground/65">{sub}</span>}
      </div>
      {onInfo && (
        <button type="button" onClick={onInfo} aria-label="About this" className="absolute right-0 bottom-[-3.6px] h-[15.67px] w-[15.67px] rounded-full flex items-center justify-center bg-foreground/15 text-foreground/65 text-[10px] leading-none font-bold">i</button>
      )}
    </div>
  );
}
/** The lime stroke under the start of a heading: 40 x 2.33pt (a border, so the third of a point survives). */
const Accent = ({ gap }: { gap: number }) => <div className="w-[40px] h-0" style={{ marginTop: gap, borderTop: `2.33px solid ${LIME}` }} aria-hidden="true" />;
const Tri = ({ up, color, w = 8 }: { up: boolean; color: string; w?: number }) => (
  <svg width={w} height={w / 2} viewBox="0 0 8 4" aria-hidden="true" className="shrink-0" style={{ transform: up ? undefined : 'rotate(180deg)' }}><path d="M0 4 H8 L4 0 Z" fill={color} /></svg>
);

export function ChartCards({ chainSymbol, getDay, onOpenOption, onOpenPositions }: {
  /** The index whose options this chart's cards are about ('NIFTY 50', 'NIFTY BANK', 'SENSEX'); null where there are none (GIFT NIFTY and the other reference charts). */
  chainSymbol: string | null;
  /** The chart on screen: its latest session's low and high, and the last price. */
  getDay: () => Day | null;
  onOpenOption: (instr: any) => void;
  onOpenPositions: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // ON SCREEN? Everything below asks and repaints only while it is. At rest the
  // cards are under the fold, so a chart left open all day costs nothing here.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    // The foot of the screen is not "on screen": the fixed buttons and the app's
    // bottom bar cover it, and at rest the cards begin exactly there.
    const io = new IntersectionObserver((es) => setSeen(es.some((e) => e.isIntersecting)), { rootMargin: '0px 0px -130px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { data: pos } = useQuery({
    queryKey: ['chart-cards-positions'],
    queryFn: async () => { const r = await fetch('/api/positions-live'); if (!r.ok) throw new Error('positions'); return r.json(); },
    enabled: seen, refetchInterval: seen ? 5000 : false, staleTime: 4000, placeholderData: (p: any) => p,
  });
  const { data: chain } = useQuery({
    queryKey: ['chart-cards-chain', chainSymbol],
    queryFn: async () => { const r = await fetch(`/api/option-chain?symbol=${encodeURIComponent(chainSymbol || '')}`); if (!r.ok) throw new Error('chain'); return r.json(); },
    enabled: seen && !!chainSymbol, refetchInterval: seen ? 15000 : false, staleTime: 10000,
    // The last answer stands in while the next is fetched — but only the same
    // index's. Kept across a change of index, NIFTY's totals and top options
    // stood under SENSEX or BANK NIFTY until that index's chain arrived (18 Nov
    // 2026; Martin: "when I select Sensex or bank nifty, change the data
    // that's shown ... to that index which I have selected").
    placeholderData: (p: any, q: any) => (q?.queryKey?.[1] === chainSymbol ? p : undefined),
  });

  const [day, setDay] = useState<Day | null>(null);
  const getDayRef = useRef(getDay);
  getDayRef.current = getDay;
  // Once a second while it is on screen. Under the fold it is still read, every
  // five — not for anyone to see, but so that the card is already there when
  // the page is scrolled: a card that arrives as it comes into view pushes
  // everything under it down by its own height.
  useEffect(() => {
    const read = () => { try { const d = getDayRef.current(); setDay((p) => (p && d && p.low === d.low && p.high === d.high && p.ltp === d.ltp ? p : d)); } catch (e) {} };
    read();
    const iv = setInterval(read, seen ? 1000 : 5000);
    return () => clearInterval(iv);
  }, [seen]);

  // The chain's contracts as one list, and its open interest.
  const legs = useMemo<Leg[]>(() => {
    const out: Leg[] = [];
    const c: any = chain;
    if (!c || c.isMock) return out;
    for (const [side, type] of [[c.ceData, 'CE'], [c.peData, 'PE']] as const) {
      for (const k of Object.keys(side || {})) {
        const r = side[k];
        if (!r?.tradingsymbol || !(Number(r.ltp) >= 0)) continue;
        out.push({ tradingsymbol: r.tradingsymbol, instrument_token: r.instrument_token, ltp: Number(r.ltp) || 0, chgLtp: Number(r.chgLtp) || 0, volume: Number(r.volume) || 0, oi: Number(r.oi) || 0, strike: Number(r.strikePrice ?? r.strike ?? k), type, expiry: r.expiry ?? c.expiryDate, exchange: r.exchange, lot_size: r.lot_size });
      }
    }
    return out;
  }, [chain]);
  const oi = useMemo(() => {
    const c: any = chain;
    if (!c || c.isMock) return null;
    // Every strike of the expiry when the server has that; the strikes near the
    // money until it does (a few seconds after it starts).
    let ce = Number(c.oiAll?.ce), pe = Number(c.oiAll?.pe);
    if (!(ce > 0) || !(pe > 0)) { ce = 0; pe = 0; for (const l of legs) { if (l.type === 'CE') ce += l.oi; else pe += l.oi; } }
    if (!(ce > 0) || !(pe > 0)) return null;
    return { put: Math.round(pe * 100000), call: Math.round(ce * 100000), ratio: pe / ce };      // the chain counts in lakhs
  }, [chain, legs]);

  const [side, setSide] = useState<'ALL' | 'CE' | 'PE'>('ALL');
  const [metric, setMetric] = useState<'price' | 'volume'>('price');
  const top = useMemo(() => legs.filter((l) => l.volume > 0 && (side === 'ALL' || l.type === side)).sort((a, b) => b.volume - a.volume).slice(0, 5), [legs, side]);
  // "NIFTY" of "NIFTY26N1725200CE": what stands before the first digit.
  const rootName = (ts: string) => (/^[A-Z]+/.exec(ts)?.[0] || '');

  const pnl = Number(pos?.netPnl);
  const hasPnl = Number.isFinite(pnl);
  const dayFrac = day && day.high > day.low ? Math.max(0, Math.min(1, (day.ltp - day.low) / (day.high - day.low))) : null;

  return (
    <div ref={rootRef} data-layout="cards" className="md:hidden px-4 pb-[calc(4rem+env(safe-area-inset-bottom)+50px+28px)] bg-background text-foreground">
      {/* YOUR POSITIONS */}
      <Heading gap={21} bright>Your Positions</Heading>
      <button type="button" data-card="positions" onClick={onOpenPositions}
        className="mt-[16.8px] w-full h-[39.67px] rounded-[8px] bg-foreground/[0.08] pl-3 pr-[17px] flex items-center text-left active:bg-foreground/[0.12]">
        {/* A calendar leaf with a star, as Lemonn marks "today". */}
        <svg width="15.33" height="15.67" viewBox="0 0 46 47" aria-hidden="true" className="shrink-0 text-foreground/65">
          <rect x="1" y="6" width="44" height="40" rx="9" fill="currentColor" />
          <rect x="11" y="0" width="6" height="12" rx="3" fill="currentColor" />
          <rect x="29" y="0" width="6" height="12" rx="3" fill="currentColor" />
          <path d="M23 15.5l3.4 7 7.6 1-5.6 5.3 1.4 7.6-6.8-3.7-6.8 3.7 1.4-7.6-5.6-5.3 7.6-1z" className="fill-background" opacity="0.72" />
        </svg>
        <span className="ml-[8.3px] text-[12px] leading-4 font-[650] text-foreground">Today’s Positions</span>
        <span data-card="positions-pnl" className="ml-auto text-[12px] leading-4 font-semibold text-foreground/95" style={{ color: hasPnl && pnl !== 0 ? (pnl < 0 ? RED : GREEN) : undefined }}>
          {hasPnl ? `${pnl < 0 ? '-' : pnl > 0 ? '+' : ''}₹${inr(Math.abs(pnl))}` : '—'}
        </span>
        <ChevronRight size={15} strokeWidth={2.4} className="ml-[5px] -mr-[4.5px] shrink-0 text-foreground" />
      </button>

      {chainSymbol && (
        <>
          {/* OPEN INTEREST */}
          <Heading gap={25.3} onInfo={() => toast.info('Open interest of every strike of this expiry', { id: 'cards-info' })}>Open Interest (OI)</Heading>
          <Accent gap={9} />
          <div data-card="oi" className="mt-3 rounded-[8px] bg-foreground/[0.08] px-4 pt-[16px] pb-[15.67px]">
            <div className="flex justify-between text-[12px] leading-4 font-semibold text-foreground/65"><span>Total Put OI</span><span>Total Call OI</span></div>
            <div className="mt-1 flex justify-between text-[12px] leading-4 font-semibold text-foreground/95">
              <span data-oi="put" style={{ color: oi ? OI_GREEN : undefined }}>{oi ? oi.put.toLocaleString('en-IN') : '—'}</span>
              <span data-oi="call" style={{ color: oi ? RED : undefined }}>{oi ? oi.call.toLocaleString('en-IN') : '—'}</span>
            </div>
            {/* CALLS ARE RED AND PUTS ARE GREEN, AS ON HOME (17 Nov 2026). Martin:
                "Show the CE Open Interest in red like in the homepage." Lemonn's
                card, which this one was measured from, has them the other way
                round — red for puts, green for calls — and so did this until
                then: the same two totals were red on one page of the app and
                green on the next. Home's is the convention he reads the chain
                by (calls written overhead, puts written underneath), so it is
                the one both pages now use: each figure is in its own colour,
                and so is its end of the bar. The sides did not move — puts on
                the left, calls on the right, as the labels above them say.
                The knob is where one ends and the other begins. Lemonn's own
                bar stood at exactly half with a ratio of 0.94; this one is
                drawn to the figures, which is the same picture near 1 and says
                something away from it. */}
            <div className="relative mt-[7.67px] h-[8.33px]">
              <div className="absolute inset-0 rounded-full overflow-hidden flex">
                <div data-oi="put-bar" style={{ width: `${(oi ? oi.put / (oi.put + oi.call) : 0.5) * 100}%`, background: OI_GREEN }} />
                <div data-oi="call-bar" className="flex-1" style={{ background: RED }} />
              </div>
              <div data-oi="knob" className="absolute top-1/2 h-[16.33px] w-[3.33px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground dark:bg-white" style={{ left: `${(oi ? oi.put / (oi.put + oi.call) : 0.5) * 100}%` }} />
            </div>
            <div className="mt-[8px] flex justify-between text-[12px] leading-4">
              <span className="font-semibold text-foreground/65">Put : Call Ratio</span>
              <span data-oi="ratio" className="font-medium text-foreground/95">{oi ? oi.ratio.toFixed(2) : '—'}</span>
            </div>
          </div>
        </>
      )}

      {/* DAILY PERFORMANCE */}
      {day && (
        <>
          <Heading gap={chainSymbol ? 34 : 26.6} onInfo={() => toast.info('Today’s low and high, and the last price between them', { id: 'cards-info' })}>Daily Performance</Heading>
          <Accent gap={8} />
          <div data-card="day" className="mt-3 rounded-[8px] bg-foreground/[0.08] px-4 pt-[16.33px] pb-[15.67px]">
            <div className="flex justify-between text-[12px] leading-4 font-semibold text-foreground/65"><span>1D Low</span><span>1D High</span></div>
            <div className="-mt-[0.33px] flex justify-between text-[12px] leading-4 font-semibold text-foreground/95">
              <span data-day="low">{inr(day.low)}</span><span data-day="high">{inr(day.high)}</span>
            </div>
            <div className="relative mt-[11.83px] h-[8.33px]">
              <div className="absolute inset-0 rounded-full" style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--primary) 70%, #ffffff), color-mix(in srgb, var(--primary) 70%, #000000))' }} />
              <div className="absolute left-1/2 top-0 h-full w-[0.67px] -translate-x-1/2 bg-white" />
              {dayFrac !== null && (
                <Zap data-day="bolt" size={19} strokeWidth={0} fill="#fff" className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 drop-shadow-[0_0_1px_rgba(0,0,0,0.55)] dark:drop-shadow-none" style={{ left: `${dayFrac * 100}%` }} />
              )}
            </div>
            <div className="mt-[23.83px] flex items-center text-[12px] leading-4 font-semibold whitespace-nowrap">
              <Zap size={14} strokeWidth={0} fill="currentColor" className="shrink-0 text-foreground" />
              <span className="ml-[6px] text-foreground/65">Last Traded Price:</span>
              <span data-day="ltp" className="ml-[6px] text-foreground/95">₹{inr(day.ltp)}</span>
            </div>
          </div>
        </>
      )}

      {/* TOP OPTIONS */}
      {chainSymbol && (
        <>
          <Heading gap={33} sub="(By Trade Volume)">Top Options</Heading>
          <Accent gap={7} />
          <div className="mt-3 flex items-center gap-[3.5px]">
            {(['ALL', 'CE', 'PE'] as const).map((k) => (
              <button key={k} type="button" data-top-side={k} data-on={side === k ? '1' : '0'} onClick={() => setSide(k)}
                className={`h-[26px] px-[17px] rounded-full text-[14px] leading-none font-medium border ${side === k ? 'bg-primary text-primary-foreground border-primary' : 'bg-foreground/[0.03] text-foreground/75 border-foreground/20'}`}>
                {k === 'ALL' ? 'All' : k === 'CE' ? 'Call' : 'Put'}
              </button>
            ))}
            {/* What the right of each row shows: the price, or the volume the
                list is ordered by. */}
            <button type="button" data-top-metric={metric} onClick={() => setMetric((m) => (m === 'price' ? 'volume' : 'price'))}
              className="ml-auto mr-[3px] h-[26px] flex items-center gap-[8px] text-[14px] leading-none font-medium" style={{ color: BLUE }}>
              {metric === 'price' ? 'Price' : 'Volume'}
              <svg width="9" height="12.33" viewBox="0 0 9 12.33" aria-hidden="true"><path d="M4.5 0 L9 5 H0 Z M0 7.33 H9 L4.5 12.33 Z" fill="currentColor" /></svg>
            </button>
          </div>
          <div data-card="top" className="mt-[13.7px]">
            {top.length === 0 && <div className="py-6 text-center text-[12px] text-foreground/65">{chain ? 'No trades yet' : '…'}</div>}
            {top.map((l, i) => {
              const prev = l.ltp - l.chgLtp;
              const pct = prev > 0 ? (l.chgLtp / prev) * 100 : 0;
              const up = pct >= 0;
              return (
                <button key={l.tradingsymbol} type="button" data-top-row={l.tradingsymbol}
                  onClick={() => onOpenOption({ tradingsymbol: l.tradingsymbol, instrument_token: String(l.instrument_token), exchange: l.exchange || 'NFO', lot_size: l.lot_size, instrument_type: l.type, strike: l.strike, expiry: l.expiry })}
                  className={`w-full flex justify-between text-left pt-[13.7px] pb-[8.7px] active:bg-foreground/[0.04] ${i ? 'border-t border-foreground/15' : ''}`}>
                  <span className="min-w-0 flex flex-col">
                    <span className="text-[16px] leading-5 font-medium text-foreground/95 truncate">{rootName(l.tradingsymbol)} {l.strike}</span>
                    <span className="mt-[9.6px] text-[12px] leading-4 font-semibold text-foreground/65">{l.type === 'CE' ? 'Call' : 'Put'} | {expiryLabel(l.expiry)}</span>
                  </span>
                  <span className="shrink-0 flex flex-col items-end">
                    <span data-top="value" className="-mt-px text-[14px] leading-5 font-semibold text-foreground">{metric === 'price' ? `₹${inr(l.ltp)}` : volLabel(l.volume)}</span>
                    <span className="mt-[8px] flex items-center gap-[4.67px] text-[14px] leading-5 font-medium" style={{ color: up ? GREEN : CHANGE_RED }}>
                      <Tri up={up} color={up ? GREEN : CHANGE_RED} />{Math.abs(pct).toFixed(2)}%
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
