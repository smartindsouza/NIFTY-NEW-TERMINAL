import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { X, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

// MY ORDER (26 Oct 2026): Martin's own trade, set up like a channel call — strike,
// entry, SL, TP1-3 — and taken automatically when the option's premium reaches the
// entry (server/signal_trader.ts, source 'manual'). Same engine as Telegram
// Auto-Trade: LIMIT buy at entry + the allowance, the message-style SL armed at
// once, TP1 → SL to entry, TP2 → SL to TP1, TP3 → ask. Works whether Telegram
// Auto-Trade is on or off, and does not count against its daily limit.

type Und = 'NIFTY' | 'SENSEX';
const STEP: Record<Und, number> = { NIFTY: 50, SENSEX: 100 };
const STATUS: Record<string, string> = {
  WATCHING: 'Waiting for entry', ORDERED: 'Ordering', ENTERED: 'Bought', SKIPPED: 'Cancelled', FAILED: 'Failed',
};
const inr = (v: any) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const hhmm = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);

export function MyOrderModal({ onClose, underlying, spot }: { onClose: () => void; underlying?: string; spot?: number | null }) {
  const [und, setUnd] = useState<Und>(underlying === 'SENSEX' ? 'SENSEX' : 'NIFTY');
  const atm = (u: Und, s?: number | null) => (s && s > 0 ? Math.round(s / STEP[u]) * STEP[u] : '');
  const [strike, setStrike] = useState<string>(String(atm(und, spot)));
  const [type, setType] = useState<'CE' | 'PE'>('CE');
  const [f, setF] = useState({ entry: '', sl: '', tp1: '', tp2: '', tp3: '' });
  const [lots, setLots] = useState<string>('1');
  const [pv, setPv] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [orders, setOrders] = useState<any[]>([]);
  const [allow, setAllow] = useState(2);
  const [lastEntry, setLastEntry] = useState('15:00');
  const pvSeq = useRef(0);

  // contract + live premium for what is typed; refreshed every 2 s
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const k = Number(strike);
      if (!(k > 0)) { setPv(null); return; }
      const seq = ++pvSeq.current;
      try {
        const r = await fetch(`/api/signals/manual/preview?u=${und}&strike=${k}&type=${type}`);
        const d = await r.json();
        if (alive && seq === pvSeq.current) setPv(d);
      } catch (e) { /* keep the last answer */ }
    };
    const t0 = setTimeout(load, 250);
    const iv = setInterval(load, 2000);
    return () => { alive = false; clearTimeout(t0); clearInterval(iv); };
  }, [und, strike, type]);

  const loadOrders = async () => {
    try { const d = await (await fetch('/api/signals/manual')).json(); if (d?.ok) { setOrders(d.orders || []); setAllow(Number(d.allowAbove) || 2); if (d.lastEntry) setLastEntry(d.lastEntry); } } catch (e) { }
  };
  useEffect(() => { loadOrders(); const iv = setInterval(loadOrders, 3000); return () => clearInterval(iv); }, []);

  const n = (v: string) => Number(v);
  const entry = n(f.entry), ltp = pv?.ok ? Number(pv.ltp) : NaN;
  const dirText = entry > 0 && ltp > 0 ? (ltp < entry ? `when the premium RISES to ${entry} (now ${ltp})` : `when the premium FALLS to ${entry} (now ${ltp})`) : 'when the premium reaches the entry';

  const arm = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await fetch('/api/signals/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying: und, strike: n(strike), optionType: type, entry: n(f.entry), sl: n(f.sl), tp1: n(f.tp1), tp2: n(f.tp2), tp3: n(f.tp3), lots }) });
      const d = await r.json();
      if (!d.ok) { setErr(d.error || 'Not armed'); return; }
      toast.success(`Order armed: ${d.tradingsymbol} — buys ${d.direction === 'up' ? 'when it rises to' : 'when it falls to'} ${f.entry}`);
      setF({ entry: '', sl: '', tp1: '', tp2: '', tp3: '' });
      loadOrders();
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const cancel = async (id: number) => {
    const d = await (await fetch('/api/signals/manual/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).json();
    if (d.ok) toast('Order cancelled'); else toast.error(d.error || 'Could not cancel');
    loadOrders();
  };

  const Field = (k: keyof typeof f, label: string, tone?: string) => (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">{label}
      <input inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, '') })}
        className={cn('h-10 px-2 rounded-md bg-background border border-border font-mono text-base text-foreground', tone)} />
    </label>
  );
  const seg = (on: boolean) => cn('flex-1 h-9 rounded-md text-sm font-bold transition-colors', on ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground');

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-3" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-[420px] max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-semibold">My Order</h2>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-4 py-3 overflow-y-auto space-y-3">
          <div className="flex gap-2">
            {(['NIFTY', 'SENSEX'] as Und[]).map(u => (
              <button key={u} className={seg(und === u)} onClick={() => { setUnd(u); if (u !== und) setStrike(String(atm(u, u === underlying ? spot : null))); }}>{u}</button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1 flex flex-col gap-1 text-[11px] text-muted-foreground">Strike
              <div className="flex">
                <button onClick={() => setStrike(String(Math.max(0, n(strike) - STEP[und])))} className="h-10 w-10 rounded-l-md bg-muted/50 flex items-center justify-center"><Minus size={16} /></button>
                <input inputMode="numeric" value={strike} onChange={(e) => setStrike(e.target.value.replace(/\D/g, ''))}
                  className="h-10 w-full min-w-0 px-2 bg-background border-y border-border font-mono text-base text-center text-foreground" />
                <button onClick={() => setStrike(String(n(strike) + STEP[und]))} className="h-10 w-10 rounded-r-md bg-muted/50 flex items-center justify-center"><Plus size={16} /></button>
              </div>
            </label>
            <div className="flex gap-1 w-[110px]">
              <button className={cn(seg(type === 'CE'), type === 'CE' && 'bg-emerald-600 text-white')} onClick={() => setType('CE')}>CE</button>
              <button className={cn(seg(type === 'PE'), type === 'PE' && 'bg-rose-600 text-white')} onClick={() => setType('PE')}>PE</button>
            </div>
          </div>
          <div className="text-xs rounded-md bg-muted/40 px-3 py-2 min-h-[36px]">
            {pv?.ok ? <span><b className="font-mono">{pv.tradingsymbol}</b> · expiry {pv.expiry} · lot {pv.lotSize} · premium <b className="font-mono">{pv.ltp ?? '…'}</b></span>
              : <span className="text-muted-foreground">{pv?.error || 'Enter a strike to see the contract and its live premium.'}</span>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {Field('entry', 'Entry (premium)')}
            {Field('sl', 'Stop loss', 'text-rose-400')}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Field('tp1', 'TP1', 'text-emerald-400')}
            {Field('tp2', 'TP2', 'text-emerald-400')}
            {Field('tp3', 'TP3', 'text-emerald-400')}
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground text-[11px]">Lots</span>
            <select value={lots} onChange={(e) => setLots(e.target.value)} className="h-9 px-2 rounded-md bg-background border border-border font-mono text-foreground">
              <option value="MAX">Max possible (funds)</option>
              {Array.from({ length: 25 }, (_, i) => i + 1).map(k => <option key={k} value={String(k)}>{k}{pv?.lotSize ? ` (${k * pv.lotSize} qty)` : ''}</option>)}
            </select>
          </label>
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            Buys {dirText}, as a limit order up to {entry > 0 ? (entry + allow).toFixed(2) : `entry + ${allow}`}. The SL is armed at once; TP1 moves it to your entry, TP2 to TP1, and at TP3 you are asked to exit or keep trailing. Valid until {lastEntry} today; square-off 15:15.
          </div>
          {err && <div className="text-sm text-rose-400">{err}</div>}
          <button disabled={busy} onClick={arm} className="w-full h-11 rounded-lg bg-primary text-primary-foreground font-bold disabled:opacity-50">
            {busy ? 'Arming…' : 'Arm order'}
          </button>

          {orders.length > 0 && (
            <div className="pt-2 border-t border-border space-y-1.5">
              <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Today's orders</div>
              {orders.map((o: any) => (
                <div key={o.id} className="flex items-start gap-2 text-xs">
                  <span className="font-mono text-muted-foreground w-11 shrink-0">{hhmm(o.received_at)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">{o.underlying} {o.strike} {o.option_type} <span className="font-normal text-muted-foreground">· entry {o.entry_high} ({o.trigger_dir === 'up' ? 'rising' : 'falling'}) · SL {o.sl} · TP {o.tp1}/{o.tp2}/{o.tp3}</span></div>
                    {o.fill != null && <div className="text-muted-foreground">bought {inr(o.fill)}{o.exit_price != null ? ` → sold ${inr(o.exit_price)} · ${Number(o.pnl) >= 0 ? '+' : ''}${inr(o.pnl)}` : ''}</div>}
                    {o.status === 'SKIPPED' || o.status === 'FAILED' ? <div className="text-muted-foreground">{o.reason}</div> : null}
                  </div>
                  <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted">{o.trade_status === 'OPEN' ? 'Open' : o.trade_status === 'CLOSED' ? 'Closed' : (STATUS[o.status] || o.status)}</span>
                  {o.status === 'WATCHING' && <button onClick={() => cancel(o.id)} className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">Cancel</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MyOrderModal;
