import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, Link } from 'wouter';
import { cn } from '@/lib/utils';
import { Compass, RefreshCw, AlertTriangle, Gauge, Trash2, Plus, ExternalLink, FlaskConical } from 'lucide-react';

// All times: IST first, Dubai alongside (Dubai = IST − 1h30m).
const fmtBoth = (ts?: number | null) => {
  if (!ts) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const ist = new Date(ts + 5.5 * 3600 * 1000);
  const dxb = new Date(ts + 4.0 * 3600 * 1000);
  return `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())} IST · ${p(dxb.getUTCHours())}:${p(dxb.getUTCMinutes())} Dubai`;
};

const SIGNAL_LABELS: Record<string, string> = {
  usFutures: 'US futures (ES+NQ vs settlement)',
  europe: 'Europe (DAX+FTSE since open)',
  basis: 'NIFTY futures basis vs yesterday',
  clv: 'Close location value (day range)',
  lastHour: 'Last-hour momentum 14:15→15:15',
  vix: 'India VIX day change',
  macro: 'Macro (Brent + USD/INR)',
  breadth: 'NIFTY 50 breadth (advancers)',
};

const fmtRaw = (k: string, raw: any): string => {
  if (raw === null || raw === undefined) return 'n/a';
  if (typeof raw === 'number') return k === 'basis' ? `${raw >= 0 ? '+' : ''}${raw.toFixed(1)} pts` : `${raw >= 0 ? '+' : ''}${raw.toFixed(2)}${k === 'clv' ? '' : '%'}`;
  if (k === 'europe') return `DAX ${raw.dax?.toFixed?.(2) ?? '—'}% · FTSE ${raw.ftse?.toFixed?.(2) ?? '—'}%`;
  if (k === 'macro') return `Brent ${raw.brent?.toFixed?.(2) ?? '—'}% · USDINR ${raw.usdinr?.toFixed?.(2) ?? '—'}%`;
  if (k === 'breadth') return `${raw.advancers}▲ / ${raw.decliners}▼ of ${raw.counted}`;
  return JSON.stringify(raw);
};

