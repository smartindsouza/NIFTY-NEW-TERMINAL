import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Gauge, RefreshCw, AlertTriangle, Activity, ArrowLeftRight } from 'lucide-react';

interface GapRiskData {
  success: boolean;
  spot: number | null;
  atmStrike: number | null;
  straddle: number | null;       // points (ATM call + put)
  impliedMovePct: number | null; // %
  expiry: string | null;
  vix: number | null;
  asOf: number;
}

const LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
type Level = typeof LEVELS[number] | 'UNKNOWN';

// Heuristic thresholds (NIFTY). These are deliberately simple — tune to taste.
const vixIdx = (v: number | null) => (v == null ? -1 : v < 12 ? 0 : v <= 16 ? 1 : 2);
const moveIdx = (p: number | null) => (p == null ? -1 : p < 0.4 ? 0 : p <= 0.8 ? 1 : 2);

const STYLE: Record<Level, { text: string; bg: string; border: string; dot: string; blurb: string }> = {
  LOW: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', dot: 'bg-emerald-500', blurb: 'Quiet setup — a small / flat-ish open is most likely.' },
  MEDIUM: { text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', dot: 'bg-amber-500', blurb: 'Moderate gap risk — size overnight exposure with care.' },
  HIGH: { text: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/30', dot: 'bg-rose-500', blurb: 'Elevated gap risk — consider carrying less, hedging, or staying flat.' },
  UNKNOWN: { text: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/30', dot: 'bg-slate-500', blurb: 'Not enough live data yet — check during market hours with Kite connected.' },
};

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card rounded-2xl p-4 flex flex-col gap-1 min-w-0">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xl font-bold font-mono text-foreground truncate">{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground truncate">{sub}</span>}
    </div>
  );
}

export default function GapRisk() {
  const [eventTonight, setEventTonight] = useState<boolean>(() => {
    try { return localStorage.getItem('gap_event_tonight') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('gap_event_tonight', eventTonight ? '1' : '0'); } catch { /* ignore */ }
  }, [eventTonight]);

  const { data, refetch, isFetching, isLoading } = useQuery({
    queryKey: ['gap-risk'],
    queryFn: async () => {
      const r = await fetch('/api/gap-risk');
      if (!r.ok) throw new Error('Failed to load gap risk');
      return (await r.json()) as GapRiskData;
    },
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });

  const vix = data?.vix ?? null;
  const movePct = data?.impliedMovePct ?? null;
  const straddle = data?.straddle ?? null;

  const vL = vixIdx(vix);
  const mL = moveIdx(movePct);
  let idx = Math.max(vL, mL);
  if (eventTonight && idx < 2) idx = 2; // a known major event is the classic gap driver
  const level: Level = idx < 0 ? 'UNKNOWN' : LEVELS[idx];
  const s = STYLE[level];

  const sameDayExpiry = (() => {
    if (!data?.expiry) return false;
    try { return new Date(data.expiry).toDateString() === new Date().toDateString(); } catch { return false; }
  })();

  return (
    <div className="px-2 py-3 md:p-8 max-w-[900px] w-full mx-auto pb-24 min-h-screen">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Gauge className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight">Gap Risk Gauge</h1>
            <p className="text-xs text-muted-foreground">Expected overnight <span className="text-foreground">magnitude</span> — not direction.</p>
          </div>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-card hover:bg-popover transition-colors text-muted-foreground">
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      {/* Main gauge */}
      <div className={cn('rounded-2xl p-5 border mb-4', s.bg, s.border)}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Overnight gap risk</span>
          <span className={cn('w-2.5 h-2.5 rounded-full', s.dot, level !== 'UNKNOWN' && 'animate-pulse')} />
        </div>
        <div className={cn('text-3xl md:text-4xl font-bold tracking-tight mb-2', s.text)}>{level}</div>
        <p className="text-sm text-muted-foreground">{s.blurb}</p>

        {/* 3-segment bar */}
        <div className="flex items-center gap-1.5 mt-4">
          {LEVELS.map((lv, i) => {
            const active = level !== 'UNKNOWN' && i <= idx;
            const seg = STYLE[lv];
            return (
              <div key={lv} className="flex-1 flex flex-col items-center gap-1">
                <div className={cn('h-1.5 w-full rounded-full', active ? seg.dot : 'bg-muted')} />
                <span className={cn('text-[9px] font-semibold', level === lv ? seg.text : 'text-muted-foreground/60')}>{lv}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-2 gap-2.5 md:gap-3 mb-4">
        <Metric
          label="India VIX"
          value={vix != null ? vix.toFixed(2) : '—'}
          sub={vix != null ? (vL === 0 ? 'calm' : vL === 1 ? 'moderate' : 'elevated') : 'needs Kite login'}
        />
        <Metric
          label="Implied move (ATM straddle)"
          value={straddle != null ? `±${straddle} pts` : '—'}
          sub={movePct != null ? `~${movePct}% of spot` : 'needs live chain'}
        />
      </div>

      {/* Event toggle */}
      <button
        onClick={() => setEventTonight((v) => !v)}
        className={cn('w-full flex items-center justify-between gap-3 rounded-2xl p-4 border transition-colors mb-4',
          eventTonight ? 'bg-rose-500/10 border-rose-500/30' : 'bg-card border-transparent')}
      >
        <span className="flex items-center gap-2.5 text-left">
          <AlertTriangle className={cn('w-4 h-4 shrink-0', eventTonight ? 'text-rose-400' : 'text-muted-foreground')} />
          <span className="text-sm">
            <span className="font-semibold">Major event tonight / tomorrow morning?</span>
            <span className="block text-[11px] text-muted-foreground">FOMC · RBI · US CPI/jobs · Budget · big results · election results</span>
          </span>
        </span>
        <span className={cn('relative w-10 h-6 rounded-full transition-colors shrink-0', eventTonight ? 'bg-rose-500' : 'bg-muted')}>
          <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', eventTonight ? 'left-[18px]' : 'left-0.5')} />
        </span>
      </button>

      {/* How to read */}
      <div className="bg-card/60 rounded-2xl p-4 text-[12px] text-muted-foreground leading-relaxed">
        <div className="flex items-center gap-2 mb-2 text-foreground font-semibold text-xs uppercase tracking-wider">
          <Activity className="w-3.5 h-3.5 text-primary" /> How to read this
        </div>
        <p className="mb-2">
          The ATM straddle is the option market's own estimate of the move into expiry
          {data?.expiry ? <> ({sameDayExpiry ? 'today' : new Date(data.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })})</> : ''}.
          A bigger number means a bigger expected swing. India VIX is the broader volatility read.
        </p>
        <p className="mb-2 flex items-start gap-1.5">
          <ArrowLeftRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
          This tells you <span className="text-foreground">how big</span> a gap is likely, never <span className="text-foreground">which way</span>. For direction, watch GIFT Nifty in the morning before 9:15.
        </p>
        {!sameDayExpiry && data?.expiry && (
          <p className="text-amber-400/80">Note: nearest expiry isn't today, so the straddle covers more than just the overnight gap — treat it as an upper-bound on overnight magnitude.</p>
        )}
        <p className="mt-2 opacity-70">Educational tool, not investment advice. When risk reads high, the safe play is managing exposure — not guessing direction.</p>
      </div>

      {isLoading && <div className="text-center text-muted-foreground py-6 text-sm">Loading…</div>}
    </div>
  );
}
