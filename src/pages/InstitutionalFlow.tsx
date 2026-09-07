import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, TrendingUp, TrendingDown } from "lucide-react";

// ============================================================================
// INSTITUTIONAL FLOW — daily FII/FPI and DII cash-market activity in ₹ crore.
// Laid out to Martin's reference: a combined headline, the two categories side
// by side with buy/sell bars, a combined line, a plain-English reading, then
// every trading day captured so far.
//
// Every figure here is NSE's own published report, provisional after the close
// and occasionally revised. Nothing is computed beyond the sums, and the source
// and provisional status are stated on screen rather than left implied.
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

/** Same reading the server gives, computed here so every SELECTED day gets one. */
function explainDay(d: FlowDay): string {
  const fiiBuying = d.fii.net >= 0, diiBuying = d.dii.net >= 0;
  const c = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (fiiBuying && diiBuying) return "Both foreign and domestic institutions were net buyers.";
  if (!fiiBuying && !diiBuying) return "Both foreign and domestic institutions were net sellers.";
  if (!fiiBuying && diiBuying) {
    return d.combinedNet >= 0
      ? `FIIs sold ${c(d.fii.net)}, but stronger DII buying kept the combined institutional flow positive.`
      : `DIIs bought ${c(d.dii.net)}, but heavier FII selling left the combined flow negative.`;
  }
  return d.combinedNet >= 0
    ? `DIIs sold ${c(d.dii.net)}, but stronger FII buying kept the combined institutional flow positive.`
    : `FIIs bought ${c(d.fii.net)}, but heavier DII selling left the combined flow negative.`;
}

