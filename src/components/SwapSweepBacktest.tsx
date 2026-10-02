import { useState } from "react";
import { Play, Info } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { detectSwapSweep, filterSwapSweep, backtestSwapSweep, ssStats, ssTime, ssIstDay, type SsTrade, type SsStats, type SsFilters } from "../lib/swapSweep";

// A REAL backtest of the Swap-Sweep Reversal on NIFTY 50 candles from the app's
// own history endpoint — the same candles the chart draws — using the same
// pattern definition as the chart indicator (lib/swapSweep). Measured in index
// points and R; the on-screen notes say exactly what is and is not modelled.

const TFS = [1, 3, 5, 15, 30, 60];
const RRS = [1, 1.5, 2, 3];
const fmtIst = (sec: number) => new Date(sec * 1000).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDay = (sec: number) => new Date(sec * 1000).toLocaleDateString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

export default function SwapSweepBacktest() {
  const [tf, setTf] = useState(5);
  const [rr, setRr] = useState(2);
  const [sameSession, setSameSession] = useState(true);
  const [sessionExit, setSessionExit] = useState(true);
  // Filters under test. Liquidity levels count if ANY ticked one is swept.
  const [fExtreme, setFExtreme] = useState(false);
  const [fDay, setFDay] = useState(false);
  const [fPrevDay, setFPrevDay] = useState(false);
  const [fDecisive, setFDecisive] = useState(false);
  const [fSkipOpen, setFSkipOpen] = useState(false);
  const [fTrend, setFTrend] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [costPts, setCostPts] = useState('0');
  // HOLD-OUT: the last 25 trading days are kept unseen while filters are chosen,
  // then checked once at the end. Tuning on all 105 days would find filters that
  // fit the past and fail going forward; this is how that gets caught.
  const [period, setPeriod] = useState<'in' | 'hold' | 'all'>('in');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<null | {
    tf: number; rr: number; first: number; last: number; days: number; candles: number;
    trades: SsTrade[]; stats: SsStats; byRr: { rr: number; s: SsStats }[];
    raw: SsStats; periodLabel: string; filtersOn: string[];
  }>(null);

  const run = async () => {
    setRunning(true); setErr(null); setRes(null);
    try {
      const r = await fetch(`/api/ta?timeframe=${tf}&token=256265&symbol=${encodeURIComponent('NIFTY 50')}`);
      const d = await r.json();
      const candles = (d?.candles || []).filter((c: any) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
      if (candles.length < 50) throw new Error('Not enough history came back — is the Kite session live?');
      const allSignals = detectSwapSweep(candles, { sameSession });
      // Period split by trading day: hold-out = the last 25, in-sample = the rest.
      const dayOf = (sec: number) => ssIstDay(sec);
      const dayList = Array.from(new Set(candles.map((c: any) => dayOf(ssTime(c.time))))).sort((a: any, b: any) => a - b) as number[];
      const hold = new Set(dayList.slice(-25));
      const inPeriod = (sig: { time: number }) => period === 'all' ? true : period === 'hold' ? hold.has(dayOf(sig.time)) : !hold.has(dayOf(sig.time));
      const filters: SsFilters = { extremeN: fExtreme ? 20 : 0, dayExtreme: fDay, prevDay: fPrevDay,
        decisiveClose: fDecisive, skipOpening: fSkipOpen, trendGuard: fTrend };
      const cost = Math.max(0, parseFloat(costPts) || 0);
      // RAW = the pattern alone (no filters, enter at C3's close); FILTERED = every
      // choice above. Same period, same costs — so the difference is the filters.
      const rawTrades = backtestSwapSweep(candles, allSignals.filter(inPeriod), { rr, sessionExit, costPts: cost });
      const signals = filterSwapSweep(candles, allSignals, filters).filter(inPeriod);
      const opt = { sessionExit, confirm, costPts: cost };
      const trades = backtestSwapSweep(candles, signals, { rr, ...opt });
      const inP = candles.filter((c: any) => inPeriod({ time: ssTime(c.time) }));
      const first = ssTime((inP[0] || candles[0]).time), last = ssTime((inP[inP.length - 1] || candles[candles.length - 1]).time);
      const days = new Set(inP.map((c: any) => dayOf(ssTime(c.time)))).size;
      const byRr = RRS.map((x) => ({ rr: x, s: ssStats(backtestSwapSweep(candles, signals, { rr: x, ...opt })) }));
      const filtersOn = [
        fExtreme && '20-candle extreme', fDay && "day's high/low", fPrevDay && 'PDH/PDL',
        fDecisive && 'decisive close', fSkipOpen && 'skip opening', fTrend && 'trend guard',
        confirm && 'confirmation entry',
      ].filter(Boolean) as string[];
      const periodLabel = period === 'in' ? `In-sample — the hold-out (last 25 days) is excluded`
        : period === 'hold' ? `HOLD-OUT — the last 25 trading days only` : `All data, including the hold-out`;
      setRes({ tf, rr, first, last, days, candles: inP.length, trades, stats: ssStats(trades), byRr,
               raw: ssStats(rawTrades), periodLabel, filtersOn });
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setRunning(false); }
  };

  let cum = 0;
  const curve = (res?.trades || []).map((t, i) => { cum += t.r; return { n: i + 1, r: +cum.toFixed(2) }; });
  const s = res?.stats;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const sel = "w-full bg-card border border-border rounded-lg py-2 px-3 text-xs text-foreground focus:outline-none focus:border-primary";

  return (
    <Card className="bg-card/60 border border-primary/40">
      <CardHeader>
        <CardTitle className="text-sm font-semibold tracking-wide text-foreground flex items-center gap-2">
          Swap-Sweep Reversal <span className="text-[10px] font-medium text-emerald-500 border border-emerald-500/40 rounded px-1.5 py-0.5">REAL NIFTY DATA</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">Timeframe
            <select value={tf} onChange={(e) => setTf(Number(e.target.value))} className={sel}>
              {TFS.map((x) => <option key={x} value={x}>{x < 60 ? `${x} min` : '1 hour'}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">Target
            <select value={rr} onChange={(e) => setRr(Number(e.target.value))} className={sel}>
              {RRS.map((x) => <option key={x} value={x}>{x}R (1:{x})</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground pt-5">
            <input type="checkbox" checked={sameSession} onChange={(e) => setSameSession(e.target.checked)} />
            Same-day candles only
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground pt-5">
            <input type="checkbox" checked={sessionExit} onChange={(e) => setSessionExit(e.target.checked)} />
            Exit at day's close
          </label>
        </div>
        <div className="rounded-lg border border-border p-3 space-y-2.5">
          <div className="text-xs font-semibold text-foreground">Filters to test</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">The sweep must take out real liquidity — any of these</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-1.5">
            {([
              [fExtreme, setFExtreme, 'A 20-candle high / low'],
              [fDay, setFDay, "The day's high / low so far"],
              [fPrevDay, setFPrevDay, "Yesterday's high / low (PDH/PDL)"],
            ] as const).map(([v, set, label]) => (
              <label key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {label}
              </label>
            ))}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground pt-1">And</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
            {([
              [fDecisive, setFDecisive, 'Decisive close — C3 closes in the far third of its range'],
              [fSkipOpen, setFSkipOpen, 'Skip the first 15 minutes (C3 before 9:30)'],
              [fTrend, setFTrend, 'Skip signals against a strong trend'],
              [confirm, setConfirm, 'Wait for confirmation — next candle breaks C3'],
            ] as const).map(([v, set, label]) => (
              <label key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {label}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <label className="space-y-1 text-xs text-muted-foreground">Costs per trade (index points)
              <input type="number" inputMode="decimal" min={0} step={0.5} value={costPts} onChange={(e) => setCostPts(e.target.value)} className={sel} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Period
              <select value={period} onChange={(e) => setPeriod(e.target.value as any)} className={sel}>
                <option value="in">In-sample (hold-out kept unseen)</option>
                <option value="hold">Hold-out — last 25 days</option>
                <option value="all">All data</option>
              </select>
            </label>
          </div>
          <div className="text-[10px] text-muted-foreground leading-relaxed">
            Choose filters on <b>In-sample</b>. Only when you have settled on a combination, run it <b>once</b> on the Hold-out:
            if it still holds up on days it was never tuned on, it is more likely real. Re-tuning after looking at the hold-out spoils it.
          </div>
        </div>

        <button onClick={run} disabled={running}
          className="w-full md:w-auto bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold py-2.5 px-6 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50">
          <Play className="w-3.5 h-3.5" /> {running ? 'Running on real candles…' : 'Run backtest'}
        </button>
        {err && <div className="text-xs text-rose-500">{err}</div>}

        {res && s && (
          <div className="space-y-4">
            <div className="text-[11px] text-muted-foreground">
              NIFTY 50 · {res.tf < 60 ? `${res.tf}-min` : '1-hour'} · {fmtDay(res.first)} – {fmtDay(res.last)} · {res.days} trading days · {res.candles.toLocaleString('en-IN')} candles
            </div>
            <div className={`text-[11px] font-semibold ${res.periodLabel.startsWith('HOLD') ? 'text-amber-600' : 'text-foreground/80'}`}>{res.periodLabel}</div>

            {/* RAW vs FILTERED, same period and costs: the difference IS the filters. */}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-[11px] font-mono">
                <thead><tr className="text-muted-foreground text-left border-b border-border">
                  <th className="py-1.5 px-2"></th><th className="px-2">Raw pattern</th><th className="px-2">Filtered</th>
                </tr></thead>
                <tbody>
                  {([
                    ['Trades', (x: SsStats) => `${x.trades}`],
                    ['Win rate', (x: SsStats) => pct(x.winRate)],
                    ['Avg per trade', (x: SsStats) => `${x.avgR >= 0 ? '+' : ''}${x.avgR.toFixed(2)}R`],
                    ['Total', (x: SsStats) => `${x.totalR >= 0 ? '+' : ''}${x.totalR.toFixed(1)}R`],
                    ['Profit factor', (x: SsStats) => x.profitFactor === null ? '∞' : x.profitFactor.toFixed(2)],
                    ['Worst losing run', (x: SsStats) => `${x.maxLossStreak}`],
                  ] as const).map(([k, fmt]) => (
                    <tr key={k} className="border-t border-border/40">
                      <td className="py-1 px-2 text-muted-foreground">{k}</td>
                      <td className="px-2 text-muted-foreground">{fmt(res.raw)}</td>
                      <td className="px-2 text-foreground font-semibold">{fmt(s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[10px] text-muted-foreground">
              Filters: {res.filtersOn.length ? res.filtersOn.join(' · ') : 'none — both columns are the raw pattern'}
            </div>
            {s.trades < 30 && (
              <div className="text-[11px] rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 px-2.5 py-1.5">
                Only {s.trades} trade{s.trades === 1 ? '' : 's'} — too few to tell an edge from luck. Use a shorter timeframe or fewer filters before drawing conclusions.
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Signals traded', `${s.trades}`, `${s.bull} bull · ${s.bear} bear`],
                ['Win rate', pct(s.winRate), `${s.wins} target · ${s.losses} stop · ${s.timeExits} day-close`],
                ['Average per trade', `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R`, `total ${s.totalR >= 0 ? '+' : ''}${s.totalR.toFixed(1)}R`],
                ['Profit factor', s.profitFactor === null ? '∞' : s.profitFactor.toFixed(2), `worst losing run: ${s.maxLossStreak}`],
              ].map(([k, v, sub]) => (
                <div key={k} className="rounded-lg border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
                  <div className="text-xl font-mono font-bold text-foreground">{v}</div>
                  <div className="text-[10px] text-muted-foreground">{sub}</div>
                </div>
              ))}
            </div>

            {curve.length > 1 && (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={curve}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                    <XAxis dataKey="n" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} unit="R" />
                    <Tooltip formatter={(v: any) => [`${v}R`, 'Cumulative']} labelFormatter={(l) => `Trade ${l}`} />
                    <ReferenceLine y={0} strokeOpacity={0.4} />
                    <Area type="monotone" dataKey="r" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.15} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            <div>
              <div className="text-xs font-semibold text-foreground mb-1.5">Same signals, other targets</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead><tr className="text-muted-foreground text-left">
                    <th className="py-1 pr-3">Target</th><th className="pr-3">Win rate</th><th className="pr-3">Avg R</th><th className="pr-3">Total R</th><th>Profit factor</th>
                  </tr></thead>
                  <tbody>{res.byRr.map(({ rr: x, s: t }) => (
                    <tr key={x} className={x === res.rr ? 'text-foreground font-bold' : 'text-muted-foreground'}>
                      <td className="py-1 pr-3">{x}R</td><td className="pr-3">{pct(t.winRate)}</td>
                      <td className="pr-3">{t.avgR >= 0 ? '+' : ''}{t.avgR.toFixed(2)}</td>
                      <td className="pr-3">{t.totalR >= 0 ? '+' : ''}{t.totalR.toFixed(1)}</td>
                      <td>{t.profitFactor === null ? '∞' : t.profitFactor.toFixed(2)}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-foreground mb-1.5">Most recent 25 trades</div>
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead><tr className="text-muted-foreground text-left">
                    <th className="py-1 pr-3">Signal (IST)</th><th className="pr-3">Side</th><th className="pr-3">Entry</th><th className="pr-3">Stop</th><th className="pr-3">Exit</th><th>Result</th>
                  </tr></thead>
                  <tbody>{res.trades.slice(-25).reverse().map((t, i) => (
                    <tr key={i} className="border-t border-border/40">
                      <td className="py-1 pr-3">{fmtIst(t.time)}</td>
                      <td className={`pr-3 ${t.kind === 'bull' ? 'text-emerald-500' : 'text-rose-500'}`}>{t.kind === 'bull' ? 'LONG' : 'SHORT'}</td>
                      <td className="pr-3">{t.entry.toFixed(2)}</td><td className="pr-3">{t.stop.toFixed(2)}</td><td className="pr-3">{t.exit.toFixed(2)}</td>
                      <td className={t.r > 0 ? 'text-emerald-500' : t.r < 0 ? 'text-rose-500' : 'text-muted-foreground'}>
                        {t.outcome === 'TIME' ? 'day close ' : ''}{t.r >= 0 ? '+' : ''}{t.r.toFixed(2)}R
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2 text-[10px] text-muted-foreground leading-relaxed border-t border-border pt-3">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>
            How it is measured: entry at C3's close; stop beyond the sweep (C3's high for a short, C3's low for a long); target = risk × the chosen R.
            Whichever is touched first decides it — if both fall inside one candle it is counted as a <b>loss</b>, since the order inside a candle is unknown.
            Results are on the <b>NIFTY index in points</b>: brokerage, slippage and option premium effects (theta, IV) are not included, and expired option contracts'
            history is not available from Zerodha to test premiums directly. Each signal is measured on its own. The history window is what the app holds:
            about 100 days at 5-min, 150 at 15-min and above.
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
