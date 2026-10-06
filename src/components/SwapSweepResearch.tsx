import { useEffect, useRef, useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

// Swap-Sweep filter research: does any simple filter remove the 5m + 15m signals
// that fail? Runs on the server over ~2 years of NIFTY (see src/lib/ssResearch.ts
// for the rules, all fixed before any result was seen). Filters are judged on the
// first 70% of days; only the chosen one is checked, once, on the last 30%.

type Row = { trades: number; winRate: number; avgR: number; totalR: number; profitFactor: number | null; luck: number; maxLossStreak: number };
type Res = {
  generatedAt: number; config: { rr: number; costPts: number; minN: number; minHoldN: number };
  period: { from: string; to: string; days: number; holdoutFrom: string; signals: number };
  filters: { key: string; label: string; rule: string; inSample: Row; eligible: boolean }[];
  combo: { label: string; row: Row } | null;
  chosen: { key: string; label: string; inSample: Row } | null;
  holdout: { baseline: Row; chosen: Row | null };
  verdict: 'PASS' | 'NOT_PROVEN' | 'NONE_BETTER';
};

const sgn = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}R`;
const fmtWhen = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

export default function SwapSweepResearch() {
  const [res, setRes] = useState<Res | null>(null);
  const [job, setJob] = useState<{ status: string; progress: string; error: string | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<any>(null);

  const poll = async () => {
    try {
      const r = await fetch('/api/ss/research/status'); const j = await r.json();
      setJob(j.job); if (j.result) setRes(j.result);
      if (j.job?.status === 'running') timer.current = setTimeout(poll, 3000);
    } catch (e) { timer.current = setTimeout(poll, 5000); }
  };
  useEffect(() => { poll(); return () => clearTimeout(timer.current); }, []);
  const start = async () => {
    clearTimeout(timer.current);
    setJob({ status: 'running', progress: 'starting…', error: null });
    try { await fetch('/api/ss/research/start', { method: 'POST' }); } catch (e) {}
    timer.current = setTimeout(poll, 1500);
  };
  const running = job?.status === 'running';
  const base = res?.filters.find((f) => f.key === 'baseline')?.inSample;

  const cell = (r: Row, bold?: boolean) => (
    <>
      <td className={`py-1.5 pr-2 text-right tabular-nums ${bold ? 'font-semibold' : ''}`}>{r.trades}</td>
      <td className={`py-1.5 pr-2 text-right tabular-nums ${bold ? 'font-semibold' : ''}`}>{r.winRate.toFixed(1)}%</td>
      <td className={`py-1.5 pr-2 text-right tabular-nums ${r.avgR > 0 ? 'text-emerald-500' : r.avgR < 0 ? 'text-red-500' : ''} ${bold ? 'font-semibold' : ''}`}>{sgn(r.avgR)}</td>
      <td className="py-1.5 text-right tabular-nums text-muted-foreground">±{r.luck.toFixed(2)}</td>
    </>
  );

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <FlaskConical className="w-5 h-5 text-primary" /> Swap-Sweep filter research
          <span className="text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded border border-emerald-500/50 text-emerald-500">2 YEARS · REAL NIFTY</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Can a simple filter remove the 5m + 15m signals that fail? Every filter below was fixed <b>before</b> any result was seen.
          Each is judged on the first 70% of about two years; only the best one is then checked <b>once</b> on the last 30%, which it was never chosen on.
          Same-day candles, stop beyond the 5-min sweep, 2R target, exit by day's close, {res?.config.costPts ?? 2} points cost per trade.
        </p>
        <button onClick={start} disabled={running}
          className="w-full h-11 rounded-full bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
          {running ? <><Loader2 className="w-4 h-4 animate-spin" /> {job?.progress || 'running…'}</> : (res ? 'Run again on the latest data' : 'Run the research (about 30 seconds)')}
        </button>
        {job?.status === 'error' && <div className="text-red-500 text-xs">Failed: {job.error}</div>}

        {res && base && (
          <>
            <div className="text-xs text-muted-foreground">
              NIFTY 50 · {res.period.from} – {res.period.to} · {res.period.days} trading days · {res.period.signals} signals · hold-out from {res.period.holdoutFrom} · run {fmtWhen(res.generatedAt)}
            </div>

            <div>
              <div className="font-semibold mb-1">Step 1 · Each filter on the first 70% (choosing period)</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1.5 pr-2 font-medium">Filter</th><th className="text-right pr-2 font-medium">Trades</th>
                    <th className="text-right pr-2 font-medium">Win</th><th className="text-right pr-2 font-medium">Avg</th><th className="text-right font-medium">Luck ±</th>
                  </tr></thead>
                  <tbody>
                    {res.filters.map((f) => (
                      <tr key={f.key} onClick={() => setOpen(open === f.key ? null : f.key)}
                        className={`border-b border-border/50 cursor-pointer ${res.chosen?.key === f.key ? 'bg-primary/10' : ''} ${!f.eligible && f.key !== 'baseline' ? 'opacity-60' : ''}`}>
                        <td className="py-1.5 pr-2">
                          {f.label}{res.chosen?.key === f.key ? ' ★' : ''}{!f.eligible && f.key !== 'baseline' ? ' (too few)' : ''}
                          {open === f.key && <div className="text-[11px] text-muted-foreground mt-0.5">{f.rule}</div>}
                        </td>
                        {cell(f.inSample, f.key === 'baseline')}
                      </tr>
                    ))}
                    {res.combo && (
                      <tr className={`border-b border-border/50 ${res.chosen?.key === 'combo' ? 'bg-primary/10' : ''}`}>
                        <td className="py-1.5 pr-2">{res.combo.label}{res.chosen?.key === 'combo' ? ' ★' : ''}<div className="text-[11px] text-muted-foreground">best two combined</div></td>
                        {cell(res.combo.row)}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Tap a filter for its exact rule. "Luck ±": a result inside this range of the baseline could be chance. A filter needs at least {res.config.minN} trades to be chosen.
              </p>
            </div>

            <div>
              <div className="font-semibold mb-1">Step 2 · The chosen filter on the last 30% (never used for choosing)</div>
              {res.chosen && res.holdout.chosen ? (
                <table className="w-full text-xs">
                  <thead><tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-1.5 pr-2 font-medium"></th><th className="text-right pr-2 font-medium">Trades</th>
                    <th className="text-right pr-2 font-medium">Win</th><th className="text-right pr-2 font-medium">Avg</th><th className="text-right font-medium">Luck ±</th>
                  </tr></thead>
                  <tbody>
                    <tr className="border-b border-border/50"><td className="py-1.5 pr-2">No filter</td>{cell(res.holdout.baseline)}</tr>
                    <tr className="border-b border-border/50 bg-primary/10"><td className="py-1.5 pr-2">{res.chosen.label} ★</td>{cell(res.holdout.chosen, true)}</tr>
                  </tbody>
                </table>
              ) : <div className="text-xs text-muted-foreground">No filter beat "no filter" on the choosing period, so there was nothing to check.</div>}
            </div>

            <div className={`rounded-lg border px-3 py-2 text-xs ${res.verdict === 'PASS' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600' : 'border-amber-500/40 bg-amber-500/10 text-amber-600'}`}>
              {res.verdict === 'PASS' && <><b>Passed.</b> "{res.chosen?.label}" beat no-filter on both win rate and average R on days it was never chosen on, and stayed profitable after costs. Worth adding to the chart as an option — then watch it live before trusting it with size.</>}
              {res.verdict === 'NOT_PROVEN' && <><b>Not proven.</b> "{res.chosen?.label}" looked best on the choosing period but did not beat no-filter on both win rate and average R (with a profit after costs) on the unseen days. That is what a filter that only fitted past noise looks like — do not add it.</>}
              {res.verdict === 'NONE_BETTER' && <><b>No filter helped.</b> None of the fixed filters did better than no filter on the choosing period.</>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
