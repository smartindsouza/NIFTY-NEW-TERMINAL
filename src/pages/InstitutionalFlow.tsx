import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

// ============================================================================
// INSTITUTIONAL FLOW — the latest published FII/FPI and DII cash-market day,
// laid out to Martin's reference. Live only: no history, no stored snapshots.
// If no source answers, the screen says unavailable rather than showing an
// older day as though it were current.
// ============================================================================

type Side = { buy: number; sell: number; net: number };
type FlowDay = {
  date: string; displayDate: string;
  fii: Side; dii: Side;
  combinedBuy: number; combinedSell: number; combinedNet: number;
};

const cr = (n: number, sign = false) => {
  const s = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pre = sign ? (n >= 0 ? "+" : "−") : n < 0 ? "−" : "";
  return `${pre}₹${s} Cr`;
};
const fmtDate = (iso: string) => {
  try {
    return new Date(iso + "T00:00:00+05:30").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
};

function FlowBars({ buy, sell }: { buy: number; sell: number }) {
  const max = Math.max(buy, sell, 1);
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 rounded-full bg-emerald-500/15 overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(buy / max) * 100}%` }} />
      </div>
      <div className="h-1.5 rounded-full bg-rose-500/15 overflow-hidden">
        <div className="h-full bg-rose-500 rounded-full" style={{ width: `${(sell / max) * 100}%` }} />
      </div>
    </div>
  );
}

function CategoryCard({ title, subtitle, side }: { title: string; subtitle: string; side: Side }) {
  const buying = side.net >= 0;
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4 flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-[11px] text-muted-foreground">{subtitle}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Bought</div>
          <div className="text-base font-mono font-semibold text-emerald-400 tabular-nums">{cr(side.buy)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sold</div>
          <div className="text-base font-mono font-semibold text-rose-400 tabular-nums">{cr(side.sell)}</div>
        </div>
      </div>
      <FlowBars buy={side.buy} sell={side.sell} />
      <div className="flex items-center justify-between border-t border-border/60 pt-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{buying ? "Net buy" : "Net sell"}</span>
        <span className={`text-sm font-mono font-bold tabular-nums ${buying ? "text-emerald-400" : "text-rose-400"}`}>
          {cr(side.net, true)}
        </span>
      </div>
    </div>
  );
}

export function InstitutionalFlow() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["institutional-flow"],
    queryFn: async () => {
      const r = await fetch("/api/institutional-flow");
      if (!r.ok) throw new Error("request failed");
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const latest: FlowDay | null = data?.latest || null;
  const netPositive = (latest?.combinedNet ?? 0) >= 0;
  const unavailable = !isLoading && (isError || !latest);

  return (
    <div className="w-full max-w-[1100px] mx-auto px-3 md:px-6 py-4 md:py-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold text-foreground">Institutional flow</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Daily exchange cash-market activity in one view</p>
        </div>
        {latest && (
          <span className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wide ${
            netPositive ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"}`}>
            {netPositive ? "NET BUYING" : "NET SELLING"}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Fetching the latest report…
        </div>
      )}

      {unavailable && (
        <div className="rounded-2xl border border-border/60 bg-card px-5 py-8 text-center space-y-2">
          <div className="text-lg font-semibold text-foreground">Unavailable</div>
          <div className="text-xs text-muted-foreground max-w-md mx-auto">
            The latest FII/DII cash report could not be fetched right now
            {data?.reason ? <> (<span className="font-mono">{String(data.reason)}</span>)</> : null}.
            Nothing older is shown in its place.
          </div>
          <button onClick={() => refetch()} disabled={isFetching}
            className="text-[11px] text-primary hover:underline disabled:opacity-50">
            {isFetching ? "retrying…" : "try again"}
          </button>
        </div>
      )}

      {latest && (
        <>
          <div className="rounded-2xl bg-gradient-to-br from-indigo-900/70 to-indigo-950/70 border border-indigo-500/25 p-5 md:p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-widest text-indigo-200/70">Combined net flow</div>
                <div className={`text-3xl md:text-4xl font-bold tabular-nums mt-2 ${netPositive ? "text-emerald-300" : "text-rose-300"}`}>
                  {cr(latest.combinedNet, true)}
                </div>
                <div className="text-xs text-indigo-100/70 mt-2 max-w-xl">{data?.explanation}</div>
              </div>
              <div className="shrink-0 rounded-xl border border-indigo-400/25 bg-indigo-950/50 px-3 py-2 text-center">
                <div className="text-[9px] uppercase tracking-widest text-indigo-200/60">Official report</div>
                <div className="text-xs font-semibold text-indigo-100 mt-1">NSE</div>
                <div className="text-[10px] text-indigo-200/60 mt-1">Provisional · ₹ crore</div>
              </div>
            </div>
          </div>

          <div>
            <h2 className="text-base font-semibold text-foreground">Daily cash flow</h2>
            <p className="text-[11px] text-muted-foreground mb-3">{fmtDate(latest.date)} · provisional · ₹ crore</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CategoryCard title="FII / FPI" subtitle="Foreign institutions" side={latest.fii} />
              <CategoryCard title="DII" subtitle="Domestic institutions" side={latest.dii} />
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-card px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Combined cash</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">FII/FPI + DII</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-mono text-emerald-400 tabular-nums">{cr(latest.combinedBuy)} bought</span>
              <span className="text-sm font-mono text-rose-400 tabular-nums">{cr(latest.combinedSell)} sold</span>
              <span className={`text-sm font-mono font-bold tabular-nums ${netPositive ? "text-emerald-400" : "text-rose-400"}`}>
                {cr(latest.combinedNet, true)} net
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Simple explanation</div>
            <div className="text-sm text-foreground/90">{data?.explanation}</div>
          </div>

          <p className="text-[10px] text-muted-foreground">
            Source: {data?.source || "NSE"}. Provisional figures; the exchange may revise them.
          </p>
        </>
      )}
    </div>
  );
}

export default InstitutionalFlow;
