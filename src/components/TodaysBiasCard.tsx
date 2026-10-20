import { useEffect, useState } from 'react';
import { Compass, ChevronDown, TrendingUp, TrendingDown, MoveHorizontal, Bell, BellRing, BellOff, TriangleAlert, History, Clock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useTodayBias, useBiasHistory, isRecord, istToday, hhmmIST, fmtLevel, type BiasRecord, type BiasRead } from '../lib/bias';

// "Today's Bias" — the morning note posted by the scheduled task at ~09:33 IST.
// Top of the Home screen, collapsible. Display only: it never trades.

const TONE: Record<BiasRead, { word: string; Icon: any; pill: string; border: string; text: string; tint: string }> = {
  bullish: { word: 'BULLISH', Icon: TrendingUp, pill: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
    border: 'border-l-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', tint: 'from-emerald-500/10' },
  bearish: { word: 'BEARISH', Icon: TrendingDown, pill: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40',
    border: 'border-l-rose-500', text: 'text-rose-700 dark:text-rose-300', tint: 'from-rose-500/10' },
  neutral: { word: 'NEUTRAL', Icon: MoveHorizontal, pill: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',
    border: 'border-l-amber-500', text: 'text-amber-700 dark:text-amber-300', tint: 'from-amber-500/10' },
};
const CHIP: Record<BiasRead, string> = {
  bullish: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  bearish: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
  neutral: 'bg-muted text-muted-foreground border-border',
};
const LS_COLLAPSED = 'biasCardCollapsed';

const dayLabel = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) ? d : new Date(t).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' });
};

function Level({ label, value, tone }: { label: string; value: number | null | undefined; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</div>
      <div className={cn('text-sm font-mono font-semibold tabular-nums truncate', tone)}>{fmtLevel(value)}</div>
    </div>
  );
}

function NotifyButton() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [perm, setPerm] = useState<string>(() => (supported ? Notification.permission : 'unsupported'));
  if (!supported) return null;
  if (perm === 'granted') return <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><BellRing size={12} /> Browser alerts on</span>;
  if (perm === 'denied') return <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title="Allow notifications for this site in the browser settings"><BellOff size={12} /> Browser alerts blocked</span>;
  return (
    <button
      onClick={async (e) => { e.stopPropagation(); try { setPerm(await Notification.requestPermission()); } catch (err) {} }}
      className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 h-7 rounded-md border border-border bg-card hover:bg-muted transition-colors">
      <Bell size={12} /> Enable browser alerts
    </button>
  );
}

function PastBiasesList() {
  const { data, isLoading } = useBiasHistory(true, 30);
  const rows = data?.records || [];
  return (
    <div className="rounded-lg border border-border divide-y divide-border/60 max-h-72 overflow-y-auto">
      {isLoading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>}
      {!isLoading && rows.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No biases recorded yet.</div>}
      {rows.map((r) => (
        <div key={r.date} className="flex items-center gap-2 px-3 py-2 text-xs">
          <span className="w-[86px] shrink-0 font-mono text-muted-foreground">{dayLabel(r.date)}</span>
          {r.status === 'ok' && r.bias
            ? <span className={cn('shrink-0 w-[64px] text-center px-1.5 py-0.5 rounded border text-[10px] font-bold', TONE[r.bias].pill)}>{TONE[r.bias].word}</span>
            : <span className="shrink-0 w-[64px] text-center px-1.5 py-0.5 rounded border border-border text-[10px] font-bold text-muted-foreground">{r.status === 'no_session' ? 'NO SESSION' : 'ERROR'}</span>}
          <span className="shrink-0 w-[64px] text-muted-foreground capitalize">{r.confidence ?? '—'}</span>
          <span className="min-w-0 flex-1 truncate" title={r.headline}>{r.headline}</span>
          {r.outcome && <span className="shrink-0 text-[10px] text-muted-foreground">{r.outcome}</span>}
        </div>
      ))}
    </div>
  );
}

