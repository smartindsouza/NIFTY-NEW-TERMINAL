import { useState, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, TrendingUp, TrendingDown, Globe, X, LineChart, ChartCandlestick } from "lucide-react";
import { useLocation } from "wouter";
import { notificationService } from "../lib/notificationService";
import { toast } from "sonner";

// ============================================================================
// SUDDEN-MOVE ALERTS on global indices, commodities and India VIX.
//
// This component polls every 5s whether or not the drawer is open, so it is the
// natural place to watch. "Sudden" means a move over a SHORT WINDOW (60s), not
// the day's change: a market that drifts 1% over six hours is not news, one that
// moves 0.5% in a minute is.
//
// Thresholds differ by instrument because their normal volatility does. India
// VIX routinely moves several percent in a day, so it needs a wider bar than an
// index, or it would alert constantly; commodities sit between the two. These
// are starting points, chosen to fire on the moves worth looking up for and stay
// quiet otherwise — they may need tuning once Martin sees them in practice.
const MOVE_WINDOW_MS = 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;      // one alert per instrument per 5 min
const MAX_SAMPLE_AGE_MS = 3 * 60 * 1000; // a gap this long means the app was idle
function moveThresholdPct(key: string): number {
  if (key === 'VIX') return 3.0;                                   // India VIX
  if (['GOLD', 'SILVER', 'OIL', 'BRENT'].includes(key)) return 0.8;
  return 0.4;                                                       // indices
}
type Sample = { price: number; at: number };
const moveHistory = new Map<string, Sample[]>();
const lastAlertAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// DAY-MOVE ALERTS. The 60-second rule above catches a spike, and that is the
// wrong shape for India VIX: its meaningful moves build over hours, so it can
// finish a day 8% up without ever jumping 3% inside one minute. Martin saw no
// VIX alert for exactly that reason — the threshold was effectively unreachable,
// not merely wide.
//
// So a second trigger on the DAY's change, which the feed already provides:
// alert the first time it crosses a level, and again at each further step, so a
// VIX grinding from +5% to +10% reports twice rather than once or forty times.
// Steps rather than a single threshold, because the second leg of a VIX move is
// usually the one that matters.
const DAY_STEPS: Record<string, number> = {
  VIX: 5,        // India VIX: +/-5%, then 10, 15 ...
  _index: 1,     // indices: 1%, 2% ... a 1% day in an index is a real session
  _commodity: 2, // gold/oil: 2%, 4% ...
};
const dayStepReported = new Map<string, number>();
function dayStepFor(key: string): number {
  if (key === 'VIX') return DAY_STEPS.VIX;
  if (['GOLD', 'SILVER', 'OIL', 'BRENT'].includes(key)) return DAY_STEPS._commodity;
  return DAY_STEPS._index;
}

/** Returns the step just crossed (signed) when the DAY's move reaches a new
 *  multiple of the instrument's step, else null. */
export function detectDayMove(key: string, changePct: number | undefined, isOpen: boolean): number | null {
  if (!isOpen || typeof changePct !== 'number' || !Number.isFinite(changePct)) return null;
  const step = dayStepFor(key);
  const reached = Math.trunc(Math.abs(changePct) / step) * step * (changePct < 0 ? -1 : 1);
  if (reached === 0) { dayStepReported.set(key, 0); return null; }
  const last = dayStepReported.get(key) ?? 0;
  // Only on a NEW, larger step in the same direction. A retreat resets the mark
  // so a move that comes back and pushes on reports again.
  if (Math.sign(reached) !== Math.sign(last) || Math.abs(reached) > Math.abs(last)) {
    dayStepReported.set(key, reached);
    return reached;
  }
  if (Math.abs(reached) < Math.abs(last)) dayStepReported.set(key, reached);
  return null;
}

