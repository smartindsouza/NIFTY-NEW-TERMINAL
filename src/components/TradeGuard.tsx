import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Shield, ShieldAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// TRADE GUARD (11 Nov 2026) — the chart-toolbar shield and its rules sheet.
// The server (server/trade_guard.ts) is what actually refuses an entry; this only
// shows where the day stands so a refusal is never a surprise. Exits are never
// blocked. Relaxing a rule takes effect the next trading day, on purpose.

type Rules = { enabled: boolean; startTime: string; maxTrades: number; maxLoss: number };
type Status = { rules: Rules; pending: Partial<Rules> | null; pendingFrom: string | null; entriesToday: number | null; dayPnl: number | null; blocked: boolean; reason: string | null; errors: string[] };
const inr = (v: number | null) => v === null ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;

export function useTradeGuard(pollMs = 15000) {
  const [st, setSt] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const r = await fetch('/api/guard/status'); const j = await r.json(); if (alive && j?.success) setSt(j); } catch { }
    };
    load(); const id = setInterval(load, pollMs);
    const onFocus = () => load(); window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [pollMs]);
  return [st, setSt] as const;
}

export function TradeGuardButton({ className }: { className?: string }) {
  const [st, setSt] = useTradeGuard();
  const [open, setOpen] = useState(false);
  const on = !!st?.rules.enabled;
  const blocked = !!st?.blocked;
  const Icon = blocked ? ShieldAlert : Shield;
  return (
    <>
      <button onClick={() => setOpen(true)} title={st ? (blocked ? st.reason || 'Trade guard' : `Trade guard: ${st.entriesToday ?? '—'}/${st.rules.maxTrades} trades · ${inr(st.dayPnl)} today`) : 'Trade guard'}
        className={cn('flex items-center justify-center gap-1 h-9 px-2 shrink-0 rounded-md transition-colors text-xs font-mono',
          !on ? 'bg-muted/40 text-muted-foreground' : blocked ? 'bg-rose-500/20 text-rose-400' : 'bg-emerald-500/15 text-emerald-400', className)}>
        <Icon size={16} />
        {on && st && <span className="hidden sm:inline">{st.entriesToday ?? '—'}/{st.rules.maxTrades}</span>}
      </button>
      {open && <TradeGuardSheet st={st} onSaved={setSt} onClose={() => setOpen(false)} />}
    </>
  );
}

