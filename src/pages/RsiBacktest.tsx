import { useState } from 'react';
import { cn } from '@/lib/utils';
import { FlaskConical, Play, AlertTriangle, TrendingUp, TrendingDown, Info, CheckCircle2, XCircle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';

const DAY_OPTIONS = [30, 60, 90, 120, 180];

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: 'pos' | 'neg' | 'neutral' | 'warn'; hint?: string }) {
  return (
    <div className="bg-card rounded-2xl p-3.5 flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</span>
      <span className={cn('text-lg font-bold font-mono truncate',
        tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-foreground')}>{value}</span>
      {hint && <span className="text-[10px] text-muted-foreground truncate">{hint}</span>}
    </div>
  );
}

const fmtTime = (s: string) => { try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }); } catch { return s; } };

const REGIME_LABEL: Record<string, string> = { withTrend: 'With the trend', counterTrend: 'Counter-trend', range: 'Range / flat' };

function BreakdownGroup({ title, rows, labelMap }: { title: string; rows: any[]; labelMap?: (k: string) => string }) {
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  return (
    <div className="bg-card rounded-2xl p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">{title}</div>
      <div className="space-y-2.5">
        {rows.filter((r) => r.n > 0).map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <div className="w-24 shrink-0 text-xs text-foreground truncate">{labelMap ? labelMap(r.key) : r.key}</div>
            <div className="flex-1 h-5 bg-muted/40 rounded-md relative overflow-hidden">
              <div className={cn('absolute top-0 bottom-0 rounded-md', r.net >= 0 ? 'bg-emerald-500/40' : 'bg-rose-500/40')}
                style={{ width: `${(Math.abs(r.net) / maxAbs) * 100}%`, left: 0 }} />
              <span className={cn('absolute inset-0 flex items-center px-2 text-[11px] font-mono font-semibold', r.net >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                {r.net >= 0 ? '+' : ''}{r.net}
              </span>
            </div>
            <div className="w-20 shrink-0 text-right text-[10px] text-muted-foreground font-mono">{r.n} · {r.winRate}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RsiBacktest() {
  const [days, setDays] = useState(60);
  const [deepOb, setDeepOb] = useState(70);
  const [deepOs, setDeepOs] = useState(30);
  const [slMode, setSlMode] = useState<'none' | 'same' | 'prev' | 'prev2'>('none');
  const [timeframe, setTimeframe] = useState<'5' | '15'>('5');
  const [useDiv, setUseDiv] = useState(false);
  const [divWindow, setDivWindow] = useState(7);
  const [noEntryAfter, setNoEntryAfter] = useState('');
  const [exitAtCutoff, setExitAtCutoff] = useState(false);
  const [reqOptRsi, setReqOptRsi] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  // Option-RSI confirmation (recent window only)
  const [optLoading, setOptLoading] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [optData, setOptData] = useState<any>(null);
  const runOption = async () => {
    setOptLoading(true); setOptError(null);
    try {
      const r = await fetch(`/api/backtest/rsi-option?deepOb=${deepOb}&deepOs=${deepOs}&optionDays=12&slMode=${slMode}&timeframe=${timeframe}&useDiv=${useDiv}&divWindow=${divWindow}&noEntryAfter=${encodeURIComponent(noEntryAfter)}&exitAtCutoff=${exitAtCutoff}&reqOptRsi=${reqOptRsi}`);
      const j = await r.json();
      if (!j.success) { setOptError(j.error || 'Failed'); setOptData(null); }
      else setOptData(j);
    } catch (e: any) { setOptError(e?.message || 'Request failed'); setOptData(null); }
    finally { setOptLoading(false); }
  };

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/backtest/rsi?days=${days}&deepOb=${deepOb}&deepOs=${deepOs}&slMode=${slMode}&timeframe=${timeframe}&useDiv=${useDiv}&divWindow=${divWindow}&noEntryAfter=${encodeURIComponent(noEntryAfter)}&exitAtCutoff=${exitAtCutoff}`);
      const j = await r.json();
      if (!j.success) { setError(j.error || 'Backtest failed'); setData(null); }
      else setData(j);
    } catch (e: any) { setError(e?.message || 'Request failed'); setData(null); }
    finally { setLoading(false); }
  };

  const s = data?.stats;
  const profitable = s && s.totalPoints > 0;

  // Auto-generated honest read of the result
  const insights: { tone: 'good' | 'warn' | 'bad'; text: string }[] = [];
  if (s) {
    if (s.expectancy > 0) insights.push({ tone: 'good', text: `Positive expectancy: about +${s.expectancy} index points per trade on average across ${s.trades} trades.` });
    else insights.push({ tone: 'bad', text: `Negative expectancy: ${s.expectancy} points per trade — over this window the signal lost on the index even before option costs.` });
    if (s.winRate >= 80 && s.expectancy <= 0) insights.push({ tone: 'bad', text: `The classic trap: a ${s.winRate}% win rate that still doesn't make money, because the losers outweigh the winners.` });
    if (s.worst < 0 && s.avgWin > 0 && Math.abs(s.worst) > s.avgWin * 5) insights.push({ tone: 'warn', text: `Worst single trade (${s.worst}) was ${(Math.abs(s.worst) / s.avgWin).toFixed(0)}× your average win — with no stop, a trade that never reverts can run a long way.` });
    if (s.targetExits > 0) insights.push({ tone: 'good', text: `${s.targetExits} of ${s.trades} trades reached the opposite RSI zone (the intended exit).` });
    if (s.stopExits > 0) insights.push({ tone: 'warn', text: `${s.stopExits} trades were stopped out (closed past the prior candle's low/high) — losses capped early instead of running to day end.` });
    if (s.eodExits > 0) insights.push({ tone: 'warn', text: `${s.eodExits} trades never reached the opposite zone and were squared off at day end — with no stop, these carried whatever the move was until the close.` });
    if (s.avgMae > 0) insights.push({ tone: 'warn', text: `Trades took on average ${s.avgMae} points of heat against them (max ${s.maxMae}) before resolving — the open risk you're carrying without a stop.` });
  }
  const toneClass = (t: string) => t === 'good' ? 'text-emerald-400' : t === 'bad' ? 'text-rose-400' : 'text-amber-400';

  return (
    <div className="px-2 py-3 md:p-8 max-w-[1000px] w-full mx-auto pb-24 min-h-screen">
      <div className="flex items-center gap-2.5 mb-1">
        <FlaskConical className="w-5 h-5 text-primary" />
        <h1 className="text-lg md:text-2xl font-bold tracking-tight">RSI Strategy Backtest</h1>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Your RSI zone strategy, tested on real {timeframe}-min NIFTY history. Takes only setups where RSI pushes <span className="text-foreground">deep</span> into a zone (≥{deepOb} / ≤{deepOs}) then closes back out{useDiv ? <span className="text-foreground"> and shows matching RSI divergence (≤{divWindow} bars)</span> : ''}; exit at the opposite zone; {slMode !== 'none' ? <span className="text-foreground">stop = {slMode === 'same' ? 'entry' : slMode === 'prev' ? 'previous' : '2nd previous'} candle low/high on a close beyond it</span> : 'no stop-loss'}; intraday{noEntryAfter ? <span className="text-foreground">, no new entries after {noEntryAfter} IST</span> : ''}{exitAtCutoff && noEntryAfter ? <span className="text-foreground">, open trades squared off at {noEntryAfter}</span> : ', squared off at day end'}.
      </p>

      {/* Honest framing banner */}
      <div className="flex items-start gap-2 text-[12px] text-muted-foreground bg-card/60 border border-dashed border-border rounded-xl px-3 py-2.5 mb-4 leading-relaxed">
        <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <span>Results are measured in <span className="text-foreground">index points</span> — the signal's directional edge. Real option P&amp;L will be <span className="text-foreground">lower</span> (theta decay + bid-ask). This validates whether the idea works at all; if it doesn't profit on the index, options won't rescue it.</span>
      </div>

      {/* Controls */}
      <div className="flex items-end gap-3 flex-wrap mb-5">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Lookback</span>
          <div className="flex items-center gap-1.5">
            {DAY_OPTIONS.map((d) => (
              <button key={d} onClick={() => setDays(d)}
                className={cn('text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors',
                  days === d ? 'bg-primary/15 text-primary' : 'bg-card text-muted-foreground hover:text-foreground')}>
                {d}d
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Deep OB ≥</span>
          <input type="number" value={deepOb} min={60} max={90}
            onChange={(e) => setDeepOb(Math.max(60, Math.min(90, parseInt(e.target.value) || 70)))}
            className="w-16 text-xs font-mono px-2.5 py-1.5 rounded-lg bg-card text-foreground border border-border focus:border-primary outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Deep OS ≤</span>
          <input type="number" value={deepOs} min={10} max={40}
            onChange={(e) => setDeepOs(Math.max(10, Math.min(40, parseInt(e.target.value) || 30)))}
            className="w-16 text-xs font-mono px-2.5 py-1.5 rounded-lg bg-card text-foreground border border-border focus:border-primary outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Timeframe</span>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as '5' | '15')}
            className="text-xs font-mono px-2 py-1.5 rounded-lg bg-card text-foreground border border-border focus:border-primary outline-none">
            <option value="5">5 min</option>
            <option value="15">15 min</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Stop-loss</span>
          <select value={slMode} onChange={(e) => setSlMode(e.target.value as 'none' | 'same' | 'prev' | 'prev2')}
            className={cn('text-xs font-mono px-2 py-1.5 rounded-lg border border-border focus:border-primary outline-none',
              slMode !== 'none' ? 'bg-rose-500/15 text-rose-400' : 'bg-card text-foreground')}>
            <option value="none">None</option>
            <option value="same">Same candle high/low</option>
            <option value="prev">Previous candle high/low</option>
            <option value="prev2">2nd previous candle high/low</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Divergence</span>
          <button onClick={() => setUseDiv((v) => !v)}
            className={cn('flex items-center gap-2 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors',
              useDiv ? 'bg-violet-500/15 text-violet-400' : 'bg-card text-muted-foreground hover:text-foreground')}>
            <span className={cn('relative w-7 h-4 rounded-full transition-colors', useDiv ? 'bg-violet-500' : 'bg-muted')}>
              <span className={cn('absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all', useDiv ? 'left-[14px]' : 'left-0.5')} />
            </span>
            RSI div ({divWindow}-bar)
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Div candles</span>
          <select value={divWindow} onChange={(e) => setDivWindow(parseInt(e.target.value))}
            className="text-xs font-mono px-2 py-1.5 rounded-lg bg-card text-foreground border border-border focus:border-primary outline-none">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">No entry after (IST)</span>
          <input type="time" value={noEntryAfter} onChange={(e) => setNoEntryAfter(e.target.value)}
            className="text-xs font-mono px-2 py-1.5 rounded-lg bg-card text-foreground border border-border focus:border-primary outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Exit at cutoff</span>
          <button onClick={() => setExitAtCutoff((v) => !v)} disabled={!noEntryAfter}
            className={cn('flex items-center gap-2 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-40',
              exitAtCutoff && noEntryAfter ? 'bg-amber-500/15 text-amber-400' : 'bg-card text-muted-foreground hover:text-foreground')}>
            <span className={cn('relative w-7 h-4 rounded-full transition-colors', exitAtCutoff && noEntryAfter ? 'bg-amber-500' : 'bg-muted')}>
              <span className={cn('absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all', exitAtCutoff ? 'left-[14px]' : 'left-0.5')} />
            </span>
            square off open
          </button>
        </div>
        <button onClick={run} disabled={loading}
          className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-xl bg-primary text-primary-foreground disabled:opacity-50 transition-opacity">
          <Play className={cn('w-4 h-4', loading && 'animate-pulse')} /> {loading ? 'Running…' : 'Run Backtest'}
        </button>
      </div>

      {loading && <div className="text-center text-muted-foreground py-10 text-sm">Pulling history from Kite and crunching trades… this can take a few seconds.</div>}
      {error && (
        <div className="flex items-center gap-2 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-3">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {s && !loading && (
        <>
          <div className="text-[11px] text-muted-foreground mb-3">
            {data.candles.toLocaleString('en-IN')} candles · {data.from ? fmtTime(data.from) : ''} → {data.to ? fmtTime(data.to) : ''}
          </div>

          {/* Headline stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
            <Stat label="Win Rate" value={`${s.winRate}%`} tone="neutral" hint={`${s.wins}W / ${s.losses}L`} />
            <Stat label="Expectancy / trade" value={`${s.expectancy > 0 ? '+' : ''}${s.expectancy} pts`} tone={s.expectancy > 0 ? 'pos' : 'neg'} hint="the number that matters" />
            <Stat label="Total (net)" value={`${s.totalPoints > 0 ? '+' : ''}${s.totalPoints} pts`} tone={profitable ? 'pos' : 'neg'} />
            <Stat label="Profit Factor" value={s.profitFactor === null ? '∞' : String(s.profitFactor)} tone={s.profitFactor === null || s.profitFactor >= 1 ? 'pos' : 'neg'} hint="gross win ÷ gross loss" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
            <Stat label="Avg Win" value={`+${s.avgWin}`} tone="pos" />
            <Stat label="Avg Loss" value={`${s.avgLoss}`} tone="neg" />
            <Stat label="Worst Trade" value={`${s.worst}`} tone="neg" />
            <Stat label="Max Drawdown" value={`${s.maxDrawdown} pts`} tone="neg" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 mb-5">
            <Stat label="Trades" value={String(s.trades)} />
            <Stat label="Hit Target" value={String(s.targetExits)} tone="pos" hint="reached opposite zone" />
            {(s.stopExits > 0 || (data.params?.slMode && data.params.slMode !== 'none')) && <Stat label="Stopped" value={String(s.stopExits ?? 0)} tone="neg" hint="closed past the stop candle" />}
            {(s.cutoffExits > 0 || data.params?.exitAtCutoff) && <Stat label="Cutoff exits" value={String(s.cutoffExits ?? 0)} tone="warn" hint="squared off at cutoff time" />}
            <Stat label="Squared off (EOD)" value={String(s.eodExits)} tone="warn" hint="held to day end" />
            <Stat label="Avg / Max Heat" value={`${s.avgMae} / ${s.maxMae}`} tone="neutral" hint="adverse pts (MAE)" />
          </div>

          {/* Equity curve */}
          {data.equity?.length > 1 && (
            <div className="bg-card rounded-2xl p-3 mb-5">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 px-1">Cumulative points (last {data.equity.length} trades)</div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.equity} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="i" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 2" />
                  <Line type="monotone" dataKey="cum" stroke={profitable ? '#10b981' : '#f43f5e'} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* What this means */}
          {insights.length > 0 && (
            <div className="bg-card/60 rounded-2xl p-4 mb-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-foreground mb-2.5">What this means</div>
              <ul className="space-y-2">
                {insights.map((ins, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted-foreground">
                    <span className={cn('mt-1.5 w-1.5 h-1.5 rounded-full shrink-0', ins.tone === 'good' ? 'bg-emerald-500' : ins.tone === 'bad' ? 'bg-rose-500' : 'bg-amber-500')} />
                    <span><span className={toneClass(ins.tone)}>•</span> {ins.text}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground/70 mt-3 pt-3 border-t border-border">Index-points backtest, no option costs or slippage modelled. Educational — not investment advice.</p>
            </div>
          )}

          {/* Loss breakdown */}
          {data.breakdown && (
            <div className="mb-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-foreground mb-2.5">Loss breakdown — where the P&amp;L comes from</div>
              {(() => {
                const b = data.breakdown;
                const worstReg = [...b.byRegime].filter((r: any) => r.n > 0).sort((a: any, c: any) => a.net - c.net)[0];
                const eod = b.byReason.find((r: any) => r.key === 'EOD');
                const tgt = b.byReason.find((r: any) => r.key === 'TARGET');
                const worstHour = [...b.byHour].filter((r: any) => r.n > 0).sort((a: any, c: any) => a.net - c.net)[0];
                return (
                  <div className="bg-card/60 rounded-2xl p-4 mb-3 text-[12.5px] leading-relaxed text-muted-foreground space-y-1.5">
                    {worstReg && worstReg.net < 0 && <p><span className="text-rose-400">•</span> <span className="text-foreground">{REGIME_LABEL[worstReg.key]}</span> trades are the worst bucket: {worstReg.net} pts over {worstReg.n} trades ({worstReg.winRate}% win).{worstReg.key === 'counterTrend' ? ' These fight the prevailing trend — the prime candidate for a trend filter.' : ''}</p>}
                    {eod && tgt && <p><span className="text-rose-400">•</span> By exit: targets net {tgt.net >= 0 ? '+' : ''}{tgt.net} pts ({tgt.n}), but EOD square-offs net {eod.net} pts ({eod.n}) — the no-reversion trades are the leak.</p>}
                    {worstHour && worstHour.net < 0 && <p><span className="text-rose-400">•</span> Worst entry hour: {worstHour.key}:00 IST ({worstHour.net} pts, {worstHour.n} trades) — a time-of-day cutoff would target this.</p>}
                    <p><span className="text-amber-400">•</span> Losers held ~{b.holding.avgBarsLoss} bars vs winners ~{b.holding.avgBarsWin} — {b.holding.avgBarsLoss > b.holding.avgBarsWin ? 'losers drag on longer, so a time-stop could help.' : 'holding times are similar.'}</p>
                  </div>
                );
              })()}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-3">
                <BreakdownGroup title="By regime (trend vs range)" rows={data.breakdown.byRegime} labelMap={(k) => REGIME_LABEL[k] || k} />
                <BreakdownGroup title="By exit reason" rows={data.breakdown.byReason} />
                <BreakdownGroup title="By direction" rows={data.breakdown.byDir} />
                <BreakdownGroup title="By entry hour (IST)" rows={data.breakdown.byHour} labelMap={(k) => `${k}:00`} />
              </div>

              {data.bounceStudy && (() => {
                const bs = data.bounceStudy;
                const row = (r: any, key: string, highlight = false) => (
                  <div key={key} className={cn('grid grid-cols-5 gap-2 px-3 py-2 text-[12px] font-mono items-center', highlight ? 'bg-primary/10' : '')}>
                    <span className="text-foreground truncate">{r.key}</span>
                    <span className="text-right text-muted-foreground">{r.n}</span>
                    <span className={cn('text-right', r.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400')}>{r.winRate}%</span>
                    <span className={cn('text-right', r.avg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{r.avg >= 0 ? '+' : ''}{r.avg}</span>
                    <span className="text-right text-foreground/80">{r.profitFactor == null ? '\u221e' : r.profitFactor}</span>
                  </div>
                );
                const header = (firstCol: string) => (
                  <div className="grid grid-cols-5 gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/30">
                    <span>{firstCol}</span><span className="text-right">Trades</span><span className="text-right">Win%</span><span className="text-right">Avg pts</span><span className="text-right">PF</span>
                  </div>
                );
                const allA = bs.allLongs?.avg ?? 0;
                const strong = bs.byThreshold?.find((x: any) => x.key === 'Score >= 70');
                const strongA = strong?.avg ?? 0;
                const enough = strong && strong.n >= 5;
                const helps = enough && strongA > allA;
                return (
                  <div className="bg-card rounded-2xl p-4 mb-3">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Bounce Conviction filter · LONG entries</div>
                    <div className="text-[11px] text-muted-foreground mb-3 leading-relaxed">{bs.note}</div>
                    <div className="rounded-lg overflow-hidden border border-border mb-4">
                      {header('Filter')}
                      {bs.byThreshold.map((r: any) => row(r, 't-' + r.key, r.key === 'Score >= 70'))}
                    </div>
                    <div className="rounded-lg overflow-hidden border border-border">
                      {header('Score bucket')}
                      {bs.byBucket.map((r: any) => row(r, 'b-' + r.key))}
                    </div>
                    <div className={cn('flex items-start gap-2 text-[12px] mt-3 rounded-xl px-3 py-2.5 leading-relaxed', helps ? 'bg-emerald-500/10 text-emerald-200' : 'bg-muted/40 text-muted-foreground')}>
                      <Info className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        {enough
                          ? (helps
                              ? `High-conviction bounces (score \u226570) averaged ${strongA >= 0 ? '+' : ''}${strongA} pts vs ${allA >= 0 ? '+' : ''}${allA} for all bounces over this window — the confluence filter added edge.`
                              : `Over this window the \u226570 filter did not beat taking all bounces (${strongA >= 0 ? '+' : ''}${strongA} vs ${allA >= 0 ? '+' : ''}${allA} pts avg). Don't trust it on this read alone — try a longer lookback.`)
                          : 'Too few high-conviction bounces here to judge — widen the lookback (more days) for a meaningful sample.'}
                      </span>
                    </div>
                  </div>
                );
              })()}
              {data.breakdown.worst?.length > 0 && (
                <div className="bg-card rounded-2xl p-4">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">5 worst trades</div>
                  <div className="space-y-1.5">
                    {data.breakdown.worst.map((w: any, i: number) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-[12px]">
                        <span className={cn('font-bold w-4 shrink-0', w.dir === 'LONG' ? 'text-emerald-400' : 'text-rose-400')}>{w.dir === 'LONG' ? 'L' : 'S'}</span>
                        <span className="flex-1 text-muted-foreground font-mono truncate">{fmtTime(w.entryTime)}</span>
                        <span className="text-[10px] text-muted-foreground/70 w-20 text-right truncate">{REGIME_LABEL[w.regime]}</span>
                        <span className="text-[10px] w-12 text-right text-amber-400/80">{w.reason}</span>
                        <span className="text-rose-400 font-bold font-mono w-14 text-right">{w.pnl}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground/70 mt-2">Regime is gauged from a 50-period EMA slope at entry; "counter-trend" = the trade fights the prevailing drift.</p>
            </div>
          )}

          {/* Trades */}
          {data.trades?.length > 0 && (
            <div className="bg-card rounded-2xl overflow-hidden">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground px-4 pt-3 pb-2">Recent trades (last {data.trades.length})</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left px-3 py-2 font-medium">Dir</th>
                      <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Entry (IST)</th>
                      <th className="text-right px-3 py-2 font-medium">RSI</th>
                      <th className="text-right px-3 py-2 font-medium">Exit</th>
                      <th className="text-left px-3 py-2 font-medium">Why</th>
                      <th className="text-right px-3 py-2 font-medium">P&amp;L</th>
                      <th className="text-right px-3 py-2 font-medium">Heat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.trades].reverse().map((t: any, i: number) => (
                      <tr key={i} className="border-b border-border/40">
                        <td className={cn('px-3 py-2 font-bold', t.dir === 'LONG' ? 'text-emerald-400' : 'text-rose-400')}>{t.dir === 'LONG' ? 'L' : 'S'}</td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{fmtTime(t.entryTime)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{t.entryRsi}→{t.exitRsi}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{t.exitPrice}</td>
                        <td className={cn('px-3 py-2', t.reason === 'TARGET' ? 'text-emerald-400/80' : t.reason === 'STOP' ? 'text-rose-400/80' : 'text-amber-400/80')}>{t.reason}</td>
                        <td className={cn('px-3 py-2 text-right font-bold', t.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          <span className="inline-flex items-center gap-0.5 justify-end">{t.pnl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}{t.pnl}</span>
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground/70">{t.mae}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Option-RSI confirmation (recent window) */}
      <div className="mt-6 pt-5 border-t border-border">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">Option-RSI confirmation <span className="text-muted-foreground normal-case font-normal">(recent only)</span></h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">The ATM option you'd buy must have its own 5-min RSI cross above 40 at entry. Only covers the current weekly expiry (older contracts have expired).</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setReqOptRsi((v) => !v)}
              className={cn('flex items-center gap-2 text-xs font-semibold px-2.5 py-2 rounded-xl transition-colors',
                reqOptRsi ? 'bg-primary/15 text-primary' : 'bg-card text-muted-foreground hover:text-foreground')}>
              <span className={cn('relative w-7 h-4 rounded-full transition-colors', reqOptRsi ? 'bg-primary' : 'bg-muted')}>
                <span className={cn('absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all', reqOptRsi ? 'left-[14px]' : 'left-0.5')} />
              </span>
              require &gt;40
            </button>
            <button onClick={runOption} disabled={optLoading}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-card hover:bg-popover text-foreground disabled:opacity-50 transition-colors">
              <Play className={cn('w-3.5 h-3.5', optLoading && 'animate-pulse')} /> {optLoading ? 'Checking options…' : 'Run option check'}
            </button>
          </div>
        </div>

        {optError && <div className="flex items-center gap-2 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2.5 mt-2"><AlertTriangle className="w-4 h-4 shrink-0" /> {optError}</div>}
        {optLoading && <div className="text-center text-muted-foreground py-6 text-sm">Resolving ATM contracts and pulling option history…</div>}

        {optData && !optLoading && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 mb-3 mt-3">
              <Stat label="Index signals" value={String(optData.totals.indexSignals)} />
              <Stat label="Option data" value={String(optData.totals.withOptionData)} hint={`${optData.totals.noOptionData} expired/none`} />
              <Stat label="Confirmed" value={String(optData.totals.confirmed)} tone="pos" hint={`option RSI > ${optData.threshold}`} />
              <Stat label="Rejected" value={String(optData.totals.rejected)} tone="warn" hint="option RSI fails" />
              <Stat label="Taken" value={String(optData.totals.taken)} hint={optData.requireOptionRsi ? 'crossover required' : 'crossover off'} />
            </div>

            {optData.optionStats ? (
              <>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">{optData.requireOptionRsi ? 'Confirmed' : 'All'} trades — real option P&amp;L (points of premium)</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-4">
                  <Stat label="Win Rate" value={`${optData.optionStats.winRate}%`} />
                  <Stat label="Avg / trade" value={`${optData.optionStats.avgOptionPts > 0 ? '+' : ''}${optData.optionStats.avgOptionPts}`} tone={optData.optionStats.avgOptionPts > 0 ? 'pos' : 'neg'} />
                  <Stat label="Total" value={`${optData.optionStats.totalOptionPts > 0 ? '+' : ''}${optData.optionStats.totalOptionPts}`} tone={optData.optionStats.totalOptionPts > 0 ? 'pos' : 'neg'} />
                  <Stat label="Best / Worst" value={`${optData.optionStats.best} / ${optData.optionStats.worst}`} tone="neutral" />
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground py-3">No trades with option data in this window.</div>
            )}

            {optData.signals?.length > 0 && (
              <div className="bg-card rounded-2xl overflow-hidden">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground px-4 pt-3 pb-2">Recent signals (IST)</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] font-mono">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left px-3 py-2 font-medium">Dir</th>
                        <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Entry</th>
                        <th className="text-left px-3 py-2 font-medium">Option</th>
                        <th className="text-right px-3 py-2 font-medium">Opt RSI</th>
                        <th className="text-center px-3 py-2 font-medium">Conf?</th>
                        <th className="text-right px-3 py-2 font-medium">Opt P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...optData.signals].reverse().map((sig: any, i: number) => (
                        <tr key={i} className="border-b border-border/40">
                          <td className={cn('px-3 py-2 font-bold', sig.dir === 'LONG' ? 'text-emerald-400' : 'text-rose-400')}>{sig.dir === 'LONG' ? 'L' : 'S'}</td>
                          <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{fmtTime(sig.entryTime)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{sig.available ? `${sig.strike}${sig.type}` : '—'}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{sig.available ? sig.optRsi : '—'}</td>
                          <td className="px-3 py-2 text-center">{sig.available ? (sig.confirms ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 inline" /> : <XCircle className="w-3.5 h-3.5 text-muted-foreground inline" />) : '—'}</td>
                          <td className={cn('px-3 py-2 text-right font-bold', !sig.available ? 'text-muted-foreground/40' : sig.optPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{sig.available ? sig.optPnl : 'n/a'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground/70 mt-3">Option P&amp;L here is real premium movement (entry→exit close of the ATM contract), so it already includes theta — unlike the index-points figures above. Small sample; current expiry only.</p>
          </>
        )}
      </div>

      {!s && !loading && !error && (
        <div className="text-center text-muted-foreground py-12 text-sm">
          Pick a lookback window and hit <span className="text-foreground font-semibold">Run Backtest</span>. You'll need to be logged into Kite (historical data requires an active session).
        </div>
      )}
    </div>
  );
}