/** Returns the alert text when a market has moved sharply, else null. */
export function detectSuddenMove(
  key: string, label: string, price: number, isOpen: boolean, now: number
): { pct: number; from: number } | null {
  if (!(price > 0)) return null;
  const hist = moveHistory.get(key) || [];
  hist.push({ price, at: now });
  // keep a little more than the window so there is always a baseline to compare
  while (hist.length > 2 && hist[0].at < now - MOVE_WINDOW_MS * 2) hist.shift();
  moveHistory.set(key, hist);

  // A closed market's print is a settlement, not a move.
  if (!isOpen) return null;
  // The oldest sample still inside the window is the baseline.
  const baseline = hist.find((h) => h.at >= now - MOVE_WINDOW_MS && h.at <= now - 15000);
  if (!baseline || !(baseline.price > 0)) return null;
  // A stale baseline means the tab was backgrounded; the "jump" spans that gap.
  if (now - baseline.at > MAX_SAMPLE_AGE_MS) return null;

  const pct = (price - baseline.price) / baseline.price * 100;
  if (Math.abs(pct) < moveThresholdPct(key)) return null;
  const last = lastAlertAt.get(key) || 0;
  if (now - last < COOLDOWN_MS) return null;
  lastAlertAt.set(key, now);
  return { pct, from: baseline.price };
}

interface Market {
  key: string; label: string; price?: number; change?: number; changePct?: number;
  asOf?: number; available: boolean; reason?: string; prevSrc?: string; prev?: number;
  // Per-market session status (used by Global & Commodities, whose rows don't
  // share one schedule). Undefined => the row shows no pill.
  open?: boolean;
}

