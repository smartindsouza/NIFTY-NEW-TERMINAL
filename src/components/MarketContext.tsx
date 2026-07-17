import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, TrendingUp, TrendingDown, Globe, X } from "lucide-react";

interface Market {
  key: string; label: string; price?: number; change?: number; changePct?: number;
  asOf?: number; available: boolean;
}

function Row({ m }: { m: Market }) {
  if (!m.available) {
    return (
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <span className="text-sm text-slate-300">{m.label}</span>
        <span className="text-[10px] text-slate-500 font-mono">unavailable</span>
      </div>
    );
  }
  const up = (m.changePct ?? 0) >= 0;
  const color = up ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
      <div className="min-w-0">
        <div className="text-sm text-white truncate">{m.label}</div>
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
  const usAsOf = us.find((m) => m.available && m.asOf)?.asOf;
  const ukAsOf = uk.find((m) => m.available && m.asOf)?.asOf;
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
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500 font-bold bg-white/[0.02] flex items-center justify-between">
            <span>Indian Indices</span>
            <StatusPill open={status.indian} />
          </div>
          {indian.map((m) => (
            <Row key={m.key} m={m} />
          ))}

          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500 font-bold bg-white/[0.02] flex items-center justify-between">
            <span>US Futures</span>
            <span className="flex items-center gap-1.5">
              {usAsOf ? <span className="text-slate-600 normal-case font-mono">{freshnessLabel(usAsOf)}</span> : null}
              <StatusPill open={status.us} />
            </span>
          </div>
          {us.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-500">Loading…</div>
          )}
          {us.map((m) => (
            <Row key={m.key} m={m} />
          ))}
          {us.length > 0 && us.every((m) => !m.available) && (
            <div className="px-3 py-2 text-[10px] text-slate-500 leading-relaxed">
              US data source unreachable from the server right now. Indian indices above are unaffected.
            </div>
          )}

          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500 font-bold bg-white/[0.02] flex items-center justify-between">
            <span>UK Markets</span>
            <span className="flex items-center gap-1.5">
              {ukAsOf ? <span className="text-slate-600 normal-case font-mono">{freshnessLabel(ukAsOf)}</span> : null}
              <StatusPill open={status.uk} />
            </span>
          </div>
          {uk.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-500">Loading…</div>
          )}
          {uk.map((m) => (
            <Row key={m.key} m={m} />
          ))}
          {uk.length > 0 && uk.every((m) => !m.available) && (
            <div className="px-3 py-2 text-[10px] text-slate-500 leading-relaxed">
              UK data source unreachable from the server right now. Sections above are unaffected.
            </div>
          )}
        </div>

        <div className="px-3 py-2 border-t border-white/10 text-[9px] text-slate-500 leading-tight">
          Indian: live via Kite. US &amp; UK: via a free third-party feed (may lag or drop out) — context only, confirm before trading. Open/Closed reflects regular session hours; exchange holidays aren't tracked.
        </div>
      </div>
    </>
  );
}
