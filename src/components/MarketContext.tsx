import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronDown, TrendingUp, TrendingDown, Globe, X } from "lucide-react";

interface Market {
  key: string; label: string; price?: number; change?: number; changePct?: number;
  asOf?: number; available: boolean;
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
        <span className="text-[10px] text-slate-500 font-mono shrink-0">unavailable</span>
      </div>
    );
  }
  const up = (m.changePct ?? 0) >= 0;
  const color = up ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
      <div className="min-w-0">
        <div className="text-sm text-white flex items-center gap-1.5 min-w-0">
          <span className="truncate">{m.label}</span>
          <MiniStatus open={m.open} />
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

export default function MarketContext() {
  const [open, setOpen] = useState(false);
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

  return (
    <>
      {/* Pull tab — always visible on the right edge of the chart */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Market context"
          className="fixed top-1/2 -translate-y-1/2 right-0 z-[9997] bg-[#1a1c1e] border border-white/10 border-r-0 rounded-l-lg px-1.5 py-3 text-slate-300 hover:text-white hover:bg-white/5 transition-colors flex flex-col items-center gap-1"
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
        className={`fixed top-0 right-0 h-full z-[9999] w-[290px] max-w-[85vw] bg-[#141618] border-l border-white/10 shadow-2xl transition-transform duration-300 flex flex-col ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-3 py-3 border-b border-white/10 bg-app-base">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            <span className="font-bold text-white text-sm">Market Context</span>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors"
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
          {!collapsed.us && us.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-500">Loading…</div>
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

        <div className="px-3 py-2 border-t border-white/10 text-[9px] text-slate-500 leading-tight">
          Indian: live via Kite. US, UK, global &amp; commodities: via a free third-party feed (may lag or drop out) — context only, confirm before trading. Open/Closed reflects regular session hours; exchange holidays aren't tracked.
        </div>
      </div>
    </>
  );
}
