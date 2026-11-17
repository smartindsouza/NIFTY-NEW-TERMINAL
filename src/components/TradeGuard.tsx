import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

// ONE POLLER FOR THE WHOLE APP, NEVER MORE THAN ONE REQUEST IN 5 SECONDS (16 Nov
// 2026). This hook used to own its request: every mount fetched at once (the
// shield remounts whenever the chart comes back from a reference symbol, GIFT /
// US30), and every window "focus" event fetched again with nothing in between.
// On Martin's phone that added up to 6 requests in 15 seconds — which of the two
// fired when was not captured — and the app raised its "high frequency API"
// warning for /api/guard/status. It was a false alarm for Zerodha (the server
// answers from a 5 s cache) but it was real noise, and requests landing together
// on a cold cache did each cost their own broker read.
//
// The status now lives in one module-level store. A mount is served from it; a
// focus or a tab coming back asks for a refresh, which is dropped if one was
// sent in the last MIN_GAP_MS (the server would hand back the same cached answer
// anyway) and joins the request already in flight otherwise. Worst case is 3
// requests in any 15 s, under the warning's limit of 5 — so the endpoint does
// NOT need adding to the exempt list in apiInterceptor.ts, and the warning stays
// meaningful if something ever does start hammering it.
const POLL_MS = 15000;
const MIN_GAP_MS = 5000;
let shared: Status | null = null;
let sharedAt = 0;
// A remount is served from the store only while the answer is recent. The chart
// can sit unmounted for hours (another page, overnight); yesterday's "4/4 —
// blocked" must not flash up before today's answer arrives.
const recent = () => (shared && Date.now() - sharedAt < 60000 ? shared : null);
const subscribers = new Set<(s: Status | null) => void>();
let inFlight: Promise<void> | null = null;
let lastSentAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const publish = (s: Status | null) => { shared = s; sharedAt = Date.now(); subscribers.forEach(fn => fn(s)); };
function refreshGuard(): Promise<void> {
  if (inFlight) return inFlight;
  if (Date.now() - lastSentAt < MIN_GAP_MS) return Promise.resolve();
  lastSentAt = Date.now();
  inFlight = (async () => {
    try { const r = await fetch('/api/guard/status'); const j = await r.json(); if (j?.success) publish(j); } catch { }
  })().finally(() => { inFlight = null; });
  return inFlight;
}
const onWake = () => { if (document.visibilityState !== 'hidden') void refreshGuard(); };
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { void refreshGuard(); }, POLL_MS);
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', onWake);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  window.removeEventListener('focus', onWake);
  document.removeEventListener('visibilitychange', onWake);
}

export function useTradeGuard() {
  const [st, setLocal] = useState<Status | null>(recent);
  useEffect(() => {
    subscribers.add(setLocal);
    setLocal(recent());          // whatever arrived between render and this effect
    startPolling();
    void refreshGuard();
    return () => { subscribers.delete(setLocal); if (!subscribers.size) stopPolling(); };
  }, []);
  // Saving the rules returns the new status; it goes to every shield on screen.
  return [st, publish as (s: Status) => void] as const;
}

// `label`: on a phone the shield is a row of the chart's Settings sheet, where an
// icon alone would not say what it is — so its name goes beside it there, and
// today's count (or Off) at the end of the row, red while entries are blocked.
// No more words than that: he wants the app as bare as Lemonn's. On a desktop
// (md and up) it is the same square button as before.
// `onClosed`: the sheet was opened from a list (the phone's Settings, ScalpPro's
// menu) and has just been closed, however it was closed — the list it came
// from closes with it (see A TAP OUTSIDE CLOSES WHAT IS BEHIND IT TOO, below).
export function TradeGuardButton({ className, label, onClosed }: { className?: string; label?: boolean; onClosed?: () => void }) {
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
        {on && st && <span className={label ? 'hidden md:inline' : 'hidden sm:inline'}>{st.entriesToday ?? '—'}/{st.rules.maxTrades}</span>}
        {label && (
          <>
            <span className="md:hidden text-[13px] font-medium font-sans text-foreground">Trade guard</span>
            <span className={cn('md:hidden ml-auto text-[12px] font-semibold font-sans', !on ? 'text-muted-foreground' : blocked ? 'text-rose-400' : 'text-emerald-400')}>
              {!on ? 'Off' : st ? `${st.entriesToday ?? '—'}/${st.rules.maxTrades}` : ''}
            </span>
          </>
        )}
      </button>
      {open && <TradeGuardSheet st={st} onSaved={setSt} onClose={() => { setOpen(false); try { onClosed?.(); } catch (e) {} }} />}
    </>
  );
}

