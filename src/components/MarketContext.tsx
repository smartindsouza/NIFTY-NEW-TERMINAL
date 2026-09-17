import { useState, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronDown, TrendingUp, TrendingDown, Globe, X } from "lucide-react";
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

function Row({ m }: { m: Market }) {
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
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
      <div className="min-w-0">
        <div className="text-sm text-foreground flex items-center gap-1.5 min-w-0">
          <span className="truncate">{m.label}</span>
          <MiniStatus open={m.open} />
          {m.prevSrc === 'price' && (
            // Flat by ARITHMETIC, not by market: no prior close was obtainable,
            // so the change is the price minus itself. Better to say so than to
            // render a convincing 0.00% that looks like an unchanged market.
            <span className="text-[9px] font-mono text-amber-500/70 shrink-0"
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
  // Which categories are hidden. Persisted so the sidebar opens how you left it.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("mc_collapsed") || "{}"); } catch { return {}; }
  });
  const toggle = (k: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      try { localStorage.setItem("mc_collapsed", JSON.stringify(next)); } catch {}
      return next;
    });

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
      {/* Pull tab — always visible on the right edge of the chart */}
      {!open && !tabHidden && (
        <button
          onClick={() => setOpen(true)}
          title="Market context"
          className="fixed top-1/2 -translate-y-1/2 right-0 z-[9997] bg-card border border-border border-r-0 rounded-l-lg px-1.5 py-3 text-slate-300 hover:text-foreground hover:bg-white/5 transition-colors flex flex-col items-center gap-1"
        >
          <ChevronLeft className="w-4 h-4" />
          <Globe className="w-4 h-4" />
        </button>
      )}

      {/* Tap-anywhere backdrop to dismiss (reliable close on mobile + desktop) */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[9998] bg-black/40"
          aria-label="Close market context"
        />
      )}

      {/* Slide-out panel */}
      <div
        className={`fixed top-0 right-0 h-full z-[9999] w-[290px] max-w-[85vw] bg-card border-l border-border shadow-2xl transition-transform duration-300 flex flex-col ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-3 py-3 border-b border-border bg-app-base">
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

        <div className="overflow-y-auto flex-1">
          <SectionHeader
            title="Indian Indices"
            count={indian.length}
            collapsed={!!collapsed.indian}
            onToggle={() => toggle("indian")}
            right={<StatusPill open={status.indian} />}
          />
          {!collapsed.indian && indian.map((m) => (
            <Row key={m.key} m={m} />
          ))}

          <SectionHeader
            title="US Futures"
            count={us.length}
            collapsed={!!collapsed.us}
            onToggle={() => toggle("us")}
            right={usAsOf ? <span className="text-slate-600 normal-case font-mono">{freshnessLabel(usAsOf)}</span> : null}
          />
          {/* "Loading…" was shown for an empty array forever, so a failed fetch and
              a slow one looked identical and the panel simply read nothing. If the
              server reported an error, say so instead. */}
          {!collapsed.us && us.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-500">
              {data && (data as any).success === false
                ? <span className="text-amber-400/80 font-mono text-[10px]">server error: {String((data as any).error || 'unknown').slice(0, 90)}</span>
                : data ? 'no rows returned' : 'Loading…'}
            </div>
          )}
          {!collapsed.us && us.map((m) => (
            <Row key={m.key} m={m} />
          ))}
          {!collapsed.us && us.length > 0 && us.every((m) => !m.available) && (
            <div className="px-3 py-2 text-[10px] text-slate-500 leading-relaxed">
              US data source unreachable from the server right now. Indian indices above are unaffected.
            </div>
          )}

          <SectionHeader
            title="UK Markets"
            count={uk.length}
            collapsed={!!collapsed.uk}
            onToggle={() => toggle("uk")}
            right={ukAsOf ? <span className="text-slate-600 normal-case font-mono">{freshnessLabel(ukAsOf)}</span> : null}
          />
          {!collapsed.uk && uk.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-500">Loading…</div>
          )}
          {!collapsed.uk && uk.map((m) => (
            <Row key={m.key} m={m} />
          ))}
          {!collapsed.uk && uk.length > 0 && uk.every((m) => !m.available) && (
            <div className="px-3 py-2 text-[10px] text-slate-500 leading-relaxed">
              UK data source unreachable from the server right now. Sections above are unaffected.
            </div>
          )}

          <SectionHeader
            title="Global & Commodities"
            count={globalMkts.length}
            collapsed={!!collapsed.global}
            onToggle={() => toggle("global")}
            right={globalAsOf ? <span className="text-slate-600 normal-case font-mono">{freshnessLabel(globalAsOf)}</span> : null}
          />
          {!collapsed.global && globalMkts.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-500">Loading…</div>
          )}
          {!collapsed.global && globalMkts.map((m) => (
            <Row key={m.key} m={m} />
          ))}
          {!collapsed.global && globalMkts.length > 0 && globalMkts.every((m) => !m.available) && (
            <div className="px-3 py-2 text-[10px] text-slate-500 leading-relaxed">
              Global data source unreachable from the server right now. Sections above are unaffected.
            </div>
          )}
        </div>

        <div className="px-3 py-2 border-t border-border text-[9px] text-slate-500 leading-tight">
          Indian: live via Kite. US, UK, global &amp; commodities: via a free third-party feed (may lag or drop out) — context only, confirm before trading. Open/Closed reflects regular session hours; exchange holidays aren't tracked.
        </div>
      </div>
    </>,
    document.body
  );
}
