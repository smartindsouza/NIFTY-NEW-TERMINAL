import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Wind, RefreshCw, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

function Card({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'pos' | 'neg' | 'warn' | 'neutral' }) {
  const c = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-foreground';
  return (
    <div className="rounded-xl bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-base font-bold mt-0.5 font-mono', c)}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

export default function PremiumPulse() {
  const [side, setSide] = useState<'CE' | 'PE'>('CE');
  const { data, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ['premium-pulse', side],
    queryFn: async () => { const r = await fetch(`/api/premium-pulse?side=${side}`); return await r.json(); },
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });

  const ok = data?.success;
  const lvl = ok ? data.level : null;
  const banner = lvl === 'RESPONSIVE' ? 'bg-emerald-500/10 border-emerald-500/30' : lvl === 'SLUGGISH' ? 'bg-rose-500/10 border-rose-500/30' : 'bg-card border-border';
  const bannerText = lvl === 'RESPONSIVE' ? 'text-emerald-400' : lvl === 'SLUGGISH' ? 'text-rose-400' : 'text-muted-foreground';

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 pb-24">
      <div className="flex items-center gap-2 mb-1">
        <Wind className="w-5 h-5 text-sky-400" />
        <h1 className="text-lg font-bold text-foreground">Premium Pulse</h1>
      </div>
      <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
        How much the ATM premium actually moves <span className="text-foreground">per index point</span> right now — measured live and compared to its theoretical delta. When realized lags theory, an <span className="text-foreground">IV/theta headwind</span> is sapping the move; the IV trend below shows why.
      </p>

      {/* CE/PE toggle */}
      <div className="flex items-center gap-2 mb-4">
        {(['CE', 'PE'] as const).map((s) => (
          <button key={s} onClick={() => setSide(s)}
            className={cn('text-sm font-semibold px-4 py-1.5 rounded-xl transition-colors',
              side === s ? (s === 'CE' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400') : 'bg-card text-muted-foreground hover:text-foreground')}>
            ATM {s}
          </button>
        ))}
        <button onClick={() => refetch()} disabled={isFetching}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl bg-popover hover:bg-muted text-foreground disabled:opacity-50 transition-colors ml-auto">
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : 'Refresh'}
        </button>
      </div>

      {!ok ? (
        <div className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">{data?.error || 'Loading…'}</div>
      ) : (
        <>
          {/* Verdict */}
          <div className={cn('rounded-2xl border p-4 mb-4', banner)}>
            <div className={cn('text-xs font-bold uppercase tracking-wider mb-1.5', bannerText)}>
              {lvl === 'RESPONSIVE' ? 'Responsive' : lvl === 'SLUGGISH' ? 'Sluggish' : 'Moderate'}
            </div>
            <div className="text-sm text-foreground/90 leading-relaxed">{data.verdict}</div>
          </div>

          {/* Core numbers */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5 mb-4">
            <Card label="ATM" value={String(data.atmStrike)} hint={`${side} \u20b9${data.premium ?? '—'}`} />
            <Card label="Realized" value={data.realizedDelta != null ? `\u20b9${Math.abs(data.realizedDelta).toFixed(2)}` : '—'} hint="per point" tone={lvl === 'RESPONSIVE' ? 'pos' : lvl === 'SLUGGISH' ? 'neg' : 'neutral'} />
            <Card label="Theoretical" value={`\u20b9${Math.abs(data.theoDelta).toFixed(2)}`} hint="delta/point" />
            <Card label="Capture" value={data.capture != null ? `${data.capture}%` : '—'} tone={data.capture != null ? (data.capture >= 85 ? 'pos' : data.capture < 55 ? 'neg' : 'warn') : 'neutral'} />
            <Card label="IV now" value={data.ivNow != null ? `${data.ivNow}%` : '—'} hint={data.ivOpen != null ? `open ${data.ivOpen}%` : undefined} />
            <Card label="IV today" value={data.ivTrend != null ? `${data.ivTrend > 0 ? '+' : ''}${data.ivTrend}` : '—'} hint="pts" tone={data.ivTrend == null ? 'neutral' : data.ivTrend <= -0.4 ? 'neg' : data.ivTrend >= 0.4 ? 'pos' : 'neutral'} />
          </div>

          {/* IV trend chip */}
          <div className="flex items-center gap-2 mb-4 text-sm">
            {data.ivTrend != null && data.ivTrend <= -0.4 && <span className="flex items-center gap-1.5 text-rose-400"><TrendingDown className="w-4 h-4" /> IV bleeding — vega headwind</span>}
            {data.ivTrend != null && data.ivTrend >= 0.4 && <span className="flex items-center gap-1.5 text-emerald-400"><TrendingUp className="w-4 h-4" /> IV rising — vega tailwind</span>}
            {data.ivTrend != null && data.ivTrend > -0.4 && data.ivTrend < 0.4 && <span className="flex items-center gap-1.5 text-muted-foreground"><Minus className="w-4 h-4" /> IV roughly flat</span>}
            {data.dayEff != null && <span className="text-muted-foreground ml-auto text-xs">Day: index {data.idxNet > 0 ? '+' : ''}{data.idxNet} → premium {data.premNet > 0 ? '+' : ''}{data.premNet} (\u20b9{Math.abs(data.dayEff).toFixed(2)}/pt)</span>}
          </div>

          {/* Chart: realized ₹/pt and IV over the session */}
          {Array.isArray(data.series) && data.series.length > 2 && (
            <div className="rounded-2xl bg-card p-4 mb-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">Today — realized \u20b9/pt (left) vs IV% (right)</div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.series} margin={{ top: 5, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="hm" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} interval="preserveStartEnd" minTickGap={28} />
                  <YAxis yAxisId="l" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={38} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={36} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} />
                  <Line yAxisId="l" type="monotone" dataKey="realized" name="₹/pt" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} connectNulls />
                  <Line yAxisId="r" type="monotone" dataKey="iv" name="IV%" stroke="#f59e0b" dot={false} strokeWidth={1.5} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
        Realized ₹/pt is a rolling regression of premium change vs index change over the last {ok ? data.window : 10} candles for the current ATM {side}. It blends delta, IV and theta — so it's the real-world responsiveness, not a textbook number. Educational only, not advice.
      </p>
    </div>
  );
}
