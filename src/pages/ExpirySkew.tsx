import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Scale, Power, ChevronDown, ChevronRight, FlaskConical } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

// EXPIRY SKEW — Martin's own option-chain indicator, PRACTICE ONLY
// (server/expiry_skew.ts). This page is the reading, today's score line, and the
// practice record next to what the backtest found. There is deliberately no Live
// switch anywhere on it: the rule passed one out-of-sample test with real
// caveats, and the point of this page is to watch it on days nobody has seen
// before any money goes on it. On/Off only stops or starts the logging.

const inr = (v: any, sign = false) => (v === null || v === undefined || isNaN(Number(v))) ? '—'
  : `${Number(v) < 0 ? '−' : sign && Number(v) > 0 ? '+' : ''}₹${Math.abs(Math.round(Number(v))).toLocaleString('en-IN')}`;
const px = (v: any) => (v === null || v === undefined || isNaN(Number(v))) ? '—' : `₹${Number(v).toFixed(2)}`;
const sg = (v: any, d = 2) => (v === null || v === undefined || isNaN(Number(v))) ? '—' : `${Number(v) >= 0 ? '+' : '−'}${Math.abs(Number(v)).toFixed(d)}`;
const dayLabel = (d?: string | null) => { if (!d) return ''; const x = new Date(d + 'T00:00:00Z'); return x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
const clock = (ms?: number | null) => { if (!ms) return ''; const d = new Date(ms + 5.5 * 3600000), h = d.getUTCHours(), m = d.getUTCMinutes(); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const lakh = (v: number) => `₹${(v / 100000).toFixed(2)} lakh`;

function ScoreBar({ comp }: { comp: number | null }) {
  // −3 … +3 across the bar; the two ticks are the ±1.5 lines the rule acts on.
  const pos = comp === null ? null : Math.max(0, Math.min(100, ((comp + 3) / 6) * 100));
  return (
    <div className="relative h-2.5 rounded-full bg-muted/60 mt-3 mb-5">
      <div className="absolute inset-y-0 left-0 w-1/4 rounded-l-full bg-rose-500/25" />
      <div className="absolute inset-y-0 right-0 w-1/4 rounded-r-full bg-emerald-500/25" />
      <div className="absolute -top-1 -bottom-1 left-1/4 w-px bg-rose-400/70" />
      <div className="absolute -top-1 -bottom-1 left-3/4 w-px bg-emerald-400/70" />
      <div className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px bg-border" />
      {pos !== null && <div className="absolute top-1/2 w-4 h-4 -mt-2 -ml-2 rounded-full bg-foreground border-2 border-background" style={{ left: `${pos}%` }} />}
      <span className="absolute top-4 left-1/4 -translate-x-1/2 text-[10px] text-muted-foreground font-mono">−1.5</span>
      <span className="absolute top-4 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground font-mono">0</span>
      <span className="absolute top-4 left-3/4 -translate-x-1/2 text-[10px] text-muted-foreground font-mono">+1.5</span>
    </div>
  );
}

export default function ExpirySkew() {
  const [busy, setBusy] = useState(false);
  const [showBacktest, setShowBacktest] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const { data, refetch, isError } = useQuery({
    queryKey: ['skew-status'],
    queryFn: async () => (await fetch('/api/skew/status')).json(),
    refetchInterval: 10000, refetchOnWindowFocus: true,
  });

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await fetch('/api/skew/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      const d = await r.json().catch(() => ({ ok: false }));
      if (d.ok) toast.success(enabled ? 'Expiry Skew practice is on' : 'Expiry Skew practice is off'); else toast.error(d.error || 'Could not change it');
      refetch();
    } catch (e: any) { toast.error(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  if (!data?.ok) {
    return <div className="px-2 py-3 md:p-8 max-w-[1100px] w-full mx-auto"><div className="bg-card border border-border rounded-xl p-6 text-sm text-muted-foreground">{isError || data?.error ? `Expiry Skew is not answering${data?.error ? `: ${data.error}` : ''}.` : 'Loading Expiry Skew…'}</div></div>;
  }

  const s = data, last = s.latest, comp: number | null = last && last.comp !== null ? Number(last.comp) : null, t = s.today, h = s.history, rec = s.record, bt = s.backtest;
  const side = comp === null ? 0 : comp >= s.rule.threshold ? 1 : comp <= -s.rule.threshold ? -1 : 0;
  const when = s.tdte === 0 ? 'expiry day' : s.tdte === 1 ? 'the day before expiry' : `${s.tdte} trading days before expiry`;
  const series = (s.bars || []).map((b: any) => ({ time: b.time, Score: b.comp === null ? null : +Number(b.comp).toFixed(2), Skew: b.z_skew === null ? null : +Number(b.z_skew).toFixed(2), Flow: b.flow === null ? null : +Number(b.flow).toFixed(2) }));
  const closedTrades = (s.trades || []).filter((x: any) => x.status === 'CLOSED');

  // One plain sentence for where things stand.
  let line = '';
  if (s.state === 'off') line = 'Switched off. Nothing is being read or logged.';
  else if (s.state === 'closed-day') line = `Market closed. Next session ${dayLabel(s.session)} — ${when}.`;
  else if (s.state === 'no-history') line = 'No score yet: the 60-day history is not loaded.';
  else if (s.state === 'before') line = 'First reading at 10:00 AM.';
  else if (s.state === 'watching') line = `Watching. A score of +${s.rule.threshold} or −${s.rule.threshold} before 2:30 PM starts today's practice trade.`;
  else if (s.state === 'no-signal') line = 'No signal today.';
  else if (s.state === 'open' && t) line = `Practice trade open since ${t.time}. It closes at 3:15 PM.`;
  else if (s.state === 'done-trade' && t) line = `Today's practice trade is closed: ${inr(t.pnl, true)}.`;
  else if (s.state === 'no-trade' && t) line = t.note || 'Today\'s signal was not traded.';
  // The score needs 20 days of history behind it; say so plainly while that is loading or has failed.
  const histLine = h.usable ? '' : h.loading ? `Loading the 60-day history: ${h.loaded} of ${h.toLoad} days.`
    : h.lastError ? `History could not be loaded: ${h.lastError}` : `History has ${h.days} of the ${h.needed} days needed before a score can be given.`;

  return (
    <div className="px-2 py-3 md:p-8 max-w-[1100px] w-full mx-auto pb-24 min-h-screen space-y-4">
      {/* header + switch */}
      <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <Scale className="w-5 h-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg md:text-2xl font-bold tracking-tight">Expiry Skew <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 align-middle">PRACTICE ONLY</span></h1>
            <div className="text-[11px] text-muted-foreground">Your own option-chain reading. It logs practice trades and never places an order.</div>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-popover rounded-xl p-1">
          {[false, true].map(on => (
            <button key={String(on)} disabled={busy} onClick={() => setEnabled(on)}
              className={cn('text-xs font-bold px-3 py-2 rounded-lg transition-colors disabled:opacity-40',
                s.enabled === on ? (on ? 'bg-sky-500 text-white' : 'bg-rose-500/80 text-white') : 'text-muted-foreground hover:text-foreground')}>
              {!on && <Power className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />}{on ? 'Practice' : 'Off'}
            </button>
          ))}
        </div>
      </div>

      {/* now */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Score{last ? ` at ${last.time}` : ''}</div>
            <div className={cn('text-4xl md:text-5xl font-bold font-mono leading-tight', side > 0 ? 'text-emerald-400' : side < 0 ? 'text-rose-400' : 'text-foreground')}>{comp === null ? '—' : sg(comp)}</div>
            <div className="text-xs mt-0.5">
              <span className={cn('font-bold', side > 0 ? 'text-emerald-400' : side < 0 ? 'text-rose-400' : 'text-muted-foreground')}>{comp === null ? 'No reading yet' : side > 0 ? 'Call side' : side < 0 ? 'Put side' : 'No signal'}</span>
              {last && comp !== null && <span className="text-muted-foreground"> · skew {sg(last.z_skew)} · flow {sg(last.flow)}</span>}
            </div>
          </div>
          <div className="text-left md:text-right text-xs text-muted-foreground">
            <div>Expiry <span className="text-foreground font-semibold">{dayLabel(s.expiry)}</span></div>
            <div>{s.trading ? 'Today is ' : `${dayLabel(s.session)} is `}{when}</div>
          </div>
        </div>
        <ScoreBar comp={comp} />
        <div className="text-sm">{line}</div>
        {histLine && s.state !== 'off' && <div className="text-xs text-amber-300 mt-1">{histLine}</div>}
        {s.live?.note && s.state !== 'off' && s.trading && <div className="text-xs text-amber-300 mt-1">{s.live.note}</div>}

        {t && (t.status === 'OPEN' || t.status === 'CLOSED') && (
          <div className={cn('mt-3 rounded-xl border-2 p-3 flex items-center justify-between gap-3 flex-wrap', 'border-sky-500/40 bg-sky-500/5')}>
            <div className="min-w-0">
              <div className="font-bold text-base">{t.tradingsymbol} <span className="text-[11px] font-semibold text-muted-foreground">PRACTICE · {t.lot} qty</span></div>
              <div className="text-xs text-muted-foreground">Bought {px(t.entry_px)} at {t.time} (score {sg(t.comp)}){t.status === 'CLOSED' ? ` → sold ${px(t.exit_px)} at 3:15 PM` : t.ltp ? ` · now ${px(t.ltp)}` : ''}</div>
            </div>
            <div className={cn('text-xl font-bold font-mono', (t.status === 'CLOSED' ? t.pnl : t.running) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
              {t.status === 'CLOSED' ? inr(t.pnl, true) : t.running !== undefined ? inr(t.running, true) : '—'}
              <div className="text-[10px] font-normal text-muted-foreground text-right">after charges{t.status === 'OPEN' ? ', if sold now' : ''}</div>
            </div>
          </div>
        )}
      </div>

      {/* today's line */}
      {series.length > 1 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">Today — score every 5 minutes</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={series} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} interval="preserveStartEnd" minTickGap={36} stroke="var(--border)" />
              <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} width={44} domain={[(min: number) => Math.min(-2, Math.floor(min)), (max: number) => Math.max(2, Math.ceil(max))]} stroke="var(--border)" />
              <ReferenceLine y={s.rule.threshold} stroke="#34d399" strokeDasharray="4 4" />
              <ReferenceLine y={-s.rule.threshold} stroke="#fb7185" strokeDasharray="4 4" />
              <ReferenceLine y={0} stroke="var(--border)" />
              <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 12, fontSize: 12 }} />
              <Line type="linear" dataKey="Skew" stroke="#f59e0b" dot={false} strokeWidth={1} strokeOpacity={0.6} connectNulls isAnimationActive={false} />
              <Line type="linear" dataKey="Flow" stroke="#38bdf8" dot={false} strokeWidth={1} strokeOpacity={0.6} connectNulls isAnimationActive={false} />
              <Line type="linear" dataKey="Score" stroke="var(--primary)" dot={false} strokeWidth={2.5} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="flex gap-4 text-[11px] text-muted-foreground mt-1">
            <span><span className="inline-block w-3 h-0.5 bg-primary align-middle mr-1" />Score</span>
            <span><span className="inline-block w-3 h-0.5 bg-amber-500 align-middle mr-1" />Skew</span>
            <span><span className="inline-block w-3 h-0.5 bg-sky-400 align-middle mr-1" />Flow</span>
            <span className="ml-auto">dashed lines: ±{s.rule.threshold}</span>
          </div>
        </div>
      )}

      {/* practice record */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-sky-400" />
          <h2 className="font-bold">Practice record</h2>
          <span className="text-[11px] text-muted-foreground">since {dayLabel(rec.since)}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          {[
            ['Trades', String(rec.closed), `backtest: about ${bt.tradesPerYear} a year`],
            ['Total', inr(rec.total, true), 'after charges'],
            ['Per trade', rec.perTrade === null ? '—' : inr(rec.perTrade, true), `backtest: ${inr(bt.test.perTrade, true)}`],
            ['Wins', rec.winPct === null ? '—' : `${rec.winPct}%`, `backtest: ${bt.fit.winPct}–${bt.test.winPct}%`],
            ['Worst trade', rec.worst === null ? '—' : inr(rec.worst), `backtest: ${inr(bt.fit.worst)}`],
          ].map(([k, v, sub]) => (
            <div key={k} className="rounded-lg bg-muted/40 p-2">
              <div className="text-[10px] uppercase text-muted-foreground">{k}</div>
              <div className="font-mono font-bold text-sm">{v}</div>
              <div className="text-[10px] text-muted-foreground">{sub}</div>
            </div>
          ))}
        </div>
        <div>
          <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden"><div className="h-full bg-sky-500" style={{ width: `${Math.min(100, (rec.closed / bt.tradesToJudge) * 100)}%` }} /></div>
          <div className="text-[11px] text-muted-foreground mt-1">{rec.closed} of about {bt.tradesToJudge} practice trades needed before this record says anything about the rule. Until then a good or bad run is just a run.{rec.missed ? ` ${rec.missed} signal${rec.missed > 1 ? 's' : ''} missed (app not running).` : ''}</div>
        </div>
        {(s.trades || []).length === 0 && <div className="text-xs text-muted-foreground">No practice trades yet.</div>}
        {(s.trades || []).slice(0, 40).map((x: any) => (
          <div key={x.day} className="flex items-center gap-2 text-xs border-b border-border/50 pb-1 last:border-0">
            <span className="font-mono text-muted-foreground w-20 shrink-0">{dayLabel(x.day)}</span>
            <span className="font-mono text-muted-foreground w-16 shrink-0">{x.time}</span>
            <span className={cn('font-bold w-10 shrink-0', x.side > 0 ? 'text-emerald-400' : 'text-rose-400')}>{x.side > 0 ? 'Call' : 'Put'}</span>
            <span className="flex-1 text-muted-foreground truncate">
              {x.status === 'CLOSED' || x.status === 'OPEN' ? `${x.tradingsymbol} · ${px(x.entry_px)}${x.status === 'CLOSED' ? ` → ${px(x.exit_px)}` : ' · open'}` : x.note || x.status.toLowerCase()}
            </span>
            <span className={cn('font-mono font-bold shrink-0', x.status !== 'CLOSED' ? 'text-muted-foreground' : x.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
              {x.status === 'CLOSED' ? inr(x.pnl, true) : x.status === 'OPEN' ? 'open' : x.status === 'MISSED' ? 'missed' : 'no price'}
            </span>
          </div>
        ))}
        {closedTrades.length > 0 && <div className="text-[10px] text-muted-foreground">Each result is one lot, after today's charges and {s.rule.slip} point of slippage each way.</div>}
      </div>

      {/* what the backtest found */}
      <div className="bg-card border border-border rounded-xl p-4">
        <button onClick={() => setShowBacktest(v => !v)} className="flex items-center gap-1.5 font-bold w-full text-left">
          {showBacktest ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} What the backtest found
        </button>
        {showBacktest && (
          <div className="mt-3 space-y-3 text-xs">
            <div className="grid md:grid-cols-2 gap-2">
              {[bt.test, bt.fit].map((p: any) => (
                <div key={p.period} className="rounded-lg bg-muted/40 p-3">
                  <div className="text-[10px] uppercase text-muted-foreground">{p.label} · {p.period}</div>
                  <div className="font-mono font-bold text-sm">{lakh(p.total)} · {p.trades} trades</div>
                  <div className="text-muted-foreground">{inr(p.perTrade, true)} a trade · {p.winPct}% wins · worst <span className="whitespace-nowrap">{inr(p.worst)}</span> · deepest fall <span className="whitespace-nowrap">{inr(p.drawdown)}</span></div>
                </div>
              ))}
            </div>
            <div className="flex items-end gap-2 h-24">
              {bt.byYear.map((y: any) => { const max = Math.max(...bt.byYear.map((q: any) => Math.abs(q.pnl))); return (
                <div key={y.y} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div className="text-[10px] font-mono text-muted-foreground">{y.pnl >= 0 ? '' : '−'}{Math.round(Math.abs(y.pnl) / 1000)}k</div>
                  <div className={cn('w-full rounded-t', y.pnl >= 0 ? 'bg-emerald-500/60' : 'bg-rose-500/60')} style={{ height: `${Math.max(3, (Math.abs(y.pnl) / max) * 70)}%` }} />
                  <div className="text-[10px] text-muted-foreground">{y.y}</div>
                </div>); })}
            </div>
            <ul className="space-y-1 text-muted-foreground list-disc pl-4">
              <li>Profit came in bursts: 2021, 2023 and 2025 were about flat. The longest stretch without a new high was {Math.round(bt.longestFlatDays / 30)} months.</li>
              <li>No stop: the option costs about ₹14,400 and single trades lost up to ₹14,000. A ₹3,000 stop halved the profit; a ₹750 stop wiped it out.</li>
              <li>In the two test years, just following the day's direction at the same moments made about three-quarters as much, so those years flattered it.</li>
              <li>Average win {inr(bt.avgWin)}, average loss {inr(bt.avgLoss)}. {bt.note}</li>
            </ul>
          </div>
        )}
      </div>

      {/* how it works */}
      <div className="bg-card border border-border rounded-xl p-4">
        <button onClick={() => setShowHow(v => !v)} className="flex items-center gap-1.5 font-bold w-full text-left">
          {showHow ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} How it works
        </button>
        {showHow && (
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <p><b className="text-foreground">Skew</b> compares how expensive the put 200 points below NIFTY is against the call 200 points above. <b className="text-foreground">Flow</b> is whether puts or calls are gaining open interest and volume near the money. Each is scored against its own last 60 trading days, and the score is the average of the two.</p>
            <p><b className="text-foreground">The rule:</b> the first score of +{s.rule.threshold} or more (call side) or −{s.rule.threshold} or less (put side) between {s.rule.window} buys the option {s.rule.itm} points in the money, one trade a day, held to {s.rule.exit}. It was fixed on {dayLabel(s.rule.frozenOn)} and is not tuned while it is on test.</p>
            <p>Most signals come on expiry day and the day before.</p>
          </div>
        )}
      </div>

      <div className="text-[11px] text-muted-foreground px-1">
        History: {h.days} days{h.from ? ` (${dayLabel(h.from)} – ${dayLabel(h.to)})` : ''}{h.loading ? ` · loading ${h.loaded}/${h.toLoad}` : ''}{h.lastError && !h.loading ? ` · last load error: ${h.lastError}` : ''}
        {' · '}Zerodha {s.live?.zerodha ? 'connected' : 'not logged in'}{s.live?.lastBarAt ? ` · last reading ${clock(s.live.lastBarAt)}` : ''}
      </div>
    </div>
  );
}