function TradeGuardSheet({ st, onSaved, onClose }: { st: Status | null; onSaved: (s: Status) => void; onClose: () => void }) {
  const r = st?.rules;
  const [f, setF] = useState<Rules>(r || { enabled: true, startTime: '10:00', maxTrades: 4, maxLoss: 3000 });
  const [busy, setBusy] = useState(false);
  // Structure SL (server/reversal_watch.ts): its own switch, applies at once —
  // turning it off is never a way around the guard, it only stops the auto-exit.
  const [ssl, setSsl] = useState<boolean | null>(null);
  const [sslTf, setSslTf] = useState<5 | 15>(15);
  useEffect(() => { fetch('/api/reversal-watch/status').then(r => r.json()).then(j => { setSsl(j?.structureSl !== false); setSslTf(j?.timeframe === 5 ? 5 : 15); }).catch(() => setSsl(null)); }, []);
  const saveSsl = async (body: any, ok: string, undo: () => void) => {
    try {
      const r = await fetch('/api/reversal-watch/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!j?.success) throw new Error(j?.error || 'Could not save');
      toast.success(ok);
    } catch (e: any) { undo(); toast.error(e?.message || 'Could not save'); }
  };
  const toggleSsl = (on: boolean) => { setSsl(on); saveSsl({ structureSl: on }, on ? 'Structure SL on for new trades' : 'Structure SL off — alerts only for new trades', () => setSsl(!on)); };
  const pickTf = (tf: 5 | 15) => { const was = sslTf; setSslTf(tf); saveSsl({ timeframe: tf }, `Structure SL uses ${tf}-min swings for new trades`, () => setSslTf(was)); };
  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/guard/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || 'Could not save');
      onSaved(j); toast.success(j.note || 'Saved'); onClose();
    } catch (e: any) { toast.error(e?.message || 'Could not save'); } finally { setBusy(false); }
  };
  const lossUsed = st && st.dayPnl !== null && st.dayPnl < 0 ? Math.min(100, Math.round((-st.dayPnl / (r?.maxLoss || 1)) * 100)) : 0;
  const tradesUsed = st && st.entriesToday !== null && r ? Math.min(100, Math.round((st.entriesToday / r.maxTrades) * 100)) : 0;
  const bar = (pct: number) => (
    <div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className={cn('h-full rounded-full', pct >= 100 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} /></div>
  );
  const pendingText = st?.pending && Object.keys(st.pending).length
    ? Object.entries(st.pending).map(([k, v]) => k === 'enabled' ? 'guard off' : k === 'startTime' ? `start ${v}` : k === 'maxTrades' ? `${v} trades` : `loss limit ₹${Number(v).toLocaleString('en-IN')}`).join(', ')
    : null;
  return (
    <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full sm:max-w-[400px] bg-card border border-border rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 font-semibold"><Shield size={18} className="text-emerald-400" /> Trade guard</div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X size={20} /></button>
        </div>
        <div className="px-4 py-3 space-y-4">
          {st?.blocked && <div className="rounded-lg bg-rose-500/15 text-rose-300 text-sm px-3 py-2">{st.reason}</div>}
          {st && r?.enabled && (
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs text-muted-foreground mb-1"><span>Trades today</span><span className="font-mono text-foreground">{st.entriesToday ?? '—'} / {r.maxTrades}</span></div>
                {bar(tradesUsed)}
              </div>
              <div>
                <div className="flex justify-between text-xs text-muted-foreground mb-1"><span>Day P&amp;L (whole account)</span><span className={cn('font-mono', (st.dayPnl ?? 0) < 0 ? 'text-rose-400' : 'text-emerald-400')}>{inr(st.dayPnl)} / −₹{r.maxLoss.toLocaleString('en-IN')}</span></div>
                {bar(lossUsed)}
              </div>
              {st.errors?.length ? <div className="text-[11px] text-amber-400">Could not read: {st.errors.join('; ')}. The time rule still applies.</div> : null}
            </div>
          )}
          <div className="border-t border-border pt-3 space-y-3">
            <label className="flex items-center justify-between text-sm">
              <span>Guard on</span>
              <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} className="w-5 h-5 accent-emerald-500" />
            </label>
            <label className="flex items-center justify-between text-sm gap-3">
              <span>No new trades before<span className="block text-[11px] text-muted-foreground">IST. Your 9:15–10:00 trades lost the most.</span></span>
              <input type="time" min="09:15" max="15:30" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} className="h-9 px-2 rounded-md bg-background border border-border font-mono text-sm" />
            </label>
            <label className="flex items-center justify-between text-sm gap-3">
              <span>Max trades a day</span>
              <input type="number" min={1} max={50} value={f.maxTrades} onChange={(e) => setF({ ...f, maxTrades: Number(e.target.value) })} className="w-20 h-9 px-2 rounded-md bg-background border border-border font-mono text-sm" />
            </label>
            <label className="flex items-center justify-between text-sm gap-3">
              <span>Stop for the day at a loss of ₹</span>
              <input type="number" min={100} step={500} value={f.maxLoss} onChange={(e) => setF({ ...f, maxLoss: Number(e.target.value) })} className="w-24 h-9 px-2 rounded-md bg-background border border-border font-mono text-sm" />
            </label>
          </div>
          <div className="border-t border-border pt-3">
            <label className="flex items-center justify-between text-sm gap-3">
              <span>Structure SL<span className="block text-[11px] text-muted-foreground">Sells the position when a NIFTY candle closes beyond the last swing against your trade (PE: above the last swing high · CE: below the last swing low). Trails as new swings form. Your option SL stays as a backstop.</span></span>
              <input type="checkbox" disabled={ssl === null} checked={!!ssl} onChange={(e) => toggleSsl(e.target.checked)} className="w-5 h-5 accent-emerald-500 shrink-0" />
            </label>
            {ssl && (
              <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                <span>Swings from<span className="block text-[11px] text-muted-foreground">15-min: wider SL, shaken out less (tested better). 5-min: tighter SL.</span></span>
                <div className="flex rounded-lg bg-muted p-0.5 shrink-0">
                  {([15, 5] as const).map(tf => (
                    <button key={tf} onClick={() => pickTf(tf)} className={`px-3 h-8 rounded-md text-xs font-semibold transition-colors ${sslTf === tf ? 'bg-emerald-500 text-black' : 'text-muted-foreground'}`}>{tf}-min</button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            Only new entries you place (order ticket, Quick Trade, My Order) are blocked — never an exit, SL, TP or Exit All. Telegram auto-trades keep their own limits. Stricter changes apply now; relaxed ones start the next trading day.
            {pendingText && <div className="mt-1 text-amber-400">Waiting for {st?.pendingFrom}: {pendingText}.</div>}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 h-9 rounded-md bg-muted text-sm">Cancel</button>
          <button onClick={save} disabled={busy} className="px-4 h-9 rounded-md bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>
  );
}
