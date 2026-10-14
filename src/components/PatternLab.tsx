import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChartCandlestick, Loader2, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

// PATTERN LAB — Martin's hand-picked bearish examples with the EXACT Zerodha
// candles, and whether the DRAFT rules (src/lib/patternLab.ts) catch each one.
// Step 1-2 of the agreed process: confirm the candles, approve the rules. No
// performance is shown here on purpose — that test runs only after approval.

type PC = { time: number; open: number; high: number; low: number; close: number };
type Check = { ok: boolean; kind?: string; at: number; reason: string; time?: number };
type Analysis = {
  atr: number | null; pattern: PC[]; window: PC[]; markedTime: number;
  after30: { candles: number; maxFall: number; maxRise: number; net: number } | null;
  after60: { candles: number; maxFall: number; maxRise: number; net: number } | null;
  hit: Check | null; tries: Check[];
};
type Example = { id: number; day: string; time: string; note: string | null; found: boolean; analysis: Analysis | null };
type Resp = { draft: { version: string; text: string[] }; labels: Record<string, string>; error: string | null; total: number; caught: number; examples: Example[] };

const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', weekday: 'short' });
const n2 = (x: number) => x.toFixed(2);

function MiniChart({ a }: { a: Analysis }) {
  const w = a.window;
  if (!w.length) return null;
  const lo = Math.min(...w.map((c) => c.low)), hi = Math.max(...w.map((c) => c.high));
  const span = hi - lo || 1, H = 96, pad = 4, step = 14;
  const W = w.length * step + pad * 2;
  const y = (p: number) => pad + (hi - p) / span * (H - pad * 2);
  const mi = w.findIndex((c) => c.time === a.markedTime);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[360px] h-24" role="img" aria-label="candles around the example">
      {mi >= 0 && <rect x={pad + mi * step} y={0} width={step * Math.min(3, w.length - mi)} height={H} className="fill-primary/10" />}
      {mi >= 0 && <line x1={pad + mi * step + step / 2} x2={pad + mi * step + step / 2} y1={0} y2={H} stroke="currentColor" strokeDasharray="3 3" className="text-muted-foreground/60" />}
      {w.map((c, i) => {
        const up = c.close >= c.open, cx = pad + i * step + step / 2;
        const col = up ? '#22c55e' : '#ef4444';
        const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
        const dayBreak = i > 0 && Math.floor((c.time + 19800) / 86400) !== Math.floor((w[i - 1].time + 19800) / 86400);
        return (
          <g key={c.time}>
            {dayBreak && <line x1={pad + i * step} x2={pad + i * step} y1={0} y2={H} stroke="currentColor" className="text-muted-foreground/30" />}
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth={1} />
            <rect x={cx - 4} y={top} width={8} height={Math.max(1, bot - top)} fill={col} />
          </g>
        );
      })}
    </svg>
  );
}

type TestRow = { key: string; label: string; signals: number; perDay: number; fallFirst: number; fallFirstLuck: number; decided: number; net60Atr: number;
  trade: { trades: number; winRate: number; avgR: number; luck: number }; beatsRandom: boolean; pays: boolean; verdict: 'PASS' | 'NO_EDGE' | 'TOO_FEW' };
type TestRes = { generatedAt: number; rulesVersion: string; period: { from: string; to: string; days: number }; random: { fallFirst: number; net60Atr: number; candles: number }; rules: TestRow[] };