function TradeGuardSheet({ st, onSaved, onClose }: { st: Status | null; onSaved: (s: Status) => void; onClose: () => void }) {
  const r = st?.rules;
  const [f, setF] = useState<Rules>(r || { enabled: true, startTime: '10:00', maxTrades: 4, maxLoss: 3000 });
  // THE TWO NUMBERS ARE TYPED AS TEXT (17 Nov 2026). Martin, trying to make 4
  // into 5: "Unable to change the Max trade per day" — the box read "05". They
  // were number fields holding a number: rubbed out, the number was 0, the box
  // showed "0", and the 5 typed next went after it. They hold what was typed
  // now — digits only, nothing in front — and it is made a number when saved.
  const [maxTradesText, setMaxTradesText] = useState(String(f.maxTrades));
  const [maxLossText, setMaxLossText] = useState(String(f.maxLoss));
  const digits = (v: string, len: number) => v.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, len);
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
    const maxTrades = parseInt(maxTradesText, 10), maxLoss = parseInt(maxLossText, 10);
    if (!(maxTrades >= 1 && maxTrades <= 50)) { toast.error('Max trades a day: 1 to 50'); return; }
    if (!(maxLoss >= 100)) { toast.error('Loss limit: ₹100 or more'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/guard/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, maxTrades, maxLoss }) });
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
  // THE SHEET IS ON TOP OF EVERYTHING, AND ITS SAVE BUTTON IS ALWAYS IN SIGHT
  // (17 Nov 2026). Martin, with a picture of it on his phone: "Can't find the
  // save button". On a phone the shield is a row of the chart's Settings list,
  // and the sheet was drawn inside that list — which sits UNDER the app's
  // bottom bar and the Option Chain | ScalpPro buttons. So the foot of the
  // sheet, where Cancel and Save are, was behind them, and since Save was the
  // last thing in the part that scrolls, scrolling could not bring it out.
  // It is drawn on the page itself now, above those bars; only the rules
  // scroll, and the row with Cancel and Save stays put under them, clear of the
  // home indicator.
  // A TAP OUTSIDE CLOSES WHAT IS BEHIND IT TOO. "whenever i tap on any part of
  // the chart, any list or setting that was open has to disappear. For example
  // when the trade guard settings are open and I tap on the chart outside, the
  // trade guard disappears but the settings list still keeps open." The list
  // the sheet was opened from is closed when the sheet is (onClosed), so one
  // tap leaves the chart with nothing over it.
  return createPortal(
    <div data-guard-sheet="" className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-full sm:max-w-[400px] bg-card border border-border rounded-t-2xl sm:rounded-2xl max-h-[88dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 font-semibold"><Shield size={18} className="text-emerald-400" /> Trade guard</div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground"><X size={20} /></button>
        </div>
        <div data-guard-rules="" className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3 space-y-4">
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
              <input data-guard="max-trades" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={maxTradesText} onChange={(e) => setMaxTradesText(digits(e.target.value, 2))} onFocus={(e) => e.target.select()} className="w-20 h-9 px-2 rounded-md bg-background border border-border font-mono text-sm" />
            </label>
            <label className="flex items-center justify-between text-sm gap-3">
              <span>Stop for the day at a loss of ₹</span>
              <input data-guard="max-loss" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={maxLossText} onChange={(e) => setMaxLossText(digits(e.target.value, 7))} onFocus={(e) => e.target.select()} className="w-24 h-9 px-2 rounded-md bg-background border border-border font-mono text-sm" />
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
            Only new entries you place (order ticket, Quick Trade, ScalpPro, waiting orders) are blocked — never an exit, SL, TP or Exit All. Telegram auto-trades keep their own limits. Stricter changes apply now; relaxed ones start the next trading day.
            {pendingText && <div className="mt-1 text-amber-400">Waiting for {st?.pendingFrom}: {pendingText}.</div>}
          </div>
        </div>
        <div data-guard-foot="" className="shrink-0 flex justify-end gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-border">
          <button onClick={onClose} className="px-3 h-9 rounded-md bg-muted text-sm">Cancel</button>
          <button data-guard="save" onClick={save} disabled={busy} className="px-4 h-9 rounded-md bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
