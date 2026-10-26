import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Users, Power, LogIn, DoorOpen, TrendingUp, Copy } from 'lucide-react';

// SECOND ACCOUNT (26 Oct 2026): Martin's wife's Zerodha takes the channel's calls
// too (server/family_trader.ts). Her own switch, lots and daily cap; the timing
// rules (points above range, wait, last entry, square-off) are the ones above.
// Same PIN rules as the rest of the page: switching OFF and Exit never need it.

const inr = (v: any) => (v === null || v === undefined || isNaN(Number(v))) ? '—'
  : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const hhmm = (ms?: number | null) => ms ? new Date(ms + 5.5 * 3600000).toISOString().slice(11, 16) : '';
const WORD: Record<string, string> = { WATCHING: 'Watching price', ORDERED: 'Ordering', OPEN: 'Bought', CLOSING: 'Exiting', CLOSED: 'Closed', SKIPPED: 'Skipped', FAILED: 'Failed' };
const LOGIN_MSG: Record<string, [boolean, string]> = {
  ok: [true, 'Her Zerodha is logged in for today'],
  wronguser: [false, 'That Zerodha account is not the one set as FAMILY_KITE_USER_ID — not saved'],
  cancelled: [false, 'Zerodha login was cancelled'], error: [false, 'Zerodha login failed — try again'],
  notset: [false, 'Second account is not set up in Railway yet'],
};

