// JODI IN THE APP (27 Nov 2026). The rules and what Martin asked for are at the
// top of server/jodi.ts; this is what he sees and taps:
//
//   Strategy (the chart's bottom row) > Jodi
//     -> the option chain opens with the basket on; he taps one Call and one Put
//     -> the chain is closed (its cross, or Done) and THE CARD below comes up over
//        a blurred screen: "a small card with a blurred background to add the
//        entry price for each option, combined Premium and SL, Target etc."
//     -> Save. From then on the server holds it: it buys both when the two
//        prices together are at or below the combined premium, and manages them.
//   Strategy again, while a Jodi is waiting or running, opens ITS card instead:
//     what it holds, what it is worth now against the SL and the target, and the
//     one button he asked for — "a manual exit button to exit the Jodi trade
//     when it's active". Before it is entered the same button cancels it.
//
// "both premium prices need not be exactly same ... 4 - 5 points difference is ok
// as long as the combined premium is maintained": the two entry prices are his to
// type and are never forced equal; what triggers the buy is the COMBINED figure.
//
// Mounted once for the whole app (App.tsx), like the option chain's host, so the
// card and the state behind the Strategy button's dot are there on every screen.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { addWsMessageListener } from '../hooks/useWebSocket';
import { lockPageScroll } from '../lib/scrollLock';
import type { BasketLeg } from '../lib/jodiBasket';

// His example (114 + 110 in, SL 100, target 300-310) as shares of the combined
// premium. Only what the SL and target boxes are FILLED with; he changes them.
export const JODI_SL_SHARE = 0.45, JODI_TARGET_SHARE = 1.37;
/** Pure: what the SL and target boxes start at for a combined premium. */
export function jodiDefaults(combined: number): { sl: number; target: number } {
  return { sl: Math.round(combined * JODI_SL_SHARE), target: Math.round(combined * JODI_TARGET_SHARE) };
}