// THE 2-YEAR TEST of the approved rules, judged only on days BEFORE Sep 2026
// (the examples' period). Pass bar fixed in lib/patternLab before any result.
function PatternTest() {
  const [res, setRes] = useState<TestRes | null>(null);
  const [job, setJob] = useState<{ status: string; progress: string; error: string | null } | null>(null);
  const timer = useRef<any>(null);
  const poll = async () => {
    try {
      const j = await (await fetch('/api/patterns/test/status')).json();
      setJob(j.job); if (j.result) setRes(j.result);
      if (j.job?.status === 'running') timer.current = setTimeout(poll, 3000);
    } catch (e) { timer.current = setTimeout(poll, 5000); }
  };
  useEffect(() => { poll(); return () => clearTimeout(timer.current); }, []);
  const start = async () => {
    clearTimeout(timer.current); setJob({ status: 'running', progress: 'starting…', error: null });
    try { await fetch('/api/patterns/test/start', { method: 'POST' }); } catch (e) {}
    timer.current = setTimeout(poll, 1500);
  };
  const running = job?.status === 'running';
  const sg = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(2)}`;
  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="font-semibold">2-year test of the approved rules</div>
      <p className="text-[11px] text-muted-foreground">
        Judged only on days <b>before September 2026</b> — your examples come from Sep–Oct 2026, so they cannot grade themselves.
        For every signal: does NIFTY fall 1 × ATR before rising 1 × ATR within the next hour, compared with any ordinary candle;
        and a plain short (stop above the pattern, 2R target, out by the close, 2 pts cost).
        A rule passes only if it beats ordinary candles AND the short pays, both by more than luck, with at least 60 signals.
      </p>
      <button onClick={start} disabled={running} className="w-full h-10 rounded-full bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
        {running ? <><Loader2 className="w-4 h-4 animate-spin" /> {job?.progress || 'running…'}</> : res ? 'Run again' : 'Run the 2-year test (about 30 seconds)'}
      </button>
      {job?.status === 'error' && <div className="text-red-500 text-xs">Failed: {job.error}</div>}
      {res && (
        <>
          <div className="text-[11px] text-muted-foreground">{res.period.from} – {res.period.to} · {res.period.days} trading days · ordinary candles fall-first {res.random.fallFirst}% (the bar to beat)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead><tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-1 font-medium">Rule</th><th className="text-right font-medium">Signals</th><th className="text-right font-medium">Fall first</th>
                <th className="text-right font-medium">Short: win</th><th className="text-right font-medium">Avg R</th>
              </tr></thead>
              <tbody>
                {res.rules.map((r) => (
                  <tr key={r.key} className="border-b border-border/50 align-top">
                    <td className="py-1.5 pr-1">{r.label}<div className="text-muted-foreground">{r.perDay} a day</div></td>
                    <td className="text-right tabular-nums">{r.signals}</td>
                    <td className={`text-right tabular-nums ${r.beatsRandom ? 'text-emerald-500' : ''}`}>{r.fallFirst}%<div className="text-muted-foreground">±{r.fallFirstLuck}</div></td>
                    <td className="text-right tabular-nums">{r.trade.winRate}%</td>
                    <td className={`text-right tabular-nums ${r.trade.avgR > 0 ? 'text-emerald-500' : 'text-red-500'}`}>{sg(r.trade.avgR)}<div className="text-muted-foreground">±{r.trade.luck}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1">
            {res.rules.map((r) => (
              <div key={r.key} className={`rounded-md border px-2 py-1.5 text-[11px] ${r.verdict === 'PASS' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600' : 'border-amber-500/40 bg-amber-500/10 text-amber-600'}`}>
                <b>{r.label}: {r.verdict === 'PASS' ? 'passed' : r.verdict === 'TOO_FEW' ? 'too few signals to judge' : 'no proven edge'}.</b>{' '}
                {r.verdict === 'PASS' ? 'It led to falls more often than ordinary candles and the short paid after costs, both beyond luck.'
                  : r.verdict === 'TOO_FEW' ? `Only ${r.signals} signals in the test period (needs 60).`
                  : `${r.beatsRandom ? 'Falls followed more often than usual, ' : 'Falls did not follow more often than after ordinary candles, '}${r.pays ? 'and the short paid.' : 'and the short did not pay after costs beyond luck.'}`}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function PatternLab() {
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyText, setCopyText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { data, isLoading, refetch } = useQuery<Resp>({
    queryKey: ['pattern-examples', 'bear'],
    queryFn: async () => (await fetch('/api/patterns/examples?side=bear')).json(),
    staleTime: 60000,
  });

  const add = async () => {
    setMsg(null); setBusy(true);
    try {
      const r = await fetch('/api/patterns/examples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side: 'bear', day, time, note }) });
      const j = await r.json();
      if (!j.ok) setMsg(j.error || 'Could not add'); else { setDay(''); setTime(''); setNote(''); await refetch(); }
    } catch (e) { setMsg('Could not add'); }
    setBusy(false);
  };
  // One tap: every example's exact candles + why each draft rule missed, as plain
  // text Martin pastes into the chat — so the rules are revised on real numbers.
  const buildCopy = (d: Resp) => {
    const L: string[] = [`PATTERN LAB · bearish · ${d.draft.version} · caught ${d.caught}/${d.total}`];
    for (const e of d.examples) {
      L.push('', `## ${e.day} ${e.time}${e.note && e.note !== 'sent as a screenshot' ? ` (${e.note})` : ''}`);
      const a = e.analysis;
      if (!a) { L.push(e.found ? 'no analysis' : 'no candle at that time'); continue; }
      L.push(`ATR ${a.atr ?? '-'} | caught: ${a.hit ? `${a.hit.kind} at ${a.hit.time ? hhmm(a.hit.time) : '?'}` : 'NO'}`);
      for (const c of a.window) L.push(`${hhmm(c.time)}${c.time === a.markedTime ? '*' : ' '} O ${n2(c.open)} H ${n2(c.high)} L ${n2(c.low)} C ${n2(c.close)}`);
      if (a.after30) L.push(`next30: fall ${a.after30.maxFall} rise ${a.after30.maxRise} net ${a.after30.net}`);
      if (a.after60) L.push(`next60: fall ${a.after60.maxFall} rise ${a.after60.maxRise} net ${a.after60.net}`);
      if (!a.hit) a.tries.forEach((t, i) => L.push(`miss${i + 1}: ${t.reason}`));
    }
    return L.join('\n');
  };
  const copyAll = async () => {
    if (!data) return;
    const t = buildCopy(data);
    setCopyText(t);
    try { await navigator.clipboard.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 3000); } catch (e) { setCopied(false); }
  };
  const del = async (id: number, label: string) => {
    if (!window.confirm(`Remove the example ${label}?`)) return;
    try { await fetch(`/api/patterns/examples/${id}`, { method: 'DELETE' }); await refetch(); } catch (e) {}
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ChartCandlestick className="w-5 h-5 text-primary" /> Pattern Lab · bearish examples
          <span className="text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded border border-emerald-500/50 text-emerald-500">EXACT ZERODHA CANDLES</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Your examples with the exact 5-minute candles (NIFTY 50), what happened in the next 30 and 60 minutes, and whether the
          <b> approved rules</b> catch each one — and if not, which check failed. The 2-year test of those rules is further down.
        </p>

        {isLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Fetching exact candles from Zerodha…</div>}
        {data?.error && <div className="text-red-500 text-xs">Could not fetch candles: {data.error}</div>}

        {data && (
          <>
            <div className="rounded-lg border border-border p-3 space-y-1.5">
              <div className="font-semibold">Rules <span className="text-muted-foreground font-normal text-xs">({data.draft.version})</span> — catch {data.caught} of {data.total}</div>
              <ol className="list-decimal pl-5 space-y-1 text-xs text-muted-foreground">
                {data.draft.text.map((t, i) => <li key={i}>{t}</li>)}
              </ol>
              <button onClick={copyAll} className="mt-2 w-full h-10 rounded-full bg-primary text-primary-foreground font-semibold">
                {copied ? 'Copied — paste it to Claude' : 'Copy details for Claude'}
              </button>
              {copyText && !copied && (
                <textarea readOnly value={copyText} onFocus={(e) => e.currentTarget.select()}
                  className="mt-2 w-full h-32 text-[10px] font-mono rounded-md border border-border bg-background p-2" />
              )}
            </div>

            <div className="space-y-3">
              {data.examples.map((e) => {
                const a = e.analysis;
                const label = `${fmtDay(e.day)} · ${e.time}`;
                return (
                  <div key={e.id} className="rounded-lg border border-border p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold">{label}</div>
                        {a?.hit
                          ? <div className="text-xs text-emerald-500">✓ Caught: {data.labels[a.hit.kind || ''] || a.hit.kind}{a.hit.time ? ` — signal at the ${hhmm(a.hit.time)} candle's close` : ''}</div>
                          : e.found ? <div className="text-xs text-amber-500">✗ Missed by the draft rules</div>
                          : data.error ? <div className="text-xs text-muted-foreground">Candles unavailable right now</div>
                          : <div className="text-xs text-red-500">No 5-minute candle at that time (holiday, or the time is off?)</div>}
                      </div>
                      <button onClick={() => del(e.id, label)} title="Remove this example" className="p-1 text-muted-foreground hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    {a && (
                      <>
                        <MiniChart a={a} />
                        <table className="w-full text-[11px] font-mono">
                          <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Candle</th><th className="text-right font-normal">Open</th><th className="text-right font-normal">High</th><th className="text-right font-normal">Low</th><th className="text-right font-normal">Close</th></tr></thead>
                          <tbody>
                            {a.pattern.map((c, i) => (
                              <tr key={c.time} className={c.close >= c.open ? 'text-emerald-500' : 'text-red-500'}>
                                <td>{i + 1}. {hhmm(c.time)}</td><td className="text-right">{n2(c.open)}</td><td className="text-right">{n2(c.high)}</td><td className="text-right">{n2(c.low)}</td><td className="text-right">{n2(c.close)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          {a.atr !== null && <div>Average candle range (ATR) before it: {a.atr} pts</div>}
                          {a.after30 && <div>Next 30 min: fell up to <b className="text-foreground">{a.after30.maxFall}</b> pts, rose up to {a.after30.maxRise}, ended {a.after30.net > 0 ? '+' : ''}{a.after30.net}</div>}
                          {a.after60 && <div>Next 60 min: fell up to <b className="text-foreground">{a.after60.maxFall}</b> pts, rose up to {a.after60.maxRise}, ended {a.after60.net > 0 ? '+' : ''}{a.after60.net}</div>}
                          {!a.hit && a.tries.length > 0 && (
                            <div className="pt-1">Why not caught:
                              <ul className="list-disc pl-5">
                                {a.tries.map((t, i) => (
                                  <li key={i}>{t.kind === 'opening' || i === a.tries.length - 1 ? 'Opening drop' : `Candle at ${t.time ? hhmm(t.time) : '?'}`} → {t.reason}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {a.hit && <div className="text-emerald-500/90">{a.hit.reason}</div>}
                        </div>
                      </>
                    )}
                    {e.note && e.note !== 'sent as a screenshot' && <div className="text-[11px] text-muted-foreground">Note: {e.note}</div>}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <PatternTest />

        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="font-semibold">Add a bearish example</div>
          <p className="text-[11px] text-muted-foreground">The marked candle's date and time (5-minute chart, IST). The app fetches its exact candles.</p>
          <div className="flex flex-wrap gap-2">
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-sm" />
            <input type="time" value={time} step={300} min="09:15" max="15:25" onChange={(e) => setTime(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-sm" />
            <input type="text" value={note} placeholder="Note (optional)" onChange={(e) => setNote(e.target.value)} className="h-9 flex-1 min-w-[140px] rounded-md border border-border bg-background px-2 text-sm" />
            <button onClick={add} disabled={busy || !day || !time} className="h-9 px-4 rounded-full bg-primary text-primary-foreground font-semibold flex items-center gap-1 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add
            </button>
          </div>
          {msg && <div className="text-xs text-red-500">{msg}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