export default function FamilyAccountCard({ pin }: { pin: string }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<any>(null);
  const { data, refetch } = useQuery({
    queryKey: ['family-status'],
    queryFn: async () => (await fetch('/api/family/status')).json(),
    refetchInterval: 3000, refetchOnWindowFocus: true,
  });
  const s = data?.settings;
  useEffect(() => { if (s && !form) setForm({ ...s }); }, [s, form]);

  // back from Zerodha's login page: say how it went, then clean the address bar
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('family');
      if (!q) return;
      const [good, text] = LOGIN_MSG[q] || [false, 'Zerodha login: ' + q];
      good ? toast.success(text) : toast.error(text);
      window.history.replaceState(null, '', window.location.pathname);
    } catch { }
  }, []);

  const post = async (url: string, body: any = {}, withPin = true) => {
    setBusy(true);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withPin ? { ...body, pin } : body) });
      const d = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (d.ok === false && d.error) toast.error(d.error);
      refetch();
      return d;
    } catch (e: any) { toast.error(String(e?.message || e)); return { ok: false }; }
    finally { setBusy(false); }
  };
  const setMode = async (mode: 'OFF' | 'PRACTICE' | 'LIVE') => {
    if (mode === 'LIVE' && !window.confirm(`Turn on LIVE for ${s?.name || 'the second account'}? Real orders will be placed on HER Zerodha from the channel's calls.`)) return;
    const d = await post('/api/family/settings', { mode }, mode !== 'OFF');
    if (d.ok) toast.success(`${d.settings.name}: ${mode === 'OFF' ? 'OFF' : mode === 'LIVE' ? 'LIVE' : 'PRACTICE'}`);
  };
  const loginUrl = `${window.location.origin}/api/family/kite/login`;

  if (!data) return null;
  const rows: any[] = data.trades || [];
  const open = rows.filter(r => ['OPEN', 'CLOSING'].includes(r.status));
  const pnl = rows.filter(r => r.status === 'CLOSED' && r.mode === 'LIVE').reduce((a, r) => a + (Number(r.pnl) || 0), 0);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="w-5 h-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h2 className="font-bold">Second account{s?.name && s.name !== 'Second account' ? ` — ${s.name}` : ''}</h2>
            <div className="text-[11px] text-muted-foreground">
              Takes the channel's calls on her own Zerodha · {s?.lots === 'MAX' ? `max lots (cap ${s.maxLotsCap})` : `${s?.lots} lot`} · max {s?.maxTrades}/day · today {data.tradesToday}
              {rows.some(r => r.status === 'CLOSED' && r.mode === 'LIVE') && <span className={cn('ml-1 font-mono font-bold', pnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}> · P&L {pnl >= 0 ? '+' : ''}{inr(pnl)}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-popover rounded-xl p-1">
          {(['OFF', 'PRACTICE', 'LIVE'] as const).map(m => (
            <button key={m} disabled={busy || (m !== 'OFF' && !data.configured)} onClick={() => setMode(m)}
              className={cn('text-xs font-bold px-3 py-2 rounded-lg transition-colors disabled:opacity-40',
                s?.mode === m ? (m === 'LIVE' ? 'bg-emerald-500 text-white' : m === 'PRACTICE' ? 'bg-sky-500 text-white' : 'bg-rose-500/80 text-white') : 'text-muted-foreground hover:text-foreground')}>
              {m === 'OFF' && <Power className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />}{m === 'PRACTICE' ? 'Practice' : m === 'LIVE' ? 'Live' : 'Off'}
            </button>
          ))}
        </div>
      </div>

      {!data.configured ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs p-3 space-y-1">
          <div className="font-bold">Not set up yet</div>
          <div>1. In your Kite Connect developer console, create an app for her Zerodha client ID (the free "Personal" type is enough — prices come from your feed).</div>
          <div>2. Set that app's Redirect URL to <span className="font-mono break-all">{window.location.origin}/api/family/kite/callback</span></div>
          <div>3. In Railway add <b>FAMILY_KITE_API_KEY</b>, <b>FAMILY_KITE_API_SECRET</b> (from her app) and <b>FAMILY_KITE_USER_ID</b> (her Zerodha client ID), then redeploy.</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className={cn('font-bold px-2 py-1 rounded-md', data.kite.loggedIn ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400')}>
            Her Zerodha: {data.kite.loggedIn ? `logged in${data.kite.user ? ` (${data.kite.user})` : ''} at ${hhmm(data.kite.at)}` : 'not logged in today'}
          </span>
          <a href="/api/family/kite/login" className="flex items-center gap-1 font-bold px-3 py-1.5 rounded-lg bg-primary text-primary-foreground"><LogIn className="w-3.5 h-3.5" /> Log in her Zerodha</a>
          <button onClick={() => { try { navigator.clipboard.writeText(loginUrl); toast.success('Login link copied — send it to her'); } catch { toast(loginUrl); } }}
            className="flex items-center gap-1 font-bold px-3 py-1.5 rounded-lg bg-popover"><Copy className="w-3.5 h-3.5" /> Copy link for her</button>
          <span className="text-[11px] text-muted-foreground w-full">Zerodha needs her login every morning, like yours. Without it her calls are skipped and you get one alert at 09:10.</span>
        </div>
      )}

      {open.map(x => {
        const L = x.ladder || {}; const tps: number[] = L.tps || [];
        return (
          <div key={x.id} className={cn('rounded-xl border-2 p-3 space-y-2', x.mode === 'LIVE' ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-sky-500/40 bg-sky-500/5')}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div className="font-bold text-sm">{x.tradingsymbol} <span className="text-[11px] font-semibold text-muted-foreground">{x.mode} · {x.qty} qty</span></div>
                <div className="text-[11px] text-muted-foreground">Bought {inr(x.entry)} at {hhmm(x.entry_at)} · last {inr(x.last_ltp)}{x.status === 'CLOSING' ? ' · exit sent' : ''}</div>
              </div>
              <div className="flex gap-2">
                {L.stage >= 3 && L.decision === 'PENDING' && (
                  <button disabled={busy} onClick={() => post('/api/family/keep', { id: x.id }, false).then(d => d?.message && toast(d.message))}
                    className="flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-lg bg-sky-500/20 text-sky-300"><TrendingUp className="w-3.5 h-3.5" /> Keep trailing</button>
                )}
                <button disabled={busy} onClick={() => { if (window.confirm(`Exit her ${x.tradingsymbol} now?`)) post('/api/family/exit', { id: x.id }, false); }}
                  className="flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-lg bg-rose-500 text-white"><DoorOpen className="w-3.5 h-3.5" /> Exit hers</button>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div className="rounded-lg bg-rose-500/15 py-1"><div className="text-[10px] uppercase text-muted-foreground">SL now</div><div className="font-mono font-bold">{inr(L.sl)}</div></div>
              {tps.map((v, i) => (
                <div key={i} className={cn('rounded-lg py-1', (L.stage || 0) > i ? 'bg-emerald-500/20' : 'bg-muted/50')}>
                  <div className="text-[10px] uppercase text-muted-foreground">TP{i + 1}{(L.stage || 0) > i ? ' ✓' : ''}</div><div className="font-mono font-bold">{inr(v)}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {rows.filter(r => !['OPEN', 'CLOSING'].includes(r.status)).length > 0 && (
        <div className="space-y-1">
          {rows.filter(r => !['OPEN', 'CLOSING'].includes(r.status)).map(r => (
            <div key={r.id} className="flex items-start gap-2 text-xs border-b border-border/50 pb-1 last:border-0">
              <span className="font-mono text-muted-foreground w-11 shrink-0">{hhmm(r.created_at)}</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{r.underlying} {r.strike} {r.option_type}{r.mode === 'PRACTICE' ? <span className="font-normal text-muted-foreground"> · practice</span> : null}</div>
                {r.entry != null && <div className="text-muted-foreground">bought {inr(r.entry)} × {r.qty}{r.status === 'CLOSED' ? ` → ${r.exit_price != null ? `sold ${inr(r.exit_price)}` : 'closed'} (${r.exit_reason})${r.pnl != null ? ` · ${Number(r.pnl) >= 0 ? '+' : ''}${inr(r.pnl)}` : ''}` : ''}</div>}
                {r.reason && r.status !== 'CLOSED' && <div className="text-muted-foreground">{r.reason}</div>}
              </div>
              <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted">{WORD[r.status] || r.status}</span>
            </div>
          ))}
        </div>
      )}

      {form && data.configured && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs pt-1">
          <label className="flex flex-col gap-1 text-muted-foreground">Name on alerts
            <input value={form.name ?? ''} maxLength={30} onChange={e => setForm({ ...form, name: e.target.value })}
              className="h-8 px-2 rounded-md bg-popover border border-border text-foreground" />
          </label>
          <label className="flex flex-col gap-1 text-muted-foreground">Her lots per trade
            <select value={String(form.lots)} onChange={e => setForm({ ...form, lots: e.target.value === 'MAX' ? 'MAX' : Number(e.target.value) })}
              className="h-8 px-2 rounded-md bg-popover border border-border font-mono text-foreground">
              <option value="MAX">Max possible (her funds)</option>
              {Array.from({ length: 25 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {form.lots === 'MAX' && (
            <label className="flex flex-col gap-1 text-muted-foreground">Never more than (lots)
              <input type="number" min={1} max={25} value={form.maxLotsCap ?? 10} onChange={e => setForm({ ...form, maxLotsCap: e.target.value })}
                className="h-8 px-2 rounded-md bg-popover border border-border font-mono text-foreground" />
            </label>
          )}
          <label className="flex flex-col gap-1 text-muted-foreground">Her max trades a day
            <input type="number" min={1} max={10} value={form.maxTrades ?? 3} onChange={e => setForm({ ...form, maxTrades: e.target.value })}
              className="h-8 px-2 rounded-md bg-popover border border-border font-mono text-foreground" />
          </label>
          <div className="col-span-2 md:col-span-4 flex items-center gap-3 flex-wrap">
            <button disabled={busy} onClick={async () => { const d = await post('/api/family/settings', { name: form.name, lots: form.lots, maxLotsCap: form.maxLotsCap, maxTrades: form.maxTrades }); if (d.ok) { setForm({ ...d.settings }); toast.success('Saved'); } }}
              className="text-xs font-bold px-3 py-2 rounded-lg bg-primary text-primary-foreground">Save her rules</button>
            <span className="text-[11px] text-muted-foreground flex-1 min-w-[200px]">Same entry range, SL and TP ladder as the call. Timing ({data.timing?.allowAbove} pts above range, wait {data.timing?.waitMin} min, last entry {data.timing?.lastEntry}, square-off {data.timing?.squareOff}) follows your Rules above. Runs whether your own auto-trade is on or off.</span>
          </div>
        </div>
      )}
    </div>
  );
}