export default function GapScorecard() {
  const [, navigate] = useLocation();
  const [evDate, setEvDate] = useState('');
  const [evLabel, setEvLabel] = useState('');
  const [evType, setEvType] = useState('');
  const [btPolling, setBtPolling] = useState(false);

  const { data: snapData, refetch, isFetching } = useQuery({
    queryKey: ['gap-scorecard'],
    queryFn: async () => (await fetch('/api/gap/scorecard')).json(),
    refetchInterval: 60000, refetchOnWindowFocus: false,
  });
  const { data: statsData, refetch: refetchStats } = useQuery({
    queryKey: ['gap-stats'],
    queryFn: async () => (await fetch('/api/gap/stats')).json(),
    refetchInterval: 120000, refetchOnWindowFocus: false,
  });
  const { data: histData } = useQuery({
    queryKey: ['gap-history'],
    queryFn: async () => (await fetch('/api/gap/history?limit=60')).json(),
    refetchInterval: 120000, refetchOnWindowFocus: false,
  });
  const { data: evData, refetch: refetchEvents } = useQuery({
    queryKey: ['gap-events'],
    queryFn: async () => (await fetch('/api/gap/events')).json(),
    refetchOnWindowFocus: false,
  });
  const { data: btStatus, refetch: refetchBt } = useQuery({
    queryKey: ['gap-backtest-status'],
    queryFn: async () => (await fetch('/api/gap/backtest/status')).json(),
    refetchInterval: btPolling ? 4000 : false, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const st = btStatus?.job?.status;
    if (st === 'running' && !btPolling) setBtPolling(true);
    if (btPolling && (st === 'done' || st === 'error')) { setBtPolling(false); refetchStats(); }
  }, [btStatus, btPolling, refetchStats]);

  const snap = snapData?.snapshot || null;
  const stats = statsData?.summary || null;
  const backtest = statsData?.backtest || null;
  const events: any[] = evData?.events || [];
  const history: any[] = histData?.history || [];
  const reco = snap?.recommendation && snap.recommendation.tradingsymbol ? snap.recommendation : null;

  const score: number = snap?.score ?? 0;
  const decision: string = snap?.decision ?? '—';
  const decisionStyle =
    decision === 'GAP-UP BIAS' ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400' :
    decision === 'GAP-DOWN BIAS' ? 'bg-red-500/10 border-red-500/40 text-red-400' :
    'bg-muted/40 border-border text-muted-foreground';
  const gaugePos = Math.max(0, Math.min(100, ((score + 9) / 18) * 100));

  const addEvent = async () => {
    if (!evDate || !evLabel) return;
    await fetch('/api/gap/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dateIST: evDate, label: evLabel, type: evType }) });
    setEvDate(''); setEvLabel(''); setEvType(''); refetchEvents();
  };
  const delEvent = async (id: number) => { await fetch(`/api/gap/events/${id}`, { method: 'DELETE' }); refetchEvents(); };
  const startBacktest = async () => {
    await fetch('/api/gap/backtest/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 730 }) });
    setBtPolling(true); refetchBt();
  };
  const stageOrder = () => {
    if (!reco) return;
    try {
      localStorage.setItem('gap_staged_reco', JSON.stringify({ ...reco, stagedAt: Date.now() }));
      navigator.clipboard?.writeText(reco.tradingsymbol).catch(() => {});
    } catch (e) {}
    navigate('/option-chain');
  };

  return (
    <div className="px-2 py-3 md:p-8 max-w-[900px] w-full mx-auto pb-24 min-h-screen">
      {/* Hero */}
      <div className="relative bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-3 mb-4 flex-wrap overflow-hidden before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/40 before:to-transparent">
        <div className="flex items-center gap-2.5">
          <Compass className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight">Gap Scorecard</h1>
            <p className="text-xs text-muted-foreground">Next-open gap <span className="text-foreground">direction</span> — computed 15:15 IST · 13:45 Dubai. Advisory only.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/gap-risk" className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-card hover:bg-popover transition-colors text-muted-foreground border border-border">
            <Gauge className="w-3.5 h-3.5" /> How big? → Gap Risk
          </Link>
          <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-card hover:bg-popover transition-colors text-muted-foreground">
            <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {!snap && (
        <div className="rounded-2xl p-5 border border-border bg-card text-sm text-muted-foreground mb-4">
          No snapshot yet. The engine runs every trading day at 15:15 IST (13:45 Dubai); the first card appears after the next run.
        </div>
      )}

      {snap && (
        <>
          {/* Decision banner + gauge */}
          <div className={cn('rounded-2xl p-5 border mb-4', decisionStyle)}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <div className="text-2xl md:text-3xl font-bold tracking-tight">
                {decision}
                {snap.impliedMovePts != null && <span className="text-base md:text-lg font-semibold text-muted-foreground"> · implied move ±{snap.impliedMovePts} pts</span>}
              </div>
              <div className="text-xs text-muted-foreground">{snap.date} · snapshot {fmtBoth(snap.ts)}</div>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {snap.eventFlag && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">EVENT WINDOW</span>}
              {snap.cautionFlag && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">VIX CAUTION</span>}
              {snap.lowMagnitude && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30" title="Implied move under 0.15% of spot">LOW MAGNITUDE — capture may not beat costs</span>}
              {snap.staleData && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-500/20 text-slate-300 border border-slate-500/30">STALE / OFF-HOURS DATA</span>}
              {snap.dataGaps?.length > 0 && <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-500/20 text-slate-300 border border-slate-500/30" title={snap.dataGaps.join('\n')}>{snap.dataGaps.length} DATA GAP{snap.dataGaps.length > 1 ? 'S' : ''}</span>}
            </div>
            {/* Gauge −9…+9 */}
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono text-red-400">−9</span>
              <div className="relative flex-1 h-2.5 rounded-full bg-gradient-to-r from-red-500/60 via-slate-500/40 to-emerald-500/60">
                <div className="absolute top-1/2 -translate-y-1/2 w-1 h-5 rounded bg-foreground shadow" style={{ left: `calc(${gaugePos}% - 2px)` }} />
              </div>
              <span className="text-xs font-mono text-emerald-400">+9</span>
              <span className={cn('text-2xl font-bold font-mono w-14 text-right', score > 0 ? 'text-emerald-400' : score < 0 ? 'text-red-400' : 'text-muted-foreground')}>{score > 0 ? '+' : ''}{score}</span>
            </div>
          </div>

          {/* Strike recommendation */}
          {reco && (
            <div className="rounded-2xl p-5 border border-primary/40 bg-primary/5 mb-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <div className="text-sm font-bold uppercase tracking-wider text-primary">Deep-ITM strike (delta ≈ 0.87)</div>
                <button onClick={stageOrder} className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl bg-primary/15 hover:bg-primary/25 text-primary border border-primary/40 transition-colors">
                  <ExternalLink className="w-3.5 h-3.5" /> Stage order → Option Chain
                </button>
              </div>
              <div className="text-xl font-bold font-mono mb-2">{reco.tradingsymbol}</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                <div><span className="text-muted-foreground text-xs block">Premium (mid)</span>₹{reco.premium}</div>
                <div><span className="text-muted-foreground text-xs block">Delta</span>{reco.delta}</div>
                <div><span className="text-muted-foreground text-xs block">IV</span>{reco.ivPct != null ? `${reco.ivPct}%` : 'borrowed'}</div>
                <div><span className="text-muted-foreground text-xs block">Spread</span>₹{reco.spread}</div>
                <div><span className="text-muted-foreground text-xs block">Time value (max overnight bleed)</span>₹{reco.timeValue}</div>
                <div><span className="text-muted-foreground text-xs block">Capital / lot ({reco.lotSize})</span>₹{reco.capitalPerLot?.toLocaleString?.('en-IN') ?? reco.capitalPerLot}</div>
                <div><span className="text-muted-foreground text-xs block">Max loss / lot</span>₹{reco.maxLossPerLot?.toLocaleString?.('en-IN') ?? reco.maxLossPerLot}</div>
                <div><span className="text-muted-foreground text-xs block">Expected capture</span>{reco.expectedCapturePts != null ? `≈${reco.expectedCapturePts} pts` : 'n/a (no bucket stats yet)'}</div>
              </div>
              <p className="text-[11px] text-muted-foreground mt-3">Expiry {reco.expiry} · staged orders are advisory — nothing is ever auto-placed.</p>
            </div>
          )}
          {snap.decision !== 'NO-TRADE' && !reco && snap.recommendation?.skipped && (
            <div className="rounded-2xl p-4 border border-border bg-card text-xs text-muted-foreground mb-4">
              Bias fired but no strike recommended: {snap.recommendation.reason}
            </div>
          )}

          {/* Per-signal table */}
          <div className="rounded-2xl border border-border bg-card mb-4 overflow-hidden">
            <div className="px-4 py-3 text-sm font-bold border-b border-border">Signals</div>
            <table className="w-full text-sm">
              <tbody>
                {Object.keys(SIGNAL_LABELS).map(k => {
                  const s = snap.signals?.[k];
                  if (!s) return null;
                  const w = snap.weights?.[k] ?? 1;
                  return (
                    <tr key={k} className="border-b border-border/50 last:border-0">
                      <td className="px-4 py-2.5 text-muted-foreground">{SIGNAL_LABELS[k]}<span className="ml-1.5 text-[10px] opacity-60">×{w}</span></td>
                      <td className="px-2 py-2.5 text-right font-mono text-xs">{fmtRaw(k, s.raw)}</td>
                      <td className={cn('px-4 py-2.5 text-right font-mono font-bold w-16', s.score > 0 ? 'text-emerald-400' : s.score < 0 ? 'text-red-400' : 'text-muted-foreground')}>{s.score > 0 ? '+' : ''}{s.score * w}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Accuracy */}
      <div className="rounded-2xl border border-border bg-card mb-4 overflow-hidden">
        <div className="px-4 py-3 text-sm font-bold border-b border-border flex items-center justify-between">
          <span>Accuracy</span>
          <button onClick={startBacktest} disabled={btPolling} className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-muted/40 hover:bg-muted text-muted-foreground transition-colors disabled:opacity-50">
            <FlaskConical className={cn('w-3 h-3', btPolling && 'animate-pulse')} /> {btPolling ? (btStatus?.job?.progress || 'backtest running…') : 'Run 2-year backtest'}
          </button>
        </div>
        <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          {stats ? (
            <>
              <div><span className="text-muted-foreground text-xs block">30-day hit rate</span>{stats.rolling?.d30?.hitRate != null ? `${stats.rolling.d30.hitRate}% (${stats.rolling.d30.hits}/${stats.rolling.d30.fired})` : 'no fired days yet'}</div>
              <div><span className="text-muted-foreground text-xs block">90-day hit rate</span>{stats.rolling?.d90?.hitRate != null ? `${stats.rolling.d90.hitRate}% (${stats.rolling.d90.hits}/${stats.rolling.d90.fired})` : 'no fired days yet'}</div>
              {(stats.buckets || []).map((b: any) => (
                <div key={b.minScore}><span className="text-muted-foreground text-xs block">|score| ≥ {b.minScore}</span>{b.hitRate != null ? `${b.hitRate}% (${b.hits}/${b.fired})` : '—'}</div>
              ))}
            </>
          ) : <div className="text-muted-foreground text-xs col-span-full">No live stats yet — they build as outcomes are recorded each morning.</div>}
        </div>
        {backtest && (
          <div className="border-t border-border p-4 text-xs space-y-2">
            <div className="font-bold text-sm">Backtest · {backtest.daysAnalyzed} days ({backtest.firstDay} → {backtest.lastDay}) · max |score| {backtest.maxAbsScore}</div>
            <div className="grid grid-cols-3 gap-2">
              {(backtest.buckets || []).map((b: any) => (
                <div key={b.minScore} className="rounded-lg bg-muted/30 p-2">
                  <div className="text-muted-foreground">|score| ≥ {b.minScore}</div>
                  <div className="font-mono">{b.hitRate != null ? `${b.hitRate}%` : '—'} · {b.days}d</div>
                  <div className="text-muted-foreground">avg gap {b.avgGapPct != null ? `${b.avgGapPct}%` : '—'}</div>
                </div>
              ))}
            </div>
            <div>Confusion @±{5}: pred-UP → {backtest.confusionAtLiveThreshold?.predUp?.up}↑ {backtest.confusionAtLiveThreshold?.predUp?.down}↓ {backtest.confusionAtLiveThreshold?.predUp?.flat}·flat · pred-DOWN → {backtest.confusionAtLiveThreshold?.predDown?.down}↓ {backtest.confusionAtLiveThreshold?.predDown?.up}↑ {backtest.confusionAtLiveThreshold?.predDown?.flat}·flat</div>
            <div>Walk-forward: fitted ±{backtest.walkForward?.fittedThreshold} → train {backtest.walkForward?.train?.hitRate ?? '—'}% ({backtest.walkForward?.train?.fired}) · test {backtest.walkForward?.test?.hitRate ?? '—'}% ({backtest.walkForward?.test?.fired})</div>
            <div>Equity (|score|≥5, non-event, −{3}pts): {backtest.equity?.trades} trades → {backtest.equity?.finalPts} pts</div>
            <div className="text-muted-foreground">Excluded: {(backtest.excludedSignals || []).join('; ')}</div>
            <div className="text-muted-foreground">Approximations: {(backtest.approximations || []).join('; ')}</div>
          </div>
        )}
        {btStatus?.job?.status === 'error' && <div className="border-t border-border p-3 text-xs text-red-400">Backtest failed: {btStatus.job.error}</div>}
      </div>

      {/* History */}
      <div className="rounded-2xl border border-border bg-card mb-4 overflow-hidden">
        <div className="px-4 py-3 text-sm font-bold border-b border-border">History</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-muted-foreground border-b border-border/60">
              <th className="px-3 py-2 text-left">Date</th><th className="px-2 py-2 text-right">Score</th><th className="px-2 py-2 text-left">Decision</th>
              <th className="px-2 py-2 text-right">Actual gap</th><th className="px-2 py-2 text-center">Hit</th><th className="px-3 py-2 text-right">Reco P&L/lot</th>
            </tr></thead>
            <tbody>
              {history.map((h: any) => (
                <tr key={h.date} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-1.5 font-mono">{h.date}</td>
                  <td className={cn('px-2 py-1.5 text-right font-mono', h.score > 0 ? 'text-emerald-400' : h.score < 0 ? 'text-red-400' : '')}>{h.score > 0 ? '+' : ''}{h.score}</td>
                  <td className="px-2 py-1.5">{h.decision === 'NO-TRADE' ? <span className="text-muted-foreground">NO-TRADE</span> : <span className={h.decision === 'GAP-UP BIAS' ? 'text-emerald-400' : 'text-red-400'}>{h.decision}</span>}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{h.outcome ? `${h.outcome.actualGapPct > 0 ? '+' : ''}${h.outcome.actualGapPct}%` : '—'}</td>
                  <td className="px-2 py-1.5 text-center">{h.outcome?.hit === true ? '✓' : h.outcome?.hit === false ? '✗' : '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{h.outcome?.recoPnlPerLot != null ? `₹${h.outcome.recoPnlPerLot}` : '—'}</td>
                </tr>
              ))}
              {history.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-muted-foreground">No snapshots yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Events editor */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 text-sm font-bold border-b border-border flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-400" /> Gap events (FOMC, CPI, RBI, Budget…)</div>
        <div className="p-4 space-y-2">
          {events.map((e: any) => (
            <div key={e.id} className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground w-24">{e.dateIST}</span>
              <span className="flex-1">{e.label}{e.type ? <span className="text-muted-foreground text-xs"> · {e.type}</span> : null}</span>
              <button onClick={() => delEvent(e.id)} className="p-1.5 rounded-lg hover:bg-red-500/15 text-muted-foreground hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {events.length === 0 && <div className="text-xs text-muted-foreground">No upcoming events logged. An event dated today or tomorrow blocks trade signals (EVENT WINDOW).</div>}
          <div className="flex items-center gap-2 pt-2 border-t border-border/50 flex-wrap">
            <input type="date" value={evDate} onChange={e => setEvDate(e.target.value)} className="bg-muted/50 rounded-lg px-2.5 py-1.5 text-xs" />
            <input placeholder="Label (e.g. FOMC)" value={evLabel} onChange={e => setEvLabel(e.target.value)} className="bg-muted/50 rounded-lg px-2.5 py-1.5 text-xs flex-1 min-w-[140px]" />
            <input placeholder="Type (optional)" value={evType} onChange={e => setEvType(e.target.value)} className="bg-muted/50 rounded-lg px-2.5 py-1.5 text-xs w-28" />
            <button onClick={addEvent} className="flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-lg bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"><Plus className="w-3.5 h-3.5" /> Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}
