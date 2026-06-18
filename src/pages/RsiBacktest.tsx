import { useState } from 'react';
import { cn } from '@/lib/utils';
import { FlaskConical, Play, AlertTriangle, TrendingUp, TrendingDown, Info } from 'lucide-react';
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

const fmtTime = (s: string) => { try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };

export default function RsiBacktest() {
  const [days, setDays] = useState(60);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/backtest/rsi?days=${days}`);
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
    if (s.winRate >= 80 && s.expectancy <= 0) insights.push({ tone: 'bad', text: `This is the classic trap: a ${s.winRate}% win rate that still doesn't make money, because the losers are far bigger than the winners.` });
    if (s.worst < 0 && s.avgWin > 0 && Math.abs(s.worst) > s.avgWin * 5) insights.push({ tone: 'warn', text: `Worst single trade (${s.worst}) was ${(Math.abs(s.worst) / s.avgWin).toFixed(0)}× your average win — the kind of rare loss a high win-rate hides.` });
    if (s.eodExits > 0) insights.push({ tone: 'warn', text: `${s.eodExits} of ${s.trades} trades never reached the opposite RSI zone and were squared off at day end — these are the "didn't work" trades a stop would address.` });
    if (s.avgMae > 0) insights.push({ tone: 'warn', text: `Trades took on average ${s.avgMae} points of heat against them (max ${s.maxMae}) before resolving — useful for deciding where a stop should sit.` });
  }
  const toneClass = (t: string) => t === 'good' ? 'text-emerald-400' : t === 'bad' ? 'text-rose-400' : 'text-amber-400';

  return (
    <div className="px-2 py-3 md:p-8 max-w-[1000px] w-full mx-auto pb-24 min-h-screen">
      <div className="flex items-center gap-2.5 mb-1">
        <FlaskConical className="w-5 h-5 text-primary" />
        <h1 className="text-lg md:text-2xl font-bold tracking-tight">RSI Strategy Backtest</h1>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Your 60/65 ↔ 38/40 RSI zone strategy, tested on real 5-min NIFTY history. Entry on a candle closing back out of a zone; exit at the opposite zone; intraday only (squared off at day end).
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-5">
            <Stat label="Trades" value={String(s.trades)} />
            <Stat label="Hit Target" value={String(s.targetExits)} tone="pos" hint="reached opposite zone" />
            <Stat label="Squared off (EOD)" value={String(s.eodExits)} tone="warn" hint="never hit target" />
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

          {/* Trades */}
          {data.trades?.length > 0 && (
            <div className="bg-card rounded-2xl overflow-hidden">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground px-4 pt-3 pb-2">Recent trades (last {data.trades.length})</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left px-3 py-2 font-medium">Dir</th>
                      <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Entry</th>
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
                        <td className={cn('px-3 py-2', t.reason === 'TARGET' ? 'text-emerald-400/80' : 'text-amber-400/80')}>{t.reason}</td>
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

      {!s && !loading && !error && (
        <div className="text-center text-muted-foreground py-12 text-sm">
          Pick a lookback window and hit <span className="text-foreground font-semibold">Run Backtest</span>. You'll need to be logged into Kite (historical data requires an active session).
        </div>
      )}
    </div>
  );
}
