import { useState } from "react";
import { Play, Info } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { detectSwapSweep, backtestSwapSweep, backtestEntries, breakEntries, confluenceSwapSweep, ssStats, ssTime, ssIstDay, type SsTrade, type SsStats } from "../lib/swapSweep";

// A REAL backtest of the Swap-Sweep Reversal on NIFTY 50 candles from the app's
// own history endpoint — the same candles the chart draws — using the same
// pattern definition as the chart indicator (lib/swapSweep). Measured in index
// points and R; the on-screen notes say exactly what is and is not modelled.
// Only Martin's three-candle rules are tested: no filters, no second pattern.
// Two modes: the pattern on one timeframe, or on 5-min AND 15-min together — a
// trade only when both show a signal in the same direction at the same time.
// On one timeframe the entry can be at the signal candle's close (original) or a
// pending order at its high / low with the stop at its midpoint.

const TFS = [1, 3, 5, 15, 30, 60];
const RRS = [1, 1.5, 2, 3];
const fmtIst = (sec: number) => new Date(sec * 1000).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDay = (sec: number) => new Date(sec * 1000).toLocaleDateString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

// One order lifetime's results: the cautious figures (a fill candle that also reaches
// the stop counts as a loss), how many fills that applies to, and the optimistic
// figures (those fills are assumed to survive). The truth lies between the two.
type BrkWin = { s: SsStats; opt: SsStats; amb: number };