const num = (v: string) => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };
const inr = (v: number) => `₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const px = (v: any) => (Number(v) > 0 ? Number(v).toFixed(2) : '—');
const legName = (l: BasketLeg) => `${l.underlying === 'BANKNIFTY' ? 'BANK NIFTY' : l.underlying} ${l.strike} ${l.type}`;

function useLivePrices(tokens: string[]): Record<string, number> {
  const [p, setP] = useState<Record<string, number>>({});
  const key = tokens.join('|');
  useEffect(() => {
    const want = new Set(tokens.map(String));
    let due = false; const got: Record<string, number> = {};
    const unsub = addWsMessageListener((msg: any) => {
      if (!msg || msg.type !== 'optionTick' || !want.has(String(msg.token)) || !(Number(msg.ltp) > 0)) return;
      got[String(msg.token)] = Number(msg.ltp);
      if (!due) { due = true; setTimeout(() => { due = false; setP((old) => ({ ...old, ...got })); }, 300); }
    });
    return () => { unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return p;
}

function Shell({ children, onClose, label }: { children: React.ReactNode; onClose: () => void; label: string }) {
  useEffect(() => lockPageScroll(true), []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return createPortal(
    <div data-jodi-backdrop="" className="fixed inset-0 z-[170] flex items-center justify-center p-4 bg-black/45 backdrop-blur-md" onClick={onClose}>
      <div role="dialog" aria-label={label} data-jodi-card={label} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[380px] max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-2xl border border-foreground/15 bg-card text-foreground shadow-2xl">
        {children}
      </div>
    </div>, document.body);
}

const Field = ({ label, value, onChange, name, hint }: { label: string; value: string; onChange: (v: string) => void; name: string; hint?: string }) => (
  <label className="block">
    <span className="block text-[11px] leading-none text-muted-foreground mb-[6px]">{label}</span>
    <input data-jodi-field={name} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
      className="w-full h-10 px-3 rounded-lg border border-foreground/15 bg-background text-[15px] font-semibold tabular-nums outline-none focus:border-primary" />
    {hint && <span className="block mt-[5px] text-[10.5px] leading-snug text-muted-foreground">{hint}</span>}
  </label>
);

function JodiSetup({ ce, pe, onClose, onSaved }: { ce: BasketLeg; pe: BasketLeg; onClose: () => void; onSaved: () => void }) {
  const live = useLivePrices([ce.instrument_token, pe.instrument_token]);
  const ceNow = live[String(ce.instrument_token)] || ce.ltp || 0, peNow = live[String(pe.instrument_token)] || pe.ltp || 0;
  // Filled once with the prices as they were when the card opened; after that every box is his.
  const [ceEntry, setCeEntry] = useState(() => (ce.ltp > 0 ? ce.ltp.toFixed(2) : ''));
  const [peEntry, setPeEntry] = useState(() => (pe.ltp > 0 ? pe.ltp.toFixed(2) : ''));
  const sum = num(ceEntry) + num(peEntry);
  // The combined premium follows the two entry prices, and the SL and target
  // follow the combined premium, each until he types in that box himself.
  const [combinedOwn, setCombinedOwn] = useState<string | null>(null);
  const [slOwn, setSlOwn] = useState<string | null>(null);
  const [targetOwn, setTargetOwn] = useState<string | null>(null);
  const combined = combinedOwn ?? (Number.isFinite(sum) ? sum.toFixed(2) : '');
  const d = jodiDefaults(num(combined));
  const sl = slOwn ?? (Number.isFinite(d.sl) ? String(d.sl) : ''), target = targetOwn ?? (Number.isFinite(d.target) ? String(d.target) : '');
  const [lots, setLots] = useState(1);
  const [practice, setPractice] = useState(false);
  const [busy, setBusy] = useState(false);
  const lot = Number(ce.lot_size) || Number(pe.lot_size) || 0, qty = lot * lots;
  const c = num(combined), s = num(sl), t = num(target);
  const problem = !(num(ceEntry) > 0) || !(num(peEntry) > 0) ? 'Type an entry price for each option.'
    : !(c > 0) ? 'Type the combined premium.'
    : !(s >= 0 && s < c) ? 'The SL must be below the combined premium.'
    : !(t > c) ? 'The target must be above the combined premium.' : null;
  const nowSum = ceNow + peNow;
  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/jodi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        ce: { tradingsymbol: ce.tradingsymbol, exchange: ce.exchange, instrument_token: ce.instrument_token, lot_size: ce.lot_size },
        pe: { tradingsymbol: pe.tradingsymbol, exchange: pe.exchange, instrument_token: pe.instrument_token, lot_size: pe.lot_size },
        lots, ceEntry: num(ceEntry), peEntry: num(peEntry), combined: c, sl: s, target: t, practice }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) { toast.error(j?.error || 'The Jodi could not be saved.', { duration: 7000 }); return; }
      toast.success(practice ? 'Jodi saved (practice): no real order will be sent.' : `Jodi saved. Both are bought when the two prices together are at or below ${c.toFixed(2)}.`, { duration: 6000 });
      onSaved();
    } catch (e) { toast.error('The Jodi could not be saved: no answer from the server.'); }
    finally { setBusy(false); }
  };
  return (
    <Shell onClose={onClose} label="setup">
      <div className="flex items-center justify-between pl-4 pr-2 pt-3 pb-2">
        <div>
          <div className="text-[16px] leading-tight font-semibold">Jodi</div>
          <div className="text-[11px] leading-tight text-muted-foreground mt-[2px]">One Call and one Put, bought together</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="h-9 w-9 flex items-center justify-center rounded-full text-foreground/70 active:bg-foreground/10"><X size={18} /></button>
      </div>
      <div className="px-4 pb-4 space-y-3">
        {([[ce, ceNow, ceEntry, setCeEntry, 'ceEntry'], [pe, peNow, peEntry, setPeEntry, 'peEntry']] as const).map(([l, nowPx, val, setVal, nm]) => (
          <div key={l.type} className="flex items-end gap-3">
            <div className="flex-1 min-w-0 pb-[7px]">
              <div data-jodi-leg={l.type} className="text-[13px] leading-tight font-semibold truncate">{legName(l)}</div>
              <div className="text-[11px] leading-tight text-muted-foreground mt-[3px] tabular-nums">Now {px(nowPx)}</div>
            </div>
            <div className="w-[120px]"><Field label="Entry price" name={nm} value={val} onChange={setVal} /></div>
          </div>
        ))}
        <Field label="Combined premium (both are bought at or below this)" name="combined" value={combined} onChange={setCombinedOwn}
          hint={nowSum > 0 ? `The two together are ${nowSum.toFixed(2)} now${c > 0 ? (nowSum <= c ? ' — at or below this, so both would be bought as soon as you save.' : ' — both are bought when that falls to this.') : '.'}` : undefined} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="SL (combined value)" name="sl" value={sl} onChange={setSlOwn} />
          <Field label="Target (combined value)" name="target" value={target} onChange={setTargetOwn} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] leading-none text-muted-foreground mb-[6px]">Lots (each option)</div>
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Fewer lots" onClick={() => setLots((n) => Math.max(1, n - 1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-foreground/15 active:bg-foreground/10"><Minus size={15} /></button>
              <span data-jodi-field="lots" className="w-8 text-center text-[15px] font-semibold tabular-nums">{lots}</span>
              <button type="button" aria-label="More lots" onClick={() => setLots((n) => Math.min(50, n + 1))} className="h-9 w-9 flex items-center justify-center rounded-lg border border-foreground/15 active:bg-foreground/10"><Plus size={15} /></button>
              <span className="text-[11px] text-muted-foreground tabular-nums">{qty > 0 ? `${qty} qty each` : ''}</span>
            </div>
          </div>
          <button type="button" role="switch" aria-checked={practice} data-jodi-field="practice" onClick={() => setPractice((v) => !v)} className="flex items-center gap-2 text-[12px] text-foreground/80">
            Practice
            <span className={`relative h-[18px] w-8 rounded-full transition-colors ${practice ? 'bg-primary' : 'bg-foreground/25'}`}><span className="absolute top-[3px] h-3 w-3 rounded-full bg-white transition-[left]" style={{ left: practice ? 17 : 3 }} /></span>
          </button>
        </div>
        <div data-jodi="summary" className="rounded-lg bg-foreground/[0.05] px-3 py-2 text-[11.5px] leading-relaxed text-foreground/80">
          {problem
            ? <span className="text-destructive">{problem}</span>
            : <>
                {qty > 0 && <div>At the SL: <span className="font-semibold text-[#E24556]">−{inr((c - s) * qty)}</span> · at the target: <span className="font-semibold text-[#2EA068]">+{inr((t - c) * qty)}</span> <span className="text-muted-foreground">(before charges)</span></div>}
                <div className="text-muted-foreground">A leg that falls under half its buy price is sold and the other runs on. Everything is sold at 3:20 PM. Trade Guard does not apply.{practice ? ' Practice: no real order is sent.' : ''}</div>
              </>}
        </div>
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="flex-1 h-11 rounded-xl border border-foreground/15 text-[14px] font-medium active:bg-foreground/10">Cancel</button>
          <button type="button" data-jodi="save" disabled={!!problem || busy} onClick={save}
            className={`flex-1 h-11 rounded-xl text-[14px] font-semibold ${problem || busy ? 'bg-foreground/10 text-foreground/40' : 'bg-primary text-primary-foreground active:opacity-80'}`}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Shell>
  );
}

const STATE_WORD: Record<string, string> = { PENDING: 'Waiting to enter', ENTERING: 'Buying both…', ACTIVE: 'Running', EXITING: 'Exiting…', ERROR: 'Exit failed — exit it yourself', DONE: 'Closed', CANCELLED: 'Cancelled', FAILED: 'Not entered' };

function JodiStatus({ j, today, onClose, onChanged }: { j: any; today: any[]; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const exit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/jodi/${encodeURIComponent(j.id)}/exit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => null);
      if (d?.ok) toast.success(d.cancelled ? 'Jodi cancelled. Nothing was bought.' : 'Jodi exited.', { duration: 5000 });
      else toast.error(d?.error || 'The exit did not go through.', { duration: 9000 });
    } catch (e) { toast.error('No answer from the server. Check the two options on their position cards.', { duration: 9000 }); }
    finally { setBusy(false); onChanged(); }
  };
  const pending = j.status === 'PENDING', held = j.status === 'ACTIVE' || j.status === 'ERROR' || j.status === 'EXITING';
  const pnl = Number(j.live_pnl);
  const leg = (k: 'ce' | 'pe') => (
    <div key={k} data-jodi-row={k} className="flex items-center justify-between py-[7px] border-b border-foreground/10 text-[12.5px]">
      <span className="font-semibold">{j[`${k}_name`]}</span>
      <span className="tabular-nums text-foreground/80">
        {pending || j.status === 'ENTERING' ? <>entry {px(j[`${k}_entry`])} · now {px(j[`${k}_ltp`])}</>
          : j[`${k}_held`] ? <>bought {px(j[`${k}_buy`])} · now {px(j[`${k}_ltp`])}</>
          : <>bought {px(j[`${k}_buy`])} · <span className="text-muted-foreground">sold {px(j[`${k}_sold`])}</span></>}
      </span>
    </div>
  );
  return (
    <Shell onClose={onClose} label="status">
      <div className="flex items-center justify-between pl-4 pr-2 pt-3 pb-1">
        <div>
          <div className="text-[16px] leading-tight font-semibold">Jodi{j.practice ? ' · Practice' : ''}</div>
          <div data-jodi="state" className={`text-[11.5px] leading-tight mt-[2px] ${j.status === 'ERROR' ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>{STATE_WORD[j.status] || j.status} · {j.lots} lot{j.lots > 1 ? 's' : ''} ({j.qty} qty each)</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="h-9 w-9 flex items-center justify-center rounded-full text-foreground/70 active:bg-foreground/10"><X size={18} /></button>
      </div>
      <div className="px-4 pb-4">
        {leg('ce')}{leg('pe')}
        <div className="grid grid-cols-3 gap-2 mt-3 text-center">
          {([['SL', px(j.sl), 'text-[#E24556]'], [pending ? 'Together now' : 'Combined value', j.value != null ? Number(j.value).toFixed(2) : '—', 'text-foreground'], [pending ? 'Buys at or below' : 'Target', px(pending ? j.combined : j.target), pending ? 'text-primary' : 'text-[#2EA068]']] as const).map(([lab, val, tone]) => (
            <div key={lab} className="rounded-lg bg-foreground/[0.05] py-2">
              <div className="text-[10.5px] leading-none text-muted-foreground">{lab}</div>
              <div data-jodi-num={lab} className={`mt-[6px] text-[15px] leading-none font-semibold tabular-nums ${tone}`}>{val}</div>
            </div>
          ))}
        </div>
        {pending && <div className="mt-2 text-[11.5px] text-muted-foreground">Target {px(j.target)} · cancelled at 3:20 PM if not entered.</div>}
        {held && Number.isFinite(pnl) && j.live_pnl != null && (
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-[12px] text-muted-foreground">P&amp;L now (before charges)</span>
            <span data-jodi="pnl" className="text-[20px] font-semibold tabular-nums" style={{ color: pnl < 0 ? '#E24556' : '#2EA068' }}>{pnl < 0 ? '−' : '+'}{inr(pnl)}</span>
          </div>
        )}
        {j.detail && <div data-jodi="detail" className="mt-2 text-[11.5px] leading-snug text-foreground/70">{j.detail}</div>}
        {/* HIS EXIT BUTTON. One tap: it is inside a card he opened on purpose, and an exit must not wait on a second question. */}
        <button type="button" data-jodi="exit" disabled={busy || j.status === 'ENTERING' || j.status === 'EXITING'} onClick={exit}
          className={`mt-4 w-full h-12 rounded-xl text-[15px] font-semibold ${busy || j.status === 'ENTERING' || j.status === 'EXITING' ? 'bg-foreground/10 text-foreground/40' : pending ? 'border border-foreground/25 text-foreground active:bg-foreground/10' : 'bg-[#E24556] text-white active:opacity-80'}`}>
          {busy ? 'Working…' : j.status === 'ENTERING' ? 'Buying both…' : j.status === 'EXITING' ? 'Exiting…' : pending ? 'Cancel Jodi' : 'Exit Jodi now'}
        </button>
        {today.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] text-muted-foreground mb-1">Earlier today</div>
            {today.slice(0, 4).map((d) => (
              <div key={d.id} className="flex items-center justify-between py-[5px] text-[11.5px] border-t border-foreground/10">
                <span className="truncate pr-2">{STATE_WORD[d.status] || d.status}{d.practice ? ' (practice)' : ''}: {d.detail}</span>
                {d.pnl != null && <span className="shrink-0 font-semibold tabular-nums" style={{ color: Number(d.pnl) < 0 ? '#E24556' : '#2EA068' }}>{Number(d.pnl) < 0 ? '−' : '+'}{inr(Number(d.pnl))}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}

/** Mounted once for the app. */
export function JodiHost() {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ ce: BasketLeg; pe: BasketLeg } | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const { data } = useQuery<{ live: any; today: any[] }>({
    queryKey: ['jodi'],
    queryFn: async () => { const r = await fetch('/api/jodi'); if (!r.ok) throw new Error('jodi'); return r.json(); },
    // every 2 s while one is waiting or running (the card shows live figures), otherwise now and then
    refetchInterval: (q: any) => (q?.state?.data?.live ? 2000 : 20000),
    refetchOnWindowFocus: true,
  });
  const live = data?.live || null;
  const liveRef = useRef<any>(null); liveRef.current = live;
  const refresh = () => qc.invalidateQueries({ queryKey: ['jodi'] });
  // The Strategy button's dot and words, wherever that button is drawn.
  const sig = live ? `${live.status}|${live.live_pnl ?? ''}|${live.practice}` : '';
  useEffect(() => {
    try { (window as any).__jodiState = live ? { status: live.status, pnl: live.live_pnl, practice: !!live.practice } : null; window.dispatchEvent(new CustomEvent('terminal:jodi-state', { detail: (window as any).__jodiState })); } catch (e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  // What happened to a Jodi that has just stopped being live, said once on this screen.
  const lastLive = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    const was = lastLive.current;
    if (was && (!live || live.id !== was.id)) {
      const end = (data?.today || []).find((d) => d.id === was.id);
      if (end) { const text = `Jodi${end.practice ? ' (practice)' : ''}: ${end.detail || STATE_WORD[end.status] || end.status}`; if (end.status === 'FAILED' || end.status === 'ERROR') toast.error(text, { duration: 12000 }); else toast(text, { duration: 8000 }); }
    } else if (was && live && was.status === 'PENDING' && live.status === 'ACTIVE') toast.success(`Jodi entered${live.practice ? ' (practice)' : ''}: ${live.detail || ''}`, { duration: 8000 });
    lastLive.current = live ? { id: live.id, status: live.status } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.id, live?.status, data?.today?.length]);
  useEffect(() => {
    const onSetup = (e: any) => {
      const d = e?.detail;
      if (!d?.ce || !d?.pe) return;
      if (liveRef.current) { toast.error('A Jodi is already waiting or running. Exit or cancel it first.'); setStatusOpen(true); return; }
      setSetup({ ce: d.ce, pe: d.pe });
    };
    const onOpen = () => {
      if (liveRef.current) { setStatusOpen(true); return; }
      let u = 'NIFTY'; try { u = String(localStorage.getItem('chartUnderlying') || 'NIFTY'); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('terminal:option-chain', { detail: { underlying: u, basket: true } })); } catch (e) {}
    };
    window.addEventListener('terminal:jodi-setup', onSetup as any);
    window.addEventListener('terminal:jodi-open', onOpen as any);
    return () => { window.removeEventListener('terminal:jodi-setup', onSetup as any); window.removeEventListener('terminal:jodi-open', onOpen as any); };
  }, []);
  const today = useMemo(() => data?.today || [], [data]);
  // Its card goes when the Jodi does, and does not come back by itself for the next one.
  useEffect(() => { if (!live) setStatusOpen(false); }, [live]);
  if (setup) return <JodiSetup ce={setup.ce} pe={setup.pe} onClose={() => setSetup(null)} onSaved={() => { setSetup(null); refresh(); setStatusOpen(true); }} />;
  if (statusOpen && live) return <JodiStatus j={live} today={today} onClose={() => setStatusOpen(false)} onChanged={refresh} />;
  return null;
}
