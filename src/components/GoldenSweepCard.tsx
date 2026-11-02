import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Eye } from 'lucide-react';

// Golden-zone Swap-Sweep — WATCH ONLY (server/golden_sweep.ts). No orders: it
// shows each live signal and how it would have done, next to the 2-year backtest,
// so the two can be compared before any money goes on it.
const t = (ms: number) => new Date(ms + 5.5 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
export default function GoldenSweepCard() {
  const { data } = useQuery({ queryKey: ['golden-sweep'], queryFn: async () => (await fetch('/api/golden-sweep/status')).json(), refetchInterval: 30000 });
  if (!data?.ok) return null;
  const bt = data.backtest, lv = data.live;
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-2">
      <div className="flex items-center gap-2">
        <Eye className="w-5 h-5 text-amber-400" />
        <div>
          <h2 className="font-bold">Golden-zone Swap-Sweep <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 align-middle">WATCH ONLY</span></h2>
          <div className="text-[11px] text-muted-foreground">NIFTY 15-min Swap-Sweep whose sweep lands in the 50–61.8% zone of the last 24 candles' swing. Alerts only — no orders.</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-muted/40 p-2"><div className="text-[10px] uppercase text-muted-foreground">2-year backtest</div>
          <div className="font-mono">{bt.trades} trades · avg {bt.avgPts >= 0 ? '+' : ''}{bt.avgPts} pts · win {Math.round(bt.winRate * 100)}%</div>
          <div className="text-[10px] text-muted-foreground">{bt.note}</div></div>
        <div className="rounded-lg bg-muted/40 p-2"><div className="text-[10px] uppercase text-muted-foreground">Live so far</div>
          <div className="font-mono">{lv.graded} graded{lv.graded ? ` · avg ${lv.avgPts >= 0 ? '+' : ''}${lv.avgPts} pts · ${lv.wins} wins` : ''}</div>
          <div className="text-[10px] text-muted-foreground">about 3 signals a month expected — needs 30+ to judge</div></div>
      </div>
      {(data.signals || []).slice(0, 8).map((s: any) => (
        <div key={s.c3_time} className="flex items-center gap-2 text-xs border-b border-border/50 pb-1 last:border-0">
          <span className="font-mono text-muted-foreground w-24 shrink-0">{t(s.c3_time)}</span>
          <span className={cn('font-bold', s.dir === 1 ? 'text-emerald-400' : 'text-rose-400')}>{s.dir === 1 ? 'Bullish' : 'Bearish'}</span>
          <span className="flex-1 text-muted-foreground truncate">sweep {Number(s.ext).toFixed(1)}{s.entry ? ` · entry ${s.entry} · stop ${Number(s.stop).toFixed(1)}` : ''}{s.exit_reason ? ` · ${s.exit_reason}` : ''}</span>
          <span className={cn('font-mono font-bold shrink-0', s.pts == null ? 'text-muted-foreground' : s.pts >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{s.pts == null ? s.status.toLowerCase() : `${s.pts >= 0 ? '+' : ''}${s.pts}`}{s.status === 'OPEN' ? ' (open)' : ''}</span>
        </div>
      ))}
    </div>
  );
}