function Details({ r }: { r: BiasRecord }) {
  const L = r.levels || {};
  const us = r.us30;
  const extra: [string, number | null | undefined][] = [
    ['1st candle H', L.first_candle_high], ['1st candle L', L.first_candle_low],
    ['Prev high', L.prev_high], ['Prev low', L.prev_low], ['Prev close', L.prev_close],
    ['CPR pivot', L.cpr_pivot], ['CPR TC', L.cpr_tc], ['CPR BC', L.cpr_bc],
  ];
  return (
    <div className="space-y-3">
      {r.summary && <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/90">{r.summary}</p>}
      {r.factors?.some((f) => f.note) && (
        <ul className="space-y-1">
          {r.factors.filter((f) => f.note).map((f, i) => (
            <li key={i} className="text-xs text-muted-foreground"><span className={cn('font-semibold', f.read === 'neutral' ? 'text-foreground/80' : TONE[f.read].text)}>{f.name}:</span> {f.note}</li>
          ))}
        </ul>
      )}
      {us && (
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/80">US30</span>{' '}
          {fmtLevel(us.close)}
          {us.change_pts !== null && us.change_pts !== undefined && (
            <span className={cn('ml-1 font-mono', us.change_pts > 0 ? 'text-emerald-600 dark:text-emerald-400' : us.change_pts < 0 ? 'text-rose-600 dark:text-rose-400' : '')}>
              {us.change_pts > 0 ? '+' : ''}{fmtLevel(us.change_pts)}{us.change_pct !== null && us.change_pct !== undefined ? ` (${us.change_pct > 0 ? '+' : ''}${us.change_pct.toFixed(2)}%)` : ''}
            </span>
          )}
          {us.driver && <span> — {us.driver}</span>}
        </div>
      )}
      {r.gap && (r.gap.actual_open_pts !== null || r.gap.gift_implied_pts !== null) && (
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground/80">Gap</span> opened {fmtLevel(r.gap.actual_open_pts)} pts vs GIFT-implied {fmtLevel(r.gap.gift_implied_pts)} pts
        </div>
      )}
      {extra.some(([, v]) => v !== null && v !== undefined) && (
        <div className="grid grid-cols-4 md:grid-cols-8 gap-1.5">
          {extra.map(([k, v]) => <Level key={k} label={k} value={v} />)}
        </div>
      )}
      {r.generated_at && <div className="text-[10px] text-muted-foreground">Generated {hhmmIST(r.generated_at)} IST · received {hhmmIST(r.received_at)} IST</div>}
    </div>
  );
}

export function TodaysBiasCard() {
  const { data, isLoading, isError } = useTodayBias();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(LS_COLLAPSED) === '1'; } catch (e) { return false; } });
  const [showDetails, setShowDetails] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); } catch (e) {} }, [collapsed]);

  const rec = isRecord(data) ? data : null;
  const today = istToday();
  const stale = !!rec && rec.date !== today;
  const live = !!rec && !stale && rec.status === 'ok' && !!rec.bias;
  const warn = !!rec && !stale && rec.status !== 'ok';
  const tone = live ? TONE[rec!.bias!] : null;

  // Header line, whatever the state.
  let title: React.ReactNode, sub: React.ReactNode = null;
  if (isLoading) title = <span className="text-muted-foreground">Loading today's bias…</span>;
  else if (isError) title = <span className="text-muted-foreground">Bias unavailable — could not reach the terminal.</span>;
  else if (!rec) title = <span className="text-muted-foreground">Awaiting 9:32 bias…</span>;
  else title = <span className={cn('font-semibold', (stale || warn) && 'text-muted-foreground')}>{rec.headline}</span>;

  return (
    <Card
      data-testid="todays-bias"
      className={cn('relative overflow-hidden border border-border border-l-4 p-0 gap-0',
        tone ? tone.border : warn ? 'border-l-amber-500/60' : 'border-l-muted-foreground/30')}>
      {tone && <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-r to-transparent', tone.tint)} />}
      <button
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="relative w-full flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 text-left">
        <Compass size={16} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Today's bias</span>
        {live && (
          <span className={cn('shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-bold', tone!.pill)}>
            <tone.Icon size={12} /> {tone!.word}
          </span>
        )}
        {live && rec!.confidence && (
          <span className="shrink-0 hidden sm:inline px-1.5 py-0.5 rounded border border-border text-[10px] font-semibold uppercase text-muted-foreground">{rec!.confidence}</span>
        )}
        {stale && <span className="shrink-0 px-1.5 py-0.5 rounded border border-border text-[10px] font-bold text-muted-foreground">STALE · {dayLabel(rec!.date)}</span>}
        {warn && <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-[10px] font-bold text-amber-700 dark:text-amber-300"><TriangleAlert size={11} /> {rec!.status === 'no_session' ? 'NO SESSION' : 'ERROR'}</span>}
        <span className={cn('min-w-0 flex-1 text-sm', collapsed ? 'truncate' : 'hidden md:block md:truncate')}>{title}</span>
        {rec && !stale && (
          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-muted-foreground font-mono" title={`Received ${rec.received_at}`}>
            <Clock size={11} /> {hhmmIST(rec.received_at)}
          </span>
        )}
        <ChevronDown size={16} className={cn('shrink-0 text-muted-foreground transition-transform', !collapsed && 'rotate-180')} />
      </button>

      {!collapsed && (
        <div className="relative px-3 md:px-4 pb-3 space-y-3">
          {/* Headline in full on phones (the header row truncates it). */}
          <div className="md:hidden text-sm">{title}</div>

          {!rec && !isLoading && !isError && (
            <p className="text-xs text-muted-foreground">The scheduled analysis posts here at about 09:33 IST on trading days. You'll get an alert when it arrives.</p>
          )}
          {stale && <p className="text-xs text-muted-foreground">This is the note from {dayLabel(rec!.date)}, not today's. Today's has not arrived yet.</p>}
          {warn && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              {rec!.error || (rec!.status === 'no_session' ? 'No trading session today.' : 'The analysis could not complete.')}
            </div>
          )}

          {live && (
            <>
              <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5">
                <Level label="Trigger" value={rec!.levels?.trigger} tone={tone!.text} />
                <Level label="Invalidation" value={rec!.levels?.invalidation} />
                <Level label="Next ref" value={rec!.levels?.next_reference} />
                <Level label="OR high" value={rec!.levels?.or_high} />
                <Level label="OR low" value={rec!.levels?.or_low} />
              </div>
              {rec!.factors?.length > 0 && (
                <button onClick={() => setShowDetails((s) => !s)} className="flex flex-wrap gap-1.5 text-left" title="Show the full note">
                  {rec!.factors.map((f, i) => (
                    <span key={i} className={cn('px-2 py-0.5 rounded-full border text-[11px] font-medium', CHIP[f.read] || CHIP.neutral)}>{f.name}</span>
                  ))}
                </button>
              )}
            </>
          )}

          {rec && !stale && (rec.summary || rec.us30 || rec.factors?.length) && (
            <div>
              <button onClick={() => setShowDetails((s) => !s)} className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors">
                {showDetails ? 'Hide full note' : 'Full note, US30 & levels'}
                <ChevronDown size={12} className={cn('transition-transform', showDetails && 'rotate-180')} />
              </button>
              {showDetails && <div className="mt-2"><Details r={rec} /></div>}
            </div>
          )}

          <div className="pt-2 border-t border-border/60 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button onClick={() => setHistOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors">
                <History size={12} /> Past biases (30 days)
                <ChevronDown size={12} className={cn('transition-transform', histOpen && 'rotate-180')} />
              </button>
              <NotifyButton />
            </div>
            {histOpen && <PastBiasesList />}
          </div>
        </div>
      )}
    </Card>
  );
}

export default TodaysBiasCard;
