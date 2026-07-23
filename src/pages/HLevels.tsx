import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Layers, Trash2, Save, CalendarDays } from 'lucide-react';

// Daily journal for the externally-supplied "H levels" (calculation undisclosed).
// Purpose: collect a clean dated series for 1-2+ months, then reverse-engineer
// against price data (pivot/Camarilla/Fib/CPR candidates) in a later analysis.

const istToday = () => {
  const x = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};

export default function HLevels() {
  const [date, setDate] = useState(istToday());
  const [raw, setRaw] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, refetch } = useQuery({
    queryKey: ['h-levels'],
    queryFn: async () => (await fetch('/api/h-levels?limit=200')).json(),
    refetchOnWindowFocus: false,
  });
  const rows: any[] = data?.rows || [];

  const parsed = (raw.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(v => isFinite(v));

  const save = async () => {
    if (!parsed.length) { setMsg('No numbers found — paste the levels first.'); return; }
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/h-levels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, levels: parsed, note: note.trim() || undefined }),
      });
      const d = await r.json();
      if (d?.ok) { setMsg(`Saved ${parsed.length} level${parsed.length > 1 ? 's' : ''} for ${date}.`); setRaw(''); setNote(''); refetch(); }
      else setMsg(d?.error || 'Save failed.');
    } catch (e) { setMsg('Save failed — network error.'); }
    setSaving(false);
  };

  const del = async (d: string) => {
    await fetch(`/api/h-levels/${d}`, { method: 'DELETE' });
    refetch();
  };

  return (
    <div className="px-2 py-3 md:p-8 max-w-[900px] w-full mx-auto pb-24 min-h-screen">
      <div className="relative bg-card border border-border rounded-xl p-4 mb-4 overflow-hidden before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/40 before:to-transparent">
        <div className="flex items-center gap-2.5">
          <Layers className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight">H Levels Journal</h1>
            <p className="text-xs text-muted-foreground">Enter the day's levels; the app stores them dated. After ~30+ days we run the formula hunt.</p>
          </div>
        </div>
      </div>

      {/* Entry */}
      <div className="rounded-2xl border border-border bg-card p-4 mb-4">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-muted/50 rounded-lg px-2.5 py-1.5 text-sm" />
          <span className="text-[11px] text-muted-foreground">Saving the same date again overwrites it — corrections are easy.</span>
        </div>
        <textarea
          value={raw} onChange={e => setRaw(e.target.value)}
          placeholder="Paste today's H levels — any format works: 24150, 24080 24010&#10;23950…"
          className="w-full bg-muted/50 rounded-lg px-3 py-2.5 text-sm font-mono min-h-[84px] mb-2"
        />
        {parsed.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {parsed.map((v, i) => (
              <span key={i} className="px-2 py-0.5 rounded bg-primary/10 text-primary text-xs font-mono">{v}</span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional — e.g. 'received 8:45am')"
            className="bg-muted/50 rounded-lg px-2.5 py-1.5 text-xs flex-1 min-w-[180px]" />
          <button onClick={save} disabled={saving || !parsed.length}
            className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-xl bg-primary/15 text-primary border border-primary/40 hover:bg-primary/25 transition-colors disabled:opacity-40">
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : `Save ${parsed.length || ''} level${parsed.length === 1 ? '' : 's'}`}
          </button>
        </div>
        {msg && <p className="text-xs text-muted-foreground mt-2">{msg}</p>}
      </div>

      {/* History */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 text-sm font-bold border-b border-border flex items-center justify-between">
          <span>Collected days</span>
          <span className={cn('text-xs font-mono', rows.length >= 30 ? 'text-emerald-400' : 'text-muted-foreground')}>
            {rows.length} day{rows.length === 1 ? '' : 's'}{rows.length < 30 ? ` — analysis meaningful from ~30` : ' — enough to analyze'}
          </span>
        </div>
        <div className="divide-y divide-border/50">
          {rows.map((r: any) => (
            <div key={r.date} className="px-4 py-2.5 flex items-start gap-3">
              <span className="font-mono text-xs text-muted-foreground w-24 shrink-0 pt-0.5">{r.date}</span>
              <div className="flex flex-wrap gap-1.5 flex-1">
                {(r.levels || []).map((v: number, i: number) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-muted/60 text-xs font-mono">{v}</span>
                ))}
                {r.note && <span className="text-[11px] text-muted-foreground w-full">{r.note}</span>}
              </div>
              <button onClick={() => del(r.date)} className="p-1.5 rounded-lg hover:bg-red-500/15 text-muted-foreground hover:text-red-400 shrink-0">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {rows.length === 0 && <div className="px-4 py-4 text-xs text-muted-foreground">Nothing stored yet — save the first day's levels above.</div>}
        </div>
      </div>
    </div>
  );
}
