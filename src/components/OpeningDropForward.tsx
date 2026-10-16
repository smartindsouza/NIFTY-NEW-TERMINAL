import { useQuery } from "@tanstack/react-query";
import { Sunrise } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

// Opening drop — forward test of the one rule from the Pattern Lab that showed a
// (not proven) hint in the 2-year test. Rule frozen; logs and grades itself after
// each close; never trades. See server/opening_drop.ts.

type Score = { trades: number; winRate: number; avgR: number; totalR: number; luck: number; verdict: 'TOO_EARLY' | 'PASS' | 'POSITIVE_BUT_LUCK' | 'FAIL' };
type Row = { time: number; day: string; entry: number; stop: number; exit_px: number; outcome: string; r: number; fall_first: number | null };
type Data = {
  rule: { frozenOn: string; liveFrom: string; minSignals: number; text: string };
  backtest: { signals: number; fallFirst: number; randomFallFirst: number; avgR: number; luck: number; note: string };
  live: Score; fallFirst: number | null; signals: Row[];
};

const sgn = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}R`;
const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const VERDICT: Record<Score['verdict'], string> = {
  TOO_EARLY: 'Too early to judge.',
  PASS: 'Profitable by more than luck could explain — worth considering for an alert.',
  POSITIVE_BUT_LUCK: 'Positive, but still inside the luck range.',
  FAIL: 'Not profitable after costs.',
};

export default function OpeningDropForward() {
  const { data: d } = useQuery<Data>({ queryKey: ['opening-drop'], queryFn: async () => (await fetch('/api/opening-drop')).json(), staleTime: 60000 });
  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sunrise className="w-5 h-5 text-primary" /> Opening drop · forward test
          <span className="text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded border border-amber-500/50 text-amber-500">LOGS ONLY · NEVER TRADES</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <div className="font-semibold mb-1">The rule (fixed on {d?.rule.frozenOn ?? '2026-10-16'}, cannot change during the test)</div>
          <p className="text-xs text-muted-foreground">{d?.rule.text}</p>
          <p className="text-xs text-muted-foreground mt-1">Graded like the 2-year test: short at the third candle's close, stop above the three candles, 2R target, out by the close, 2 pts cost.</p>
        </div>
        {d && (
          <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
            Where it stands from the 2-year test ({d.backtest.note}): {d.backtest.signals} signals, fell first {d.backtest.fallFirst}% vs {d.backtest.randomFallFirst}% for any candle,
            short {sgn(d.backtest.avgR)} ± {d.backtest.luck} — a hint, not proof. Only days from <b className="text-foreground">{d.rule.liveFrom}</b> count here.
          </div>
        )}
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="font-semibold">Live log</div>
          <p className="text-[11px] text-muted-foreground">Graded automatically every trading day at 3:52 pm. Verdict after {d?.rule.minSignals ?? 30} signals — at about one a week, that is roughly 6–7 months.</p>
          {d && (
            <div className="grid grid-cols-4 gap-2 text-center">
              <div><div className="text-[11px] text-muted-foreground">Signals</div><div className="font-semibold tabular-nums">{d.live.trades}</div></div>
              <div><div className="text-[11px] text-muted-foreground">Fell first</div><div className="font-semibold tabular-nums">{d.fallFirst === null ? '—' : `${d.fallFirst}%`}</div></div>
              <div><div className="text-[11px] text-muted-foreground">Avg</div><div className={`font-semibold tabular-nums ${d.live.avgR > 0 ? 'text-emerald-500' : d.live.avgR < 0 ? 'text-red-500' : ''}`}>{sgn(d.live.avgR)}</div></div>
              <div><div className="text-[11px] text-muted-foreground">Luck ±</div><div className="tabular-nums text-muted-foreground">{d.live.luck.toFixed(2)}</div></div>
            </div>
          )}
          <div className="text-xs text-muted-foreground">{d ? (d.live.verdict === 'TOO_EARLY' ? `${d.live.trades}/${d.rule.minSignals} signals — too early to judge.` : VERDICT[d.live.verdict]) : 'Loading…'}</div>
          {d && d.signals.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {d.signals.map((s) => (
                  <tr key={s.time} className="border-t border-border/50">
                    <td className="py-1">{s.day}</td><td>{hhmm(s.time)}</td>
                    <td className="tabular-nums">{s.entry.toFixed(1)}</td>
                    <td>{s.outcome === 'WIN' ? 'target' : s.outcome === 'LOSS' ? 'stop' : 'day close'}</td>
                    <td>{s.fall_first === null ? '' : s.fall_first ? 'fell first' : 'rose first'}</td>
                    <td className={`text-right tabular-nums ${s.r > 0 ? 'text-emerald-500' : 'text-red-500'}`}>{sgn(s.r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