export default function SwapSweepBacktest() {
  const [mode, setMode] = useState<'single' | 'both'>('single');
  const [stopMode, setStopMode] = useState<'15' | '5'>('15');
  // Entry style (one timeframe only): at the signal candle's close, or a pending
  // order at its high (bull) / low (bear) with the stop at its midpoint; and how
  // many candles that order stays live.
  const [entryMode, setEntryMode] = useState<'close' | 'break'>('close');
  const [validFor, setValidFor] = useState<'1' | '3' | 'day'>('3');   // confluence only: whose sweep the stop sits beyond
  const [tf, setTf] = useState(5);
  const [rr, setRr] = useState(2);
  const [sameSession, setSameSession] = useState(true);
  const [sessionExit, setSessionExit] = useState(true);
  const [costPts, setCostPts] = useState('0');
  // HOLD-OUT: the last 25 trading days are kept unseen while the timeframe and
  // target are chosen, then checked once at the end. Tuning on all the days finds
  // settings that fit the past and fail going forward; this is how that gets caught.
  const [period, setPeriod] = useState<'in' | 'hold' | 'all'>('in');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<null | {
    tf: number; rr: number; first: number; last: number; days: number; candles: number;
    trades: SsTrade[]; stats: SsStats; byRr: { rr: number; s: SsStats }[]; periodLabel: string;
    tfLabel: string;
    conf: null | { five: SsStats; fifteen: SsStats; stop: '15' | '5' };   // set only in the 5 + 15 mode
    brk: null | { original: SsStats; one: BrkWin; three: BrkWin; day: BrkWin; valid: '1' | '3' | 'day' };   // set only for break entry
  }>(null);

  const run = async () => {
    setRunning(true); setErr(null); setRes(null);
    try {
      const fetchCandles = async (t: number) => {
        const r = await fetch(`/api/ta?timeframe=${t}&token=256265&symbol=${encodeURIComponent('NIFTY 50')}`);
        const d = await r.json();
        return (d?.candles || []).filter((c: any) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
      };
      const dayOf = (sec: number) => ssIstDay(sec);
      const cost = Math.max(0, parseFloat(costPts) || 0);
      // Period split by trading day: hold-out = the last 25, in-sample = the rest.
      // Cut from the series the trades are scanned on.
      const periodOf = (candles: any[]) => {
        const dayList = Array.from(new Set(candles.map((c: any) => dayOf(ssTime(c.time))))).sort((a: any, b: any) => a - b) as number[];
        const hold = new Set(dayList.slice(-25));
        return (sig: { time: number }) => period === 'all' ? true : period === 'hold' ? hold.has(dayOf(sig.time)) : !hold.has(dayOf(sig.time));
      };
      const periodLabel = period === 'in' ? `In-sample — the hold-out (last 25 days) is excluded`
        : period === 'hold' ? `HOLD-OUT — the last 25 trading days only` : `All data, including the hold-out`;
      const opt = { sessionExit, costPts: cost };

      if (mode === 'both') {
        // 5-min + 15-min together. The 5-min history is the shorter of the two, so
        // only the days it covers are tested; every trade is then simulated on the
        // 5-min candles, so a stop and a target inside one 15-min bar are ordered
        // properly instead of defaulting to a loss.
        const c5 = await fetchCandles(5);
        const all15 = await fetchCandles(15);
        if (c5.length < 50 || all15.length < 50) throw new Error('Not enough history came back — is the Kite session live?');
        const firstDay = dayOf(ssTime(c5[0].time));
        const c15 = all15.filter((c: any) => dayOf(ssTime(c.time)) >= firstDay);
        const C = confluenceSwapSweep(c5, c15, { sameSession, stop: stopMode });
        const inPeriod = periodOf(c5);
        const run1 = (list: typeof C.both, x = rr) => backtestEntries(c5, list.filter(inPeriod), { rr: x, ...opt });
        const trades = run1(C.both);
        const inP = c5.filter((c: any) => inPeriod({ time: ssTime(c.time) }));
        const first = ssTime((inP[0] || c5[0]).time), last = ssTime((inP[inP.length - 1] || c5[c5.length - 1]).time);
        const days = new Set(inP.map((c: any) => dayOf(ssTime(c.time)))).size;
        setRes({ tf: 5, rr, first, last, days, candles: inP.length, trades, stats: ssStats(trades),
                 byRr: RRS.map((x) => ({ rr: x, s: ssStats(run1(C.both, x)) })), periodLabel,
                 tfLabel: '5-min + 15-min together',
                 conf: { five: ssStats(run1(C.five)), fifteen: ssStats(run1(C.fifteen)), stop: stopMode }, brk: null });
        return;
      }

      const candles = await fetchCandles(tf);
      if (candles.length < 50) throw new Error('Not enough history came back — is the Kite session live?');
      const allSignals = detectSwapSweep(candles, { sameSession });
      const inPeriod = periodOf(candles);
      const signals = allSignals.filter(inPeriod);
      const inP = candles.filter((c: any) => inPeriod({ time: ssTime(c.time) }));
      const first = ssTime((inP[0] || candles[0]).time), last = ssTime((inP[inP.length - 1] || candles[candles.length - 1]).time);
      const days = new Set(inP.map((c: any) => dayOf(ssTime(c.time)))).size;
      const tfName = tf < 60 ? `${tf}-min` : '1-hour';

      if (entryMode === 'break') {
        // Pending order at the signal candle's high / low, stop at its midpoint.
        // The original close-entry and all three order lifetimes are computed on the
        // same signals, target and costs, so they compare directly.
        const listB = (v: number) => breakEntries(candles, signals, { validFor: v });
        const runB = (v: number, x = rr) => backtestEntries(candles, listB(v), { rr: x, ...opt });
        const win = (v: number): BrkWin => {
          const list = listB(v);
          return {
            s: ssStats(backtestEntries(candles, list, { rr, ...opt })),
            // Optimistic bound: where the fill candle also reached the stop and the order
            // of events is unknown, assume the stop came BEFORE the fill, i.e. scan from
            // the next candle instead of from the fill candle.
            opt: ssStats(backtestEntries(candles, list.map((e) => e.amb ? { ...e, idx: e.idx + 1 } : e), { rr, ...opt })),
            amb: list.filter((e) => e.amb).length,
          };
        };
        const vf = validFor === 'day' ? Infinity : Number(validFor);
        const trades = runB(vf);
        setRes({ tf, rr, first, last, days, candles: inP.length, trades, stats: ssStats(trades),
                 byRr: RRS.map((x) => ({ rr: x, s: ssStats(runB(vf, x)) })), periodLabel,
                 tfLabel: `${tfName} · break entry`, conf: null,
                 brk: { original: ssStats(backtestSwapSweep(candles, signals, { rr, ...opt })),
                        one: win(1), three: win(3), day: win(Infinity), valid: validFor } });
        return;
      }

      const trades = backtestSwapSweep(candles, signals, { rr, ...opt });
      const byRr = RRS.map((x) => ({ rr: x, s: ssStats(backtestSwapSweep(candles, signals, { rr: x, ...opt })) }));
      setRes({ tf, rr, first, last, days, candles: inP.length, trades, stats: ssStats(trades), byRr, periodLabel,
               tfLabel: tfName, conf: null, brk: null });
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
        <label className="block space-y-1 text-xs text-muted-foreground">Test
          <select value={mode} onChange={(e) => { setMode(e.target.value as any); setRes(null); }} className={sel}>
            <option value="single">One timeframe — the pattern on its own</option>
            <option value="both">5-min + 15-min together — trade only when both show a signal</option>
          </select>
        </label>
        {mode === 'single' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1 text-xs text-muted-foreground">Entry
              <select value={entryMode} onChange={(e) => { setEntryMode(e.target.value as any); setRes(null); }} className={sel}>
                <option value="close">At the signal candle's close — stop beyond its extreme</option>
                <option value="break">On a break — entry at its high (long) / low (short), stop at its midpoint</option>
              </select>
            </label>
            {entryMode === 'break' && (
              <label className="space-y-1 text-xs text-muted-foreground">Entry order valid for
                <select value={validFor} onChange={(e) => setValidFor(e.target.value as any)} className={sel}>
                  <option value="1">The next candle only</option>
                  <option value="3">The next 3 candles</option>
                  <option value="day">The rest of that day</option>
                </select>
              </label>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {mode === 'single' ? (
            <label className="space-y-1 text-xs text-muted-foreground">Timeframe
              <select value={tf} onChange={(e) => setTf(Number(e.target.value))} className={sel}>
                {TFS.map((x) => <option key={x} value={x}>{x < 60 ? `${x} min` : '1 hour'}</option>)}
              </select>
            </label>
          ) : (
            <label className="space-y-1 text-xs text-muted-foreground">Stop beyond
              <select value={stopMode} onChange={(e) => setStopMode(e.target.value as any)} className={sel}>
                <option value="15">The 15-min sweep (wider)</option>
                <option value="5">The 5-min sweep (tighter)</option>
              </select>
            </label>
          )}
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
          Choose the timeframe and target on <b>In-sample</b>. Only when you have settled on them, run it <b>once</b> on the Hold-out:
          if it still holds up on days it was never tuned on, it is more likely real. Re-tuning after looking at the hold-out spoils it.
        </div>

        <button onClick={run} disabled={running}
          className="w-full md:w-auto bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold py-2.5 px-6 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50">
          <Play className="w-3.5 h-3.5" /> {running ? 'Running on real candles…' : 'Run backtest'}
        </button>
        {err && <div className="text-xs text-rose-500">{err}</div>}

        {res && s && (
          <div className="space-y-4">
            <div className="text-[11px] text-muted-foreground">
              <b className="text-foreground">{res.tfLabel}</b> · NIFTY 50 · {fmtDay(res.first)} – {fmtDay(res.last)} · {res.days} trading days · {res.candles.toLocaleString('en-IN')} candles
            </div>
            <div className={`text-[11px] font-semibold ${res.periodLabel.startsWith('HOLD') ? 'text-amber-600' : 'text-foreground/80'}`}>{res.periodLabel}</div>
            {res.conf && (
              <div className="text-[11px] text-muted-foreground">
                The 5-minute history is the shorter of the two, so only the days it covers are tested. Entry is at the close of the 15-min candle
                that completes the signal; every trade is simulated on 5-min candles.
              </div>
            )}
            {s.trades < 30 && (
              <div className="text-[11px] rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 px-2.5 py-1.5">
                Only {s.trades} trade{s.trades === 1 ? '' : 's'} — too few to tell an edge from luck.{' '}
                {res.conf ? 'Both timeframes agreeing is rare and the 5-minute history is short, so treat this as a first look only.' : 'Use a shorter timeframe or more days before drawing conclusions.'}
              </div>
            )}
            {res.brk && (
              <div>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-[11px] font-mono">
                    <thead><tr className="text-muted-foreground text-left border-b border-border">
                      <th className="py-1.5 px-2"></th><th className="px-2">Enter at close</th>
                      {([['1', 'Break · 1 candle'], ['3', 'Break · 3 candles'], ['day', 'Break · day']] as const).map(([k, label]) => (
                        <th key={k} className={`px-2 ${res.brk!.valid === k ? 'text-foreground' : ''}`}>{label}</th>
                      ))}
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
                          <td className="px-2 text-muted-foreground">{fmt(res.brk!.original)}</td>
                          {(['1', '3', 'day'] as const).map((v) => (
                            <td key={v} className={`px-2 ${res.brk!.valid === v ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>
                              {fmt((v === '1' ? res.brk!.one : v === '3' ? res.brk!.three : res.brk!.day).s)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      <tr className="border-t border-border bg-muted/30">
                        <td className="py-1 px-2 text-muted-foreground">Fills, order unknown</td>
                        <td className="px-2 text-muted-foreground">—</td>
                        {(['1', '3', 'day'] as const).map((v) => {
                          const w = v === '1' ? res.brk!.one : v === '3' ? res.brk!.three : res.brk!.day;
                          return <td key={v} className={`px-2 ${res.brk!.valid === v ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>{w.amb} of {w.s.trades}</td>;
                        })}
                      </tr>
                      <tr className="border-t border-border/40 bg-muted/30">
                        <td className="py-1 px-2 text-muted-foreground">Avg if those survive</td>
                        <td className="px-2 text-muted-foreground">—</td>
                        {(['1', '3', 'day'] as const).map((v) => {
                          const w = v === '1' ? res.brk!.one : v === '3' ? res.brk!.three : res.brk!.day;
                          return <td key={v} className={`px-2 ${res.brk!.valid === v ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>{w.opt.avgR >= 0 ? '+' : ''}{w.opt.avgR.toFixed(2)}R</td>;
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                  Same signals, days, target and costs in every column; the bold column feeds the figures below. Break entry = a pending order at the signal
                  candle's high (long) or low (short), stop at its midpoint, so the risk is half its range. <b>Read the last two rows together:</b> a fill candle is
                  often large and also reaches the stop, and a candle's inner order of events is not in the data. The main figures count those fills as
                  <b> losses</b> (cautious); the last row shows the result if they all survived. The real answer lies between the two.
                </div>
              </div>
            )}
            {res.conf && (
              <div>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-[11px] font-mono">
                    <thead><tr className="text-muted-foreground text-left border-b border-border">
                      <th className="py-1.5 px-2"></th><th className="px-2">5-min alone</th><th className="px-2">15-min alone</th><th className="px-2 text-foreground">Both agree</th>
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
                          <td className="px-2 text-muted-foreground">{fmt(res.conf!.five)}</td>
                          <td className="px-2 text-muted-foreground">{fmt(res.conf!.fifteen)}</td>
                          <td className="px-2 text-foreground font-semibold">{fmt(s)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Same days, target and costs in every column. The 5-min column uses the 5-min sweep for its stop; 15-min alone uses the 15-min sweep;
                  Both uses the {res.conf.stop === '15' ? '15-min' : '5-min'} sweep. The question is whether Both beats each alone.
                </div>
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
            {mode === 'single' && entryMode === 'break'
              ? "How it is measured: when the signal candle closes, a stop order is placed at its high (long) or low (short). It fills on the first candle within the chosen window that trades through that level — at the level, or at the candle's open if it gapped through — and no fill means no trade; it never carries overnight. The stop is the candle's midpoint, so the risk is half its range; target = risk × the chosen R. A fill candle that also touches the stop is counted as a loss."
              : mode === 'both'
              ? "How it is measured: a 15-min signal counts when a same-direction 5-min signal has its own C3 inside that 15-min candle, so both are known when it closes; entry at that close; stop beyond the sweep you chose; target = risk × the chosen R."
              : "How it is measured: entry at C3's close; stop beyond the sweep (C3's high for a short, C3's low for a long); target = risk × the chosen R."}
            Whichever is touched first decides it — if both fall inside one candle it is counted as a <b>loss</b>, since the order inside a candle is unknown.
            Results are on the <b>NIFTY index in points</b>. Brokerage and slippage are included only as the per-trade cost you enter above (0 by default);
            option premium effects (theta, IV) are not, and expired option contracts' history is not available from Zerodha to test premiums directly.
            Each signal is measured on its own. The history window is what the app holds: about 100 days at 5-min, 150 at 15-min and above.
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