/** Buy and sell as proportional bars — the shape of the day at a glance. */
function FlowBars({ buy, sell }: { buy: number; sell: number }) {
  const max = Math.max(buy, sell, 1);
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 rounded-full bg-emerald-500/15 overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(buy / max) * 100}%` }} />
      </div>
      <div className="h-1.5 rounded-full bg-rose-500/15 overflow-hidden">
        <div className="h-full bg-rose-500 rounded-full transition-all" style={{ width: `${(sell / max) * 100}%` }} />
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
      const r = await fetch("/api/institutional-flow?days=60");
      if (!r.ok) throw new Error("request failed");
      return r.json();
    },
    // Published once after the close, so there is nothing to gain from polling.
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const history: FlowDay[] = data?.history || [];
  // The five most recent trading days are the picker; whichever is chosen is
  // the day the whole card describes. Defaults to the latest, and re-anchors to
  // it when a newer day arrives so the screen never opens on yesterday.
  const recent = history.slice(0, 5);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  useEffect(() => {
    if (!history.length) return;
    if (!selectedDate || !history.some((d) => d.date === selectedDate)) setSelectedDate(history[0].date);
  }, [history.length, history[0]?.date]);
  const latest: FlowDay | null = history.find((d) => d.date === selectedDate) || data?.latest || null;
  const isLatest = !!latest && history[0]?.date === latest.date;
  const netPositive = (latest?.combinedNet ?? 0) >= 0;

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
          <Loader2 className="w-4 h-4 animate-spin" /> Loading institutional flow…
        </div>
      )}

      {/* A failed FETCH and a failed SOURCE are different situations and say so.
          History still renders below either way, so a blocked feed means "no new
          day" rather than an empty screen. */}
      {!isLoading && (isError || (data && data.success === false)) && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
          Could not load institutional flow{data?.error ? `: ${data.error}` : "."}
        </div>
      )}
      {!isLoading && data?.reason && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300/90">
          Latest day unavailable from NSE ({data.reason}). Showing what has been captured so far.
        </div>
      )}

      {recent.length > 0 && (
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-1 px-1">
          {recent.map((d) => {
            const active = d.date === selectedDate;
            const pos = d.combinedNet >= 0;
            return (
              <button key={d.date} onClick={() => setSelectedDate(d.date)}
                className={`shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
                  active ? "border-primary bg-primary/15" : "border-border/60 bg-card hover:bg-muted/40"}`}>
                <div className={`text-[11px] font-mono ${active ? "text-foreground" : "text-muted-foreground"}`}>{fmtDate(d.date)}</div>
                <div className={`text-xs font-mono font-bold tabular-nums ${pos ? "text-emerald-400" : "text-rose-400"}`}>{cr(d.combinedNet, true)}</div>
              </button>
            );
          })}
        </div>
      )}

      {latest && (
        <>
          {/* Headline */}
          <div className="rounded-2xl bg-gradient-to-br from-indigo-900/70 to-indigo-950/70 border border-indigo-500/25 p-5 md:p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-widest text-indigo-200/70">Combined net flow</div>
                <div className={`text-3xl md:text-4xl font-bold tabular-nums mt-2 ${netPositive ? "text-emerald-300" : "text-rose-300"}`}>
                  {cr(latest.combinedNet, true)}
                </div>
                <div className="text-xs text-indigo-100/70 mt-2 max-w-xl">{explainDay(latest)}</div>
              </div>
              <div className="shrink-0 rounded-xl border border-indigo-400/25 bg-indigo-950/50 px-3 py-2 text-center">
                <div className="text-[9px] uppercase tracking-widest text-indigo-200/60">Official report</div>
                <div className="text-xs font-semibold text-indigo-100 mt-1">NSE</div>
                <div className="text-[10px] text-indigo-200/60 mt-1">Provisional · ₹ crore</div>
              </div>
            </div>
          </div>

          {/* The day */}
          <div>
            <h2 className="text-base font-semibold text-foreground">Daily cash flow</h2>
            <p className="text-[11px] text-muted-foreground mb-3">
              {fmtDate(latest.date)}{isLatest ? " · latest" : ""} · provisional · ₹ crore
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CategoryCard title="FII / FPI" subtitle="Foreign institutions" side={latest.fii} />
              <CategoryCard title="DII" subtitle="Domestic institutions" side={latest.dii} />
            </div>
          </div>

          {/* Combined */}
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

          {/* Reading */}
          <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Simple explanation</div>
            <div className="text-sm text-foreground/90">{explainDay(latest)}</div>
          </div>
        </>
      )}

      {/* Every day captured so far. NSE serves only the latest, so this fills in
          one trading day at a time from the moment the screen first ran. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-foreground">Every trading day</h2>
          <button onClick={() => refetch()} disabled={isFetching}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
            {isFetching ? "refreshing…" : "refresh"}
          </button>
        </div>
        {history.length === 0 && !isLoading ? (
          <div className="rounded-xl border border-border/60 bg-card px-4 py-6 text-center text-xs text-muted-foreground">
            No days captured yet. NSE publishes this after the close, so the first row appears this evening.
          </div>
        ) : (
          <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
                    <th className="text-left font-medium px-3 py-2">Date</th>
                    <th className="text-right font-medium px-3 py-2">FII net</th>
                    <th className="text-right font-medium px-3 py-2">DII net</th>
                    <th className="text-right font-medium px-3 py-2">Combined</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((d) => (
                    <tr key={d.date} onClick={() => { setSelectedDate(d.date); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                        className={`border-b border-border/40 last:border-0 hover:bg-muted/40 transition-colors cursor-pointer ${d.date === selectedDate ? "bg-primary/10" : ""}`}>
                      <td className="px-3 py-2 font-mono text-foreground/80 whitespace-nowrap">{fmtDate(d.date)}</td>
                      <td className={`px-3 py-2 text-right font-mono tabular-nums ${d.fii.net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{cr(d.fii.net, true)}</td>
                      <td className={`px-3 py-2 text-right font-mono tabular-nums ${d.dii.net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{cr(d.dii.net, true)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-bold tabular-nums ${d.combinedNet >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        <span className="inline-flex items-center gap-1 justify-end">
                          {d.combinedNet >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                          {cr(d.combinedNet, true)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground mt-2">
          Source: {data?.source || "NSE cash-market report"}. Figures are provisional and may be revised by the exchange.
        </p>
      </div>
    </div>
  );
}

export default InstitutionalFlow;
