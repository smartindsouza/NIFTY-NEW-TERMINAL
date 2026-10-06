import { useEffect, useRef, useState } from "react";
import { Radar, Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

// Forward test of the "sweep at the day's high/low CONTINUES" idea. The rule is
// frozen (server/ss_continuation.ts, src/lib/ssResearch.ts). Logs and grades
// itself; never trades. Judged only on days the idea was never seen on.

type Score = { trades: number; winRate: number; avgR: number; totalR: number; luck: number; verdict: 'TOO_EARLY' | 'PASS' | 'POSITIVE_BUT_LUCK' | 'FAIL' };
type Data = {
  rule: { frozenOn: string; text: string[]; minSignals: number };
  live: Score;
  signals: { time: number; day: string; dir: string; entry: number; exit_px: number; outcome: string; r: number }[];
  holdout: { ranAt: number; from: string; to: string; score: Score; longs: number; shorts: number } | null;
  holdJob: { status: string; error: string | null };
};

const sgn = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}R`;
const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
const VERDICT: Record<Score['verdict'], string> = {
  TOO_EARLY: 'Too early to judge.',
  PASS: 'Profitable by more than luck could explain.',
  POSITIVE_BUT_LUCK: 'Positive, but still inside the luck range.',
  FAIL: 'Not profitable after costs.',
};

export default function SwapSweepContinuation() {
  const [d, setD] = useState<Data | null>(null);
  const timer = useRef<any>(null);
  const load = async () => {
    try {
      const r = await fetch('/api/ss/continuation'); const j = await r.json(); setD(j);
      if (j.holdJob?.status === 'running') timer.current = setTimeout(load, 3000);
    } catch (e) {}
  };
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, []);
  const runPast = async () => {
    try { await fetch('/api/ss/continuation/holdout', { method: 'POST' }); } catch (e) {}
    setD((x) => x ? { ...x, holdJob: { status: 'running', error: null } } : x);
    timer.current = setTimeout(load, 2000);
  };

  const scoreRow = (s: Score) => (
    <div className="grid grid-cols-4 gap-2 text-center">
      <div><div className="text-[11px] text-muted-foreground">Trades</div><div className="font-semibold tabular-nums">{s.trades}</div></div>
      <div><div className="text-[11px] text-muted-foreground">Win</div><div className="font-semibold tabular-nums">{s.winRate.toFixed(1)}%</div></div>
      <div><div className="text-[11px] text-muted-foreground">Avg</div><div className={`font-semibold tabular-nums ${s.avgR > 0 ? 'text-emerald-500' : s.avgR < 0 ? 'text-red-500' : ''}`}>{sgn(s.avgR)}</div></div>
      <div><div className="text-[11px] text-muted-foreground">Luck ±</div><div className="tabular-nums text-muted-foreground">{s.luck.toFixed(2)}</div></div>
    </div>
  );

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Radar className="w-5 h-5 text-primary" /> SS continuation · forward test
          <span className="text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded border border-amber-500/50 text-amber-500">LOGS ONLY · NEVER TRADES</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <div className="font-semibold mb-1">The rule (fixed on {d?.rule.frozenOn ?? '2026-10-06'}, cannot be changed during the test)</div>
          <ol className="list-decimal pl-5 space-y-0.5 text-muted-foreground text-xs">
            {(d?.rule.text || []).map((t, i) => <li key={i}>{t}</li>)}
          </ol>
        </div>

        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="font-semibold">1 · One-time past check {d?.holdout ? `(${d.holdout.from} – ${d.holdout.to})` : '(26 Feb – 6 Oct 2026)'}</div>
          <p className="text-[11px] text-muted-foreground">Days the idea was never seen on. It runs once only, so it cannot be repeated until it looks good.</p>
          {d?.holdout ? (
            <>
              {scoreRow(d.holdout.score)}
              <div className="text-xs text-muted-foreground">{d.holdout.longs} buys · {d.holdout.shorts} sells. {d.holdout.score.trades < 30 ? 'Fewer than 30 trades, so this is a first look, not a verdict.' : VERDICT[d.holdout.score.verdict]}</div>
            </>
          ) : (
            <button onClick={runPast} disabled={d?.holdJob.status === 'running'}
              className="w-full h-10 rounded-full bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
              {d?.holdJob.status === 'running' ? <><Loader2 className="w-4 h-4 animate-spin" /> Checking…</> : 'Run the one-time past check'}
            </button>
          )}
          {d?.holdJob.status === 'error' && <div className="text-red-500 text-xs">Failed: {d.holdJob.error}</div>}
        </div>

        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="font-semibold">2 · Live log from 7 Oct 2026</div>
          <p className="text-[11px] text-muted-foreground">Graded automatically every trading day at 3:50 pm. Verdict after {d?.rule.minSignals ?? 30} signals: it passes only if the average beats zero by more than the luck range. At this rule's pace that is several months.</p>
          {d && scoreRow(d.live)}
          <div className="text-xs text-muted-foreground">{d ? (d.live.verdict === 'TOO_EARLY' ? `${d.live.trades}/${d.rule.minSignals} signals — too early to judge.` : VERDICT[d.live.verdict]) : 'Loading…'}</div>
          {d && d.signals.length > 0 && (
            <table className="w-full text-xs mt-1">
              <tbody>
                {d.signals.map((s) => (
                  <tr key={s.time} className="border-t border-border/50">
                    <td className="py-1">{s.day}</td><td>{hhmm(s.time)}</td>
                    <td className={s.dir === 'LONG' ? 'text-emerald-500' : 'text-red-500'}>{s.dir === 'LONG' ? 'BUY' : 'SELL'}</td>
                    <td className="tabular-nums">{s.entry.toFixed(1)}</td>
                    <td>{s.outcome === 'WIN' ? 'target' : s.outcome === 'LOSS' ? 'stop' : 'day close'}</td>
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
