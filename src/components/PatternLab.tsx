import { useState } from "react";
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
          <b> draft rules</b> catch each one — and if not, which check failed. Nothing is tested for profit here: that runs only after you approve the rules.
        </p>

        {isLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Fetching exact candles from Zerodha…</div>}
        {data?.error && <div className="text-red-500 text-xs">Could not fetch candles: {data.error}</div>}

        {data && (
          <>
            <div className="rounded-lg border border-border p-3 space-y-1.5">
              <div className="font-semibold">Draft rules <span className="text-muted-foreground font-normal text-xs">({data.draft.version})</span> — catch {data.caught} of {data.total}</div>
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
                                <li>Push ending at candle 1 → {a.tries[0].reason}</li>
                                <li>Push ending at candle 2 → {a.tries[1].reason}</li>
                                <li>Opening drop → {a.tries[2].reason}</li>
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
