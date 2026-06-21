import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Layers, RefreshCw, Info } from 'lucide-react';

const fmtExp = (s: string | null) => { if (!s) return ''; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }); } catch { return ''; } };

function MoneyTag({ m }: { m: string }) {
  const c = m === 'ITM' ? 'text-emerald-400 bg-emerald-500/10' : m === 'ATM' ? 'text-primary bg-primary/10' : 'text-muted-foreground bg-muted';
  return <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded', c)}>{m}</span>;
}

export default function OptionValue() {
  const [sideSel, setSideSel] = useState<'ce' | 'pe'>('ce');
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['option-value'],
    queryFn: async () => { const r = await fetch('/api/option-value'); return await r.json(); },
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });

  const ok = data?.success;
  const rows = data?.rows || [];

  return (
    <div className="px-2 py-3 md:p-8 max-w-[820px] w-full mx-auto pb-24 min-h-screen">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Layers className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight">Option Value</h1>
            <p className="text-xs text-muted-foreground">Premium split into intrinsic (real) + time value (decays).</p>
          </div>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl bg-card hover:bg-popover transition-colors text-muted-foreground">
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      {/* concept */}
      <div className="flex items-start gap-2 text-[12px] text-muted-foreground bg-card/60 border border-dashed border-border rounded-xl px-3 py-2.5 mb-4 leading-relaxed">
        <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <span><span className="text-foreground">Premium = intrinsic + time value.</span> ATM ≈ all time value (max theta). A slightly <span className="text-emerald-400">ITM</span> strike has real intrinsic value and a higher delta — it tracks the index better and bleeds less, for a bigger premium.</span>
      </div>

      {!ok && <div className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-3">{data?.error || 'Loading… (needs Kite login + market hours)'}</div>}

      {ok && (
        <>
          <div className="flex items-center justify-between mb-3 text-sm">
            <div><span className="text-muted-foreground text-xs">Spot </span><span className="font-mono font-bold">{data.spot}</span></div>
            <div><span className="text-muted-foreground text-xs">ATM </span><span className="font-mono font-bold">{data.atmStrike}</span></div>
            <div><span className="text-muted-foreground text-xs">Expiry </span><span className="font-mono font-bold">{fmtExp(data.expiry)}</span></div>
          </div>

          {/* side toggle */}
          <div className="flex items-center gap-1.5 mb-3">
            {(['ce', 'pe'] as const).map((sd) => (
              <button key={sd} onClick={() => setSideSel(sd)}
                className={cn('text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors',
                  sideSel === sd ? 'bg-primary/15 text-primary' : 'bg-card text-muted-foreground hover:text-foreground')}>
                {sd === 'ce' ? 'Calls (CE)' : 'Puts (PE)'}
              </button>
            ))}
          </div>

          <div className="bg-card rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] font-mono">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left px-3 py-2 font-medium">Strike</th>
                    <th className="text-right px-3 py-2 font-medium">Premium</th>
                    <th className="text-right px-3 py-2 font-medium">Intrinsic</th>
                    <th className="text-right px-3 py-2 font-medium">Time val</th>
                    <th className="text-right px-3 py-2 font-medium">TV %</th>
                    <th className="text-right px-3 py-2 font-medium">Delta</th>
                    <th className="text-right px-3 py-2 font-medium">IV</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: any) => {
                    const o = row[sideSel];
                    return (
                      <tr key={row.strike} className={cn('border-b border-border/40', row.atm && 'bg-primary/5')}>
                        <td className="px-3 py-2.5 font-semibold text-foreground whitespace-nowrap">
                          {row.strike} {o && <MoneyTag m={o.moneyness} />}
                        </td>
                        <td className="px-3 py-2.5 text-right text-foreground">{o ? o.ltp : '—'}</td>
                        <td className="px-3 py-2.5 text-right text-emerald-400">{o ? o.intrinsic : '—'}</td>
                        <td className="px-3 py-2.5 text-right text-amber-400">{o ? o.timeValue : '—'}</td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">{o ? `${o.tvPct}%` : '—'}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-foreground">{o && o.delta != null ? o.delta.toFixed(2) : '—'}</td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">{o && o.iv != null ? `${o.iv}%` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground/80 mt-3 leading-relaxed space-y-1">
            <p><span className="text-emerald-400">Intrinsic</span> = how deep in-the-money it already is (Spot−Strike for calls, Strike−Spot for puts). <span className="text-amber-400">Time value</span> = the rest, which theta erodes to zero by expiry.</p>
            <p><span className="text-foreground">Reading it:</span> a high <span className="text-amber-400">TV %</span> means most of what you pay is decaying air — fine for a fast in-and-out, costly if the trade drags. For your RSI trades, compare the ATM against one or two strikes ITM: you'll pay more, but a far smaller share is time value.</p>
            <p><span className="text-foreground">Delta</span> ≈ how many points the option moves per 1 point of index — ~0.5 at ATM, toward 1 (or −1 for puts) deeper ITM, toward 0 deep OTM. Higher delta = your index signal translates into option P&amp;L more faithfully. <span className="text-foreground">IV</span> is the implied volatility backed out of the live premium.</p>
            <p className="opacity-70">Delta/IV from Black-Scholes (≈6.5% rate, expiry 15:30 IST); a model estimate, not the broker's official greeks. Educational, not investment advice.</p>
          </div>
        </>
      )}
    </div>
  );
}
