import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Radio, RefreshCw, CheckCircle2, XCircle, TrendingUp, TrendingDown, Minus } from 'lucide-react';

const fmtTime = (s: string) => { try { return new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }); } catch { return s; } };

function OptionCard({ side, data, active }: { side: 'CE' | 'PE'; data: any; active: boolean }) {
  const label = side === 'CE' ? 'ATM Call (CE)' : 'ATM Put (PE)';
  if (!data || !data.available) {
    return (
      <div className={cn('rounded-xl p-4 border bg-card', active ? 'border-primary/40' : 'border-transparent')}>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
        <div className="text-sm text-muted-foreground">No live option data</div>
      </div>
    );
  }
  const confirms = data.confirms;
  return (
    <div className={cn('rounded-xl p-4 border', active ? 'border-primary/50 bg-primary/5' : 'border-transparent bg-card')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
        {active && <span className="text-[9px] font-bold text-primary uppercase">you'd buy this</span>}
      </div>
      <div className="text-xs font-mono text-muted-foreground mb-2 truncate">{data.tradingsymbol}</div>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">RSI</div>
          <div className={cn('text-2xl font-bold font-mono', confirms ? 'text-emerald-400' : 'text-muted-foreground')}>{data.rsi ?? '—'}</div>
        </div>
        <div className={cn('flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg',
          confirms ? 'bg-emerald-500/15 text-emerald-400' : 'bg-muted text-muted-foreground')}>
          {confirms ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          {confirms ? 'above 40' : 'below 40'}
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground mt-2">LTP {data.ltp} · {fmtTime(data.time)} IST</div>
    </div>
  );
}

export default function LiveSignal() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['live-signal'],
    queryFn: async () => { const r = await fetch('/api/signal/live'); return await r.json(); },
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });

  const ok = data?.success;
  const idx = data?.index;
  const dir: 'LONG' | 'SHORT' | null = idx?.firedOnLast ? idx.lastSignal?.dir : null;
  const side = dir === 'LONG' ? data?.ce : dir === 'SHORT' ? data?.pe : null;
  const confirmed = !!(dir && side?.confirms);

  let verdict = { text: 'No active entry signal on the latest candle.', tone: 'idle' as 'idle' | 'go' | 'wait' };
  if (dir && confirmed) verdict = { text: `${dir === 'LONG' ? 'CALL' : 'PUT'} signal confirmed — index fired ${dir} and the ${dir === 'LONG' ? 'CE' : 'PE'} RSI is above 40.`, tone: 'go' };
  else if (dir && !confirmed) verdict = { text: `Index fired ${dir}, but the ${dir === 'LONG' ? 'CE' : 'PE'} RSI is not above 40 — confirmation fails, skip.`, tone: 'wait' };

  const vCls = verdict.tone === 'go' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
    : verdict.tone === 'wait' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
    : 'bg-card border-transparent text-muted-foreground';

  return (
    <div className="px-2 py-3 md:p-8 max-w-[900px] w-full mx-auto pb-24 min-h-screen">
      <div className="relative bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-3 mb-4 flex-wrap overflow-hidden before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/40 before:to-transparent">
        <div className="flex items-center gap-2.5">
          <Radio className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight">Live Signal</h1>
            <p className="text-xs text-muted-foreground">Index RSI signal + the ATM option's own RSI confirmation.</p>
          </div>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-card hover:bg-popover transition-colors text-muted-foreground">
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      {!ok && <div className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-3">{data?.error || 'Loading… (needs Kite login + market hours)'}</div>}

      {ok && (
        <>
          {/* Verdict */}
          <div className={cn('rounded-2xl p-4 border mb-4', vCls)}>
            <div className="text-[11px] uppercase tracking-wider opacity-70 mb-1">Verdict</div>
            <div className="text-sm font-medium leading-snug">{verdict.text}</div>
          </div>

          {/* Index state */}
          <div className="bg-card rounded-xl p-4 mb-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Index RSI (NIFTY 5-min)</div>
                <div className="text-2xl font-bold font-mono text-foreground">{idx?.currentRsi ?? '—'}</div>
              </div>
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Spot · ATM</div>
                <div className="text-lg font-bold font-mono text-foreground">{data.spot?.toFixed(1)} · {data.strike}</div>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 text-sm">
              {idx?.lastSignal ? (
                <span className={cn('flex items-center gap-1.5 font-semibold',
                  idx.lastSignal.dir === 'LONG' ? 'text-emerald-400' : 'text-rose-400')}>
                  {idx.lastSignal.dir === 'LONG' ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  Last {idx.lastSignal.dir} signal {idx.firedOnLast ? 'on the latest candle' : `${idx.lastSignal.barsAgo} candle(s) ago`}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-muted-foreground"><Minus className="w-4 h-4" /> No recent signal</span>
              )}
            </div>
          </div>

          {/* Option confirmation */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-4">
            <OptionCard side="CE" data={data.ce} active={dir === 'LONG'} />
            <OptionCard side="PE" data={data.pe} active={dir === 'SHORT'} />
          </div>

          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            Confirmation rule: the option you'd buy (CE for a long signal, PE for a short signal) must have its own 5-min RSI above 40.
            Live read updates ~every 30s; needs Kite connected and market open. Educational tool, not investment advice.
          </p>
        </>
      )}
    </div>
  );
}