// Compact per-row OPEN / CLOSED tag.
function MiniStatus({ open }: { open?: boolean }) {
  if (open === undefined) return null;
  return (
    <span
      title={open ? "Regular session open" : "Regular session closed"}
      className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[8px] font-bold font-mono tracking-normal ${
        open ? "bg-emerald-500/15 text-emerald-400" : "bg-white/5 text-slate-500"
      }`}
    >
      <span className={`w-1 h-1 rounded-full ${open ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
      {open ? "OPEN" : "CLOSED"}
    </span>
  );
}

function Row({ m, onOpen }: { m: Market; onOpen?: () => void }) {
  if (!m.available) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
        <span className="text-sm text-slate-300 flex items-center gap-1.5 min-w-0">
          <span className="truncate">{m.label}</span>
          <MiniStatus open={m.open} />
        </span>
        {/* Say WHY. 'unavailable' alone left a blocked upstream, a timeout and a
            changed API looking identical, so a whole empty section gave no clue
            what to do about it. The server now returns a reason per row. */}
        <span className="text-[10px] text-slate-500 font-mono shrink-0" title={m.reason || 'no reason reported'}>
          {m.reason === 'no_kite_session' ? 'no session'
            : m.reason?.startsWith('blocked_by_yahoo') ? 'source blocked'
            : m.reason === 'rate_limited_429' ? 'rate limited'
            : m.reason === 'timeout' ? 'timed out'
            : m.reason === 'no_price_in_response' ? 'no price'
            : m.reason ? m.reason
            : 'unavailable'}
        </span>
      </div>
    );
  }
  const up = (m.changePct ?? 0) >= 0;
  const color = up ? "text-emerald-400" : "text-rose-400";
  return (
    <div onClick={onOpen} role={onOpen ? 'button' : undefined}
      title={onOpen ? `Open the ${m.label} chart (Zerodha data)` : undefined}
      className={`flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5 ${onOpen ? 'cursor-pointer hover:bg-white/[0.04] active:bg-white/[0.07]' : ''}`}>
      <div className="min-w-0">
        <div className="text-sm text-foreground flex items-center gap-1.5 min-w-0">
          <span className="truncate">{m.label}</span>
          {onOpen && <LineChart className="w-3 h-3 text-primary/70 shrink-0" />}
          <MiniStatus open={m.open} />
          {m.prevSrc === 'price' && (
            // Flat by ARITHMETIC, not by market: no prior close was obtainable,
            // so the change is the price minus itself. Better to say so than to
            // render a convincing 0.00% that looks like an unchanged market.
            <span className="text-[9px] font-mono text-primary/70 shrink-0"
                  title="No previous close available from the data source, so the change cannot be computed">
              no ref
            </span>
          )}
        </div>
        <div className="text-xs font-mono text-slate-300 tabular-nums">
          {m.price?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
      </div>
      <div className={`text-right ${color} shrink-0`}>
        <div className="text-xs font-mono font-bold tabular-nums flex items-center gap-0.5 justify-end">
          {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {up ? "+" : ""}{(m.changePct ?? 0).toFixed(2)}%
        </div>
        <div className="text-[10px] font-mono text-slate-400 tabular-nums">
          {up ? "+" : ""}{(m.change ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
      </div>
    </div>
  );
}

// THE SIDEBAR IS A PICKER WHEEL, STRAIGHT (18 Nov 2026). Martin, with a picture
// of a picker (a name on the left, a round-ended tile on the right, the one in
// the middle picked out — its name in an outlined chip, its tile outlined in
// colour — the rest fading away from it, a line down the right with a handle
// at the middle): "I want to change my side bar to this exact design but in a
// straight vertical scrolling instead of circular as shown. Each indices
// should be shown separately also separated as Indian, US, UK etc as it's
// currently. Use the same UI as it is except the circular scrolling".
// So each market is one row of that picker: its name (and price) on the left,
// and in the tile the day's change, green or red. The row at the middle of the
// panel is the picked-out one (the accent colour stands in for the picture's
// pink); the others fade with their distance from it; the list snaps a row to
// the middle. The sections are still headed Indian, US, UK, Global, and a tap
// on a heading still folds it. A row's chart is opened by the small icon
// before its name (see WheelRow), not by the row.
const WHEEL_ROW = 58;
function WheelRow({ m, onOpen }: { m: Market; onOpen?: () => void }) {
  const ok = m.available;
  const up = (m.changePct ?? 0) >= 0;
  const why = !ok ? (m.reason === 'no_kite_session' ? 'no session'
    : m.reason?.startsWith('blocked_by_yahoo') ? 'source blocked'
    : m.reason === 'rate_limited_429' ? 'rate limited'
    : m.reason === 'timeout' ? 'timed out'
    : m.reason === 'no_price_in_response' ? 'no price'
    : m.reason ? m.reason : 'unavailable') : '';
  return (
    <div data-wheel-row={m.key}
      title={onOpen ? undefined : (m.reason || undefined)}
      style={{ height: WHEEL_ROW }}
      className="group relative snap-center flex items-center justify-end gap-3 pl-3 pr-[60px] will-change-[opacity]">
      {/* THE ROW ITSELF OPENS NOTHING (18 Nov 2026). Martin: "when I tap an
          index by mistake, its chart opens up in the chart screen. So prevent
          it by adding a small chart open icon somewhere for every index". The
          whole row was the button, and the row is also what a thumb lands on
          while scrolling the list. The chart is opened by this icon alone,
          a row with no chart to open has none. It stands past the line down
          the right, at the screen's edge (Martin, the same day: "Move the
          candlestick icons to the right on the other side of the straight
          white line"); the line and its handle moved 8px in to give it room. */}
      {onOpen && (
        <button type="button" data-wheel="open" onClick={(e) => { e.stopPropagation(); onOpen(); }}
          aria-label={`Open the ${m.label} chart`} title={`Open the ${m.label} chart (Zerodha data)`}
          className="absolute right-0 top-1/2 -translate-y-1/2 h-10 w-[34px] flex items-center justify-center pr-[3px] rounded-full text-foreground/50 group-data-[on]:text-primary active:bg-foreground/10">
          <ChartCandlestick size={14} />
        </button>
      )}
      <div className="min-w-0 flex flex-col items-end">
        <span data-wheel="name" // No chip round the picked name: a glow in the accent behind it (18 Nov
          // 2026; Martin: "Remove the outline for the indice highlighted. Keep the
          // outline for the percentage figure. You can also add a small glow
          // behind indice text in accent color").
          className="whitespace-nowrap px-2.5 py-[3px] text-[14px] leading-[18px] font-medium text-foreground/60 group-data-[on]:text-foreground group-data-[on]:font-semibold group-data-[on]:[text-shadow:0_0_12px_var(--primary),0_0_22px_color-mix(in_srgb,var(--primary)_55%,transparent)]">
          {m.label}
        </span>
        <span className="pr-2.5 text-[10px] leading-3 font-mono tabular-nums text-foreground/45 group-data-[on]:text-foreground/80">
          {/* How old the figure is stands on its own row, when it is more than
              two minutes old — not on the heading, where one row's age spoke
              for a section whose rows now come from two sources (18 Nov 2026). */}
          {ok && m.asOf && Date.now() - m.asOf > 2 * 60000 && <span className="mr-1.5 text-foreground/35">{freshnessLabel(m.asOf).replace('~', '').replace(' old', '')}</span>}
          {ok ? m.price?.toLocaleString(undefined, { maximumFractionDigits: 2 }) : why}
          {ok && m.prevSrc === 'price' && <span className="ml-1 text-primary/70" title="No previous close available from the data source, so the change cannot be computed">no ref</span>}
        </span>
      </div>
      {/* The picked tile's outline is the change's own colour, green or red, not
          the accent (18 Nov 2026; Martin: "change the highlighted percentage text
          outline color to red or green based on the positive or negative
          percentage change instead of accent color"). */}
      <div data-wheel="tile"
        className={`shrink-0 h-[42px] w-[62px] rounded-full border border-transparent bg-foreground/[0.06] flex items-center justify-center text-[11px] leading-none font-bold font-mono tabular-nums ${!ok ? 'text-foreground/35 group-data-[on]:border-foreground/30' : up ? 'text-emerald-400 group-data-[on]:border-emerald-400 group-data-[on]:bg-emerald-400/10' : 'text-rose-400 group-data-[on]:border-rose-400 group-data-[on]:bg-rose-400/10'}`}>
        {ok ? `${up ? '+' : ''}${(m.changePct ?? 0).toFixed(2)}%` : '—'}
      </div>
    </div>
  );
}

// The headings stand out and each says whether its market is open (18 Nov 2026).
// Martin: "The side bar headings for Indian, US, UK etc are not clearly
// distinguished. Make them highlighted and OPEN/CLOSED should appear beside
// every heading. Not only for Indian market". A filled, outlined pill in the
// accent with the name in full strength; OPEN / CLOSED before it, and how old
// the numbers are where the section says.
function WheelHeader({ title, collapsed, onToggle, open, age }: { title: string; collapsed: boolean; onToggle: () => void; open?: boolean; age?: string }) {
  return (
    <div className="h-11 pl-3 pr-[60px] flex items-center justify-end gap-2" data-wheel-head="">
      {age && <span className="text-[9px] font-mono text-foreground/45 whitespace-nowrap">{age}</span>}
      <StatusPill open={open} />
      <button type="button" onClick={onToggle} aria-expanded={!collapsed}
        className="h-7 pl-3 pr-2 rounded-full border border-primary/40 bg-primary/15 flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-foreground whitespace-nowrap">
        <span>{title}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 text-primary transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>
    </div>
  );
}

// The list itself: pads its ends so the first and last rows can reach the
// middle, and after every scroll (once a frame) marks the row nearest the
// middle and fades the rest by their distance from it. Written straight to
// the rows, not through React: it runs on every scroll frame.
function Wheel({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const paint = () => {
    const el = ref.current; if (!el) return;
    const box = el.getBoundingClientRect(); const mid = box.top + box.height / 2; const reach = box.height / 2;
    let best: HTMLElement | null = null, bestD = Infinity;
    const rows = el.querySelectorAll<HTMLElement>('[data-wheel-row]');
    rows.forEach((r) => {
      const b = r.getBoundingClientRect(); const d = Math.abs(b.top + b.height / 2 - mid);
      r.style.opacity = String(Math.max(0.28, 1 - (d / reach) * 0.8));
      if (d < bestD) { bestD = d; best = r; }
    });
    rows.forEach((r) => { if (r === best) r.setAttribute('data-on', ''); else r.removeAttribute('data-on'); });
  };
  useEffect(() => {
    if (!active) return;
    const el = ref.current; if (!el) return;
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); };
    el.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    on();
    return () => { cancelAnimationFrame(raf); el.removeEventListener('scroll', on); window.removeEventListener('resize', on); };
  }, [active]);
  // Rows come and go (a section folded, prices arriving): mark again.
  useEffect(() => { if (active) paint(); });
  return (
    <div className="relative flex-1 min-h-0 [container-type:size]">
      <div ref={ref} data-wheel="" className="h-full overflow-y-auto overscroll-contain snap-y snap-proximity [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ paddingTop: 'calc(50cqh - 29px)', paddingBottom: 'calc(50cqh - 29px)' }}>
        {children}
      </div>
      {/* The line down the right and the handle at its middle. */}
      <div className="pointer-events-none absolute right-[34px] inset-y-0 w-px bg-foreground/15" aria-hidden="true" />
      <div className="pointer-events-none absolute right-[20px] top-1/2 -translate-y-1/2 h-[10px] w-[29px] rounded-full bg-foreground/70" aria-hidden="true" />
    </div>
  );
}

// Collapsible category header. Tapping it shows/hides that category's rows;
// the choice is remembered across sessions.
function SectionHeader({
  title, count, collapsed, onToggle, right,
}: { title: string; count: number; collapsed: boolean; onToggle: () => void; right?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="w-full px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500 font-bold bg-white/[0.02] hover:bg-white/[0.05] transition-colors flex items-center justify-between gap-2"
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        <span className="truncate">{title}</span>
        {count > 0 && <span className="text-slate-600 normal-case font-mono">({count})</span>}
      </span>
      <span className="flex items-center gap-1.5 shrink-0">{right}</span>
    </button>
  );
}

function freshnessLabel(asOf?: number): string {
  if (!asOf) return "";
  const ageMin = Math.floor((Date.now() - asOf) / 60000);
  if (ageMin <= 1) return "live";
  return `~${ageMin}m old`;
}

// Small OPEN / CLOSED pill for a market group. Status comes from the server,
// computed from each exchange's regular weekday session hours in its own
// timezone (holidays aren't tracked).
function StatusPill({ open }: { open?: boolean }) {
  if (open === undefined) return null;
  return (
    <span
      className={`normal-case inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold font-mono tracking-normal ${
        open ? "bg-emerald-500/15 text-emerald-400" : "bg-white/5 text-slate-500"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${open ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
      {open ? "OPEN" : "CLOSED"}
    </span>
  );
}

export default function MarketContext({ tabHidden = false }: { tabHidden?: boolean }) {
  const [open, setOpen] = useState(false);
  // The slide-out covers the chart; tell the chart page so its jump-to-latest
  // bubble steps aside instead of floating over this panel.
  useEffect(() => {
    try { window.dispatchEvent(new CustomEvent('chart_overlay', { detail: { id: 'market-context', open } })); } catch (e) {}
  }, [open]);
  // ON A PHONE THE WAY IN IS THE GLOBE IN THE CHART'S HEADER (17 Nov 2026), not
  // the pull tab below — Martin had it moved to the top right, where search
  // used to be. The header's button (data-head="context" in AdvancedChart.tsx)
  // cannot reach this component's state, so it says so with an event.
  // THE PAGE BEHIND DOES NOT SCROLL WHILE IT IS OPEN (18 Nov 2026). Martin:
  // "avoid scrolling of the background screen when sidebar is on". The page is
  // held still (its scroll is switched off and put back as it was on closing),
  // the layer behind the list takes no dragging, and the list keeps its own
  // scrolling to itself at its ends (overscroll-contain on the wheel).
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement, body = document.body;
    const was = { h: html.style.overflow, b: body.style.overflow, o: html.style.overscrollBehavior };
    html.style.overflow = 'hidden'; body.style.overflow = 'hidden'; html.style.overscrollBehavior = 'none';
    return () => { html.style.overflow = was.h; body.style.overflow = was.b; html.style.overscrollBehavior = was.o; };
  }, [open]);
  useEffect(() => {
    const f = () => setOpen(true);
    window.addEventListener('market_context_open', f);
    return () => window.removeEventListener('market_context_open', f);
  }, []);
  // Which categories are hidden. Persisted so the sidebar opens how you left it.
  // It opens with Indian Indices folded and the rest open, every time (18 Nov
  // 2026; Martin: "by default collapse only the Indian market rather all other
  // headings when opening the sidebar"). A heading tapped while it is open
  // folds or unfolds until it is closed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ indian: true });
  useEffect(() => { if (open) setCollapsed({ indian: true }); }, [open]);
  const toggle = (k: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      try { localStorage.setItem("mc_collapsed", JSON.stringify(next)); } catch {}
      return next;
    });

  // Tap a row → open that market's chart from Zerodha data (11 Nov 2026). Which
  // rows have a Zerodha equivalent comes from /api/chart-ref (server/chart_ref.ts);
  // rows without one (FTSE 250, KOSPI, Brent) stay plain.
  const [, setLocation] = useLocation();
  const { data: refMap } = useQuery({
    queryKey: ["chart-ref-all"],
    queryFn: async () => { const r = await fetch("/api/chart-ref?key=_all"); if (!r.ok) throw new Error("chart-ref"); return r.json(); },
    enabled: open, staleTime: 6 * 3600e3, retry: 1,
  });
  const openChart = (m: Market) => {
    // GIFT NIFTY and US30 (the "Dow Fut" row) open the chart's own two
    // reference charts — they left the chart's index menu for this sidebar
    // (18 Nov 2026).
    const own = m.key === 'GIFT' ? 'GIFT' : m.key === 'DJI' ? 'US30' : null;
    if (own) {
      return () => {
        try {
          sessionStorage.setItem('indexChartOpen', own);
          sessionStorage.removeItem('refChartOpen');
          sessionStorage.removeItem('selectedInstrument');
        } catch (e) {}
        try { window.dispatchEvent(new CustomEvent('open-index-chart', { detail: own })); } catch (e) {}
        setOpen(false);
        if (!window.location.pathname.startsWith('/advanced-chart')) setLocation('/advanced-chart');
      };
    }
    const ref = refMap?.[m.key];
    if (!ref?.available) return undefined;
    return () => {
      const d = { token: ref.token, label: ref.label, kind: ref.kind, exchange: ref.exchange, tradingsymbol: ref.tradingsymbol };
      try {
        sessionStorage.setItem('refChart', JSON.stringify(d));
        sessionStorage.setItem('refChartOpen', '1');
        sessionStorage.removeItem('selectedInstrument');   // never reopen a stale option chart on top
      } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('open-ref-chart', { detail: d })); } catch (e) {}
      setOpen(false);
      if (!window.location.pathname.startsWith('/advanced-chart')) setLocation('/advanced-chart');
    };
  };

  const { data } = useQuery({
    queryKey: ["market-context"],
    queryFn: async () => {
      const r = await fetch("/api/market-context");
      if (!r.ok) throw new Error("market-context fetch failed");
      return r.json();
    },
    refetchInterval: () => (document.visibilityState === "visible" ? 5000 : false),
    staleTime: 4000,
  });

  const indian: Market[] = data?.indian || [];
  const us: Market[] = data?.us || [];
  const uk: Market[] = data?.uk || [];
  const globalMkts: Market[] = data?.global || [];
  const usAsOf = us.find((m) => m.available && m.asOf)?.asOf;
  const ukAsOf = uk.find((m) => m.available && m.asOf)?.asOf;
  const globalAsOf = globalMkts.find((m) => m.available && m.asOf)?.asOf;
  const status: { indian?: boolean; us?: boolean; uk?: boolean } = data?.status || {};

  // Watch every row each poll and alert on a sharp move. Runs whether or not the
  // drawer is open, which is the point: these are markets Martin is not looking
  // at. India VIX is in the Indian list, so its session status is the Indian one;
  // global and commodity rows carry their own.
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const rows: Array<{ m: Market; isOpen: boolean }> = [
      ...indian.map((m) => ({ m, isOpen: status.indian !== false })),
      ...us.map((m) => ({ m, isOpen: status.us !== false })),
      ...uk.map((m) => ({ m, isOpen: status.uk !== false })),
      ...globalMkts.map((m) => ({ m, isOpen: (m as any).open !== false })),
    ];
    for (const { m, isOpen } of rows) {
      if (!m.available || !(m.price! > 0)) continue;
      // Two shapes of move: a spike inside a minute, and the day's total. VIX
      // needs the second; an index spike needs the first.
      const hit = detectSuddenMove(m.key, m.label, m.price!, isOpen, now);
      const dayHit = hit ? null : detectDayMove(m.key, m.changePct, isOpen);
      if (!hit && dayHit === null) continue;
      const pctMoved = hit ? hit.pct : (m.changePct as number);
      const dir = pctMoved >= 0 ? 'jumped' : 'dropped';
      const arrow = pctMoved >= 0 ? '▲' : '▼';
      const title = `${arrow} ${m.label} ${dir} ${Math.abs(pctMoved).toFixed(2)}%${hit ? '' : ' today'}`;
      const body = hit
        ? `${hit.from.toFixed(2)} → ${m.price!.toFixed(2)} in under a minute`
        : `now ${m.price!.toFixed(2)} · ${pctMoved >= 0 ? '+' : ''}${pctMoved.toFixed(2)}% on the day`;
      // 'divergence' + ephemeral: same class as the chart's level alerts, so it
      // expires with the session and never greets him as stale on a later launch.
      notificationService.add('divergence', title, body, { ephemeral: true, source: 'market-move', key: m.key });
      toast(title, { description: body });
    }
  }, [data]);

  // PORTALLED TO document.body. The pull tab and drawer are position:fixed with
  // z-9999, yet the chart's toolbar icons still painted over them — because
  // z-index only ranks siblings WITHIN a stacking context, and this component is
  // rendered inside the chart header, which carries z-30. Everything inside that
  // header is therefore capped at 30 relative to the rest of the page, however
  // large its own z-index. (The header's z-30 is mine, added so the full-width
  // title row paints over the option pane — so this is a regression I introduced.)
  //
  // A portal moves the markup to the end of body, outside every one of those
  // contexts, which is the only fix that does not involve trading one overlap
  // for another.
  return createPortal(
    <>
      {/* Pull tab on the right edge of the chart — desktop only; a phone has
          the globe in the chart's header instead (see above). */}
      {!open && !tabHidden && (
        <button
          onClick={() => setOpen(true)}
          title="Market context"
          data-context-tab=""
          className="max-md:hidden fixed top-1/2 -translate-y-1/2 right-0 z-[9997] bg-card border border-border border-r-0 rounded-l-lg px-1.5 py-3 text-slate-300 hover:text-foreground hover:bg-white/5 transition-colors flex flex-col items-center gap-1"
        >
          <Globe className="w-4 h-4" />
        </button>
      )}

      {/* A SWIPE FROM THE RIGHT EDGE OPENS IT ON A PHONE (18 Nov 2026). Martin:
          "remove the globe icon to display the side bar and instead make the
          side bar appear by swiping from the edge of the screen in the mobile
          app ... the swipe from the edge of the screen must be only in the chart
          screen. You can also keep a thin swipe identifier at the edge of the
          screen". This component is only on the chart screen, so the strip is
          too: 18px of the right edge, the middle half of the screen's height,
          with a thin bar at its middle to show it is there. A touch that begins
          on it and moves left 24px (and more sideways than up or down) opens
          the list. Not while a sheet or a list is over the chart (tabHidden). */}
      {!open && !tabHidden && (
        <div data-context-swipe="" aria-hidden="true"
          // Only the bar itself is the handle now, and it is wider (18 Nov 2026;
          // Martin: "increase the width of the sidebar accent bar at the screen edge
          // and make the side bar appear only when I swipe on that accent bar and
          // not on the entire screen edge"): the touch area is the bar's own
          // height, with a finger's width of room beside it.
          className="md:hidden fixed right-0 top-1/2 -translate-y-1/2 h-16 w-[22px] z-[45] flex items-center justify-end touch-none"
          onPointerDown={(e) => {
            const x0 = e.clientX, y0 = e.clientY; const el = e.currentTarget;
            try { el.setPointerCapture(e.pointerId); } catch (er) {}
            const move = (ev: PointerEvent) => {
              const dx = x0 - ev.clientX, dy = Math.abs(ev.clientY - y0);
              if (dx > 24 && dx > dy) { done(); setOpen(true); }
            };
            const done = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', done); el.removeEventListener('pointercancel', done); };
            el.addEventListener('pointermove', move); el.addEventListener('pointerup', done); el.addEventListener('pointercancel', done);
          }}>
          <span className="h-16 w-[8px] rounded-l-full bg-primary/80" />
        </div>
      )}

      {/* Tap-anywhere backdrop to dismiss (reliable close on mobile + desktop) */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[9998] bg-black/55 backdrop-blur-md touch-none"
          onTouchMove={(e) => { e.stopPropagation(); }}
          aria-label="Close market context"
        />
      )}

      {/* Slide-out panel */}
      <div
        className={`fixed top-0 right-0 h-full z-[9999] w-[290px] max-w-[85vw] transition-transform duration-300 flex flex-col ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-3 py-3">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            <span className="font-bold text-foreground text-sm">Market Context</span>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-slate-300 hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
            <span className="text-xs font-semibold">Close</span>
          </button>
        </div>

        <Wheel active={open}>
          <WheelHeader
            title="Indian Indices"
            collapsed={!!collapsed.indian}
            onToggle={() => toggle("indian")}
            open={status.indian}
          />
          {!collapsed.indian && indian.map((m) => (
            <WheelRow key={m.key} m={m} onOpen={openChart(m)} />
          ))}

          <WheelHeader
            title="US Futures"
            collapsed={!!collapsed.us}
            onToggle={() => toggle("us")}
            open={status.us}
          />
          {/* "Loading…" was shown for an empty array forever, so a failed fetch and
              a slow one looked identical and the panel simply read nothing. If the
              server reported an error, say so instead. */}
          {!collapsed.us && us.length === 0 && (
            <div className="pl-3 pr-[60px] py-3 text-right text-xs text-slate-500">
              {data && (data as any).success === false
                ? <span className="text-primary/80 font-mono text-[10px]">server error: {String((data as any).error || 'unknown').slice(0, 90)}</span>
                : data ? 'no rows returned' : 'Loading…'}
            </div>
          )}
          {!collapsed.us && us.map((m) => (
            <WheelRow key={m.key} m={m} onOpen={openChart(m)} />
          ))}
          {!collapsed.us && us.length > 0 && us.every((m) => !m.available) && (
            <div className="pl-3 pr-[60px] py-2 text-right text-[10px] text-slate-500 leading-relaxed">
              US data source unreachable from the server right now. Indian indices above are unaffected.
            </div>
          )}

          <WheelHeader
            title="UK Markets"
            collapsed={!!collapsed.uk}
            onToggle={() => toggle("uk")}
            open={status.uk}
          />
          {!collapsed.uk && uk.length === 0 && (
            <div className="pl-3 pr-[60px] py-3 text-right text-xs text-slate-500">Loading…</div>
          )}
          {!collapsed.uk && uk.map((m) => (
            <WheelRow key={m.key} m={m} onOpen={openChart(m)} />
          ))}
          {!collapsed.uk && uk.length > 0 && uk.every((m) => !m.available) && (
            <div className="pl-3 pr-[60px] py-2 text-right text-[10px] text-slate-500 leading-relaxed">
              UK data source unreachable from the server right now. Sections above are unaffected.
            </div>
          )}

          <WheelHeader
            title="Global & Commodities"
            collapsed={!!collapsed.global}
            onToggle={() => toggle("global")}
            open={globalMkts.length ? globalMkts.some((m) => m.open === true) : undefined}
          />
          {!collapsed.global && globalMkts.length === 0 && (
            <div className="pl-3 pr-[60px] py-3 text-right text-xs text-slate-500">Loading…</div>
          )}
          {!collapsed.global && globalMkts.map((m) => (
            <WheelRow key={m.key} m={m} onOpen={openChart(m)} />
          ))}
          {!collapsed.global && globalMkts.length > 0 && globalMkts.every((m) => !m.available) && (
            <div className="pl-3 pr-[60px] py-2 text-right text-[10px] text-slate-500 leading-relaxed">
              Global data source unreachable from the server right now. Sections above are unaffected.
            </div>
          )}
        </Wheel>

        {/* NO PANEL, NO FOOTNOTE (18 Nov 2026). Martin: "Remove the background color
            for the side bar and make the entire background (screen) blurred. Remove
            the chick of text at the bottom explaining things". The list floats
            over the whole screen, blurred and dimmed behind it. */}
      </div>
    </>,
    document.body
  );
}
