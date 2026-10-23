import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Send, Power, Bot, KeyRound, LogOut, RefreshCw, Check, DoorOpen, TrendingUp, ChevronDown, ChevronRight } from 'lucide-react';

// Telegram Auto-Trade: reads one channel's BUY calls and trades them with the
// message's SL (server/signal_trader.ts). This page is the switch, the setup and
// the record. Everything that changes WHAT trades needs the SIGNALS_PIN (the app
// has no login); switching OFF and pressing Exit never do.

const inr = (v: any) => (v === null || v === undefined || isNaN(Number(v))) ? '—'
  : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const t = (ms?: number | null) => {
  if (!ms) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  const d = new Date(ms + 5.5 * 3600000);
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const PIN_KEY = 'signalsPin';
const readPin = () => { try { return localStorage.getItem(PIN_KEY) || ''; } catch { return ''; } };

const STATUS_STYLE: Record<string, string> = {
  ENTERED: 'bg-emerald-500/15 text-emerald-400', WATCHING: 'bg-amber-500/15 text-amber-400',
  WAITING_LEVELS: 'bg-amber-500/15 text-amber-400', ORDERED: 'bg-sky-500/15 text-sky-400',
  SKIPPED: 'bg-muted text-muted-foreground', FAILED: 'bg-rose-500/15 text-rose-400',
};
const STATUS_WORD: Record<string, string> = {
  ENTERED: 'Bought', WATCHING: 'Watching price', WAITING_LEVELS: 'Waiting for TP/SL', ORDERED: 'Ordering',
  SKIPPED: 'Skipped', FAILED: 'Failed',
};

export default function TelegramSignals() {
  const [pin, setPin] = useState(readPin);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const [channels, setChannels] = useState<{ id: string; title: string; broadcast: boolean }[] | null>(null);
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);
  const [form, setForm] = useState<any>(null);

  const { data, refetch } = useQuery({
    queryKey: ['signals-status'],
    queryFn: async () => (await fetch('/api/signals/status')).json(),
    refetchInterval: 2000, refetchOnWindowFocus: true,
  });
  const s = data?.settings;
  useEffect(() => { if (s && !form) setForm({ ...s }); }, [s, form]);
  const ready = !!(data?.telegram?.loggedIn && s?.channelId);
  const showSetup = setupOpen ?? !ready;

  const post = async (url: string, body: any = {}, withPin = true) => {
    setBusy(true);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withPin ? { ...body, pin } : body) });
      const d = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (r.status === 401) { try { localStorage.removeItem(PIN_KEY); } catch { } }
      else if (withPin && pin && d.ok !== false) { try { localStorage.setItem(PIN_KEY, pin); } catch { } }
      if (d.ok === false && d.error) toast.error(d.error);
      refetch();
      return d;
    } catch (e: any) { toast.error(String(e?.message || e)); return { ok: false }; }
    finally { setBusy(false); }
  };

  const setMode = async (mode: 'OFF' | 'PRACTICE' | 'LIVE') => {
    if (mode === 'LIVE' && !window.confirm('Turn on LIVE auto-trading? Real orders will be placed from the channel\'s calls.')) return;
    const d = await post('/api/signals/settings', { mode }, mode !== 'OFF');
    if (d.ok) toast.success(`Auto-trade ${mode === 'OFF' ? 'OFF' : mode === 'LIVE' ? 'LIVE' : 'in PRACTICE'}`);
  };

  const open = (data?.trades || []).filter((x: any) => ['OPEN', 'MANUAL', 'CLOSING'].includes(x.status));
  const closed = (data?.trades || []).filter((x: any) => x.status === 'CLOSED');
  const dayPnl = closed.filter((x: any) => x.mode === 'LIVE').reduce((a: number, x: any) => a + (Number(x.pnl) || 0), 0);

  return (
    <div className="px-2 py-3 md:p-8 max-w-[1100px] w-full mx-auto pb-24 min-h-screen space-y-4">
      {/* header + switch */}
      <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <Send className="w-5 h-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg md:text-2xl font-bold tracking-tight">Telegram Auto-Trade</h1>
            <div className="text-[11px] text-muted-foreground truncate">
              {s?.channelTitle ? `Channel: ${s.channelTitle}` : 'No channel chosen yet'}
              {s ? ` · ${s.lots} lot · max ${s.maxTrades}/day · today ${data?.tradesToday ?? 0}` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-popover rounded-xl p-1">
          {(['OFF', 'PRACTICE', 'LIVE'] as const).map(m => (
            <button key={m} disabled={busy || (m !== 'OFF' && !ready)} onClick={() => setMode(m)}
              className={cn('text-xs font-bold px-3 py-2 rounded-lg transition-colors disabled:opacity-40',
                s?.mode === m
                  ? (m === 'LIVE' ? 'bg-emerald-500 text-white' : m === 'PRACTICE' ? 'bg-sky-500 text-white' : 'bg-rose-500/80 text-white')
                  : 'text-muted-foreground hover:text-foreground')}>
              {m === 'OFF' && <Power className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />}{m === 'PRACTICE' ? 'Practice' : m === 'LIVE' ? 'Live' : 'Off'}
            </button>
          ))}
        </div>
      </div>

      {/* PIN */}
      {data && !data.pinConfigured && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-300 text-sm p-3">
          Add a <b>SIGNALS_PIN</b> variable in Railway (any 6 digits) and redeploy — it protects setup and the Live switch.
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <KeyRound className="w-3.5 h-3.5" /> PIN
        <input value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))} inputMode="numeric" type="password"
          className="h-7 w-28 px-2 rounded-md bg-card border border-border font-mono text-foreground" placeholder="SIGNALS_PIN" />
        <span className="opacity-70">needed for setup, settings and Practice/Live — not for Off or Exit</span>
      </div>

      {/* open trades */}
      {open.map((x: any) => {
        const L = x.ladder || {};
        const tps: number[] = L.tps || [];
        return (
          <div key={x.id} className={cn('rounded-xl border-2 p-4 space-y-3', x.mode === 'LIVE' ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-sky-500/40 bg-sky-500/5')}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div className="font-bold text-base">{x.tradingsymbol} <span className="text-[11px] font-semibold text-muted-foreground">{x.mode === 'LIVE' ? 'LIVE' : 'PRACTICE'} · {x.qty} qty</span></div>
                <div className="text-[11px] text-muted-foreground">Bought {inr(x.entry)} at {t(x.entry_at)} · last {inr(x.last_ltp)}
                  {x.status === 'MANUAL' && ' · you are managing the SL on the chart'}{x.status === 'CLOSING' && ' · exit sent'}</div>
              </div>
              <div className="flex gap-2">
                {L.stage >= 3 && L.decision === 'PENDING' && x.status === 'OPEN' && (
                  <button disabled={busy} onClick={() => post('/api/signals/keep', { id: x.id }, false).then(d => d?.message && toast(d.message))}
                    className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-sky-500/20 text-sky-300 hover:bg-sky-500/30">
                    <TrendingUp className="w-3.5 h-3.5" /> Keep trailing
                  </button>
                )}
                <button disabled={busy} onClick={() => { if (window.confirm(`Exit ${x.tradingsymbol} now?`)) post('/api/signals/exit', { id: x.id }, false); }}
                  className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-rose-500 text-white hover:bg-rose-600">
                  <DoorOpen className="w-3.5 h-3.5" /> Exit now
                </button>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-lg bg-rose-500/15 py-1.5"><div className="text-[10px] uppercase text-muted-foreground">SL now</div><div className="font-mono font-bold">{inr(L.sl)}</div></div>
              {tps.map((v, i) => (
                <div key={i} className={cn('rounded-lg py-1.5', (L.stage || 0) > i ? 'bg-emerald-500/20' : 'bg-muted/50')}>
                  <div className="text-[10px] uppercase text-muted-foreground">TP{i + 1}{(L.stage || 0) > i ? ' ✓' : ''}</div>
                  <div className="font-mono font-bold">{inr(v)}</div>
                </div>
              ))}
            </div>
            {L.decision === 'KEEP' && <div className="text-[11px] text-sky-300">Trailing above TP3 in steps of {inr(tps[2] - tps[1])}.</div>}
          </div>
        );
      })}

      {/* today's calls */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-bold">Today's calls</h2>
          <span className={cn('text-xs font-mono font-bold', dayPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
            {closed.some((x: any) => x.mode === 'LIVE') ? `Live P&L ${dayPnl >= 0 ? '+' : ''}${inr(dayPnl)}` : ''}
          </span>
        </div>
        {!(data?.calls || []).length && <div className="text-sm text-muted-foreground py-4 text-center">No calls yet today.</div>}
        <div className="space-y-1.5">
          {(data?.calls || []).map((c: any) => {
            const tr = (data?.trades || []).find((x: any) => x.call_id === c.id);
            return (
              <div key={c.id} className="flex items-start gap-2 text-xs border-b border-border/50 pb-1.5 last:border-0">
                <span className="font-mono text-muted-foreground shrink-0 w-14">{t(c.received_at).slice(0, 5)}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">BUY {c.underlying} {c.strike} {c.option_type} <span className="font-normal text-muted-foreground">· {c.entry_low}–{c.entry_high}{c.sl ? ` · SL ${c.sl} · TP ${c.tp1}/${c.tp2}/${c.tp3}` : ''}</span></div>
                  {c.reason && <div className="text-muted-foreground">{c.reason}</div>}
                  {tr && <div className="text-muted-foreground">{tr.mode === 'PRACTICE' ? 'Practice: ' : ''}bought {inr(tr.entry)}{tr.status === 'CLOSED' ? ` → sold ${inr(tr.exit_price)} (${tr.exit_reason}) · ${Number(tr.pnl) >= 0 ? '+' : ''}${inr(tr.pnl)}` : ''}</div>}
                </div>
                <span className={cn('shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-md', STATUS_STYLE[c.status] || 'bg-muted')}>{STATUS_WORD[c.status] || c.status}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* settings */}
      {form && (
        <div className="bg-card border border-border rounded-xl p-4">
          <h2 className="font-bold mb-3">Rules</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            {([
              ['lots', 'Lots per trade', 'number'], ['maxTrades', 'Max trades a day', 'number'],
              ['allowAbove', 'Points allowed above range', 'number'], ['waitMin', 'Wait for price (min)', 'number'],
              ['lastEntry', 'No new entries after', 'time'], ['squareOff', 'Square-off at', 'time'],
            ] as const).map(([k, label, type]) => (
              <label key={k} className="flex flex-col gap-1 text-muted-foreground">{label}
                <input type={type} value={form[k] ?? ''} step={type === 'number' ? 'any' : undefined}
                  onChange={e => setForm({ ...form, [k]: e.target.value })}
                  className="h-8 px-2 rounded-md bg-popover border border-border font-mono text-foreground" />
              </label>
            ))}
          </div>
          <div className="text-[11px] text-muted-foreground mt-2">SL is always the one in the message. TP1 → SL to entry · TP2 → SL to TP1 · TP3 → SL to TP2 and you are asked to exit or keep trailing.</div>
          <button disabled={busy} onClick={async () => { const d = await post('/api/signals/settings', {
              lots: form.lots, maxTrades: form.maxTrades, allowAbove: form.allowAbove, waitMin: form.waitMin, lastEntry: form.lastEntry, squareOff: form.squareOff });
              if (d.ok) { setForm({ ...d.settings }); toast.success('Saved'); } }}
            className="mt-3 text-xs font-bold px-3 py-2 rounded-lg bg-primary text-primary-foreground">Save rules</button>
        </div>
      )}

      {/* setup */}
      <div className="bg-card border border-border rounded-xl p-4">
        <button onClick={() => setSetupOpen(!showSetup)} className="flex items-center gap-1.5 font-bold">
          {showSetup ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />} Setup
          <span className="text-[11px] font-normal text-muted-foreground ml-1">
            Telegram {data?.telegram?.loggedIn ? `✓ ${data.telegram.me}` : '✗'} · channel {s?.channelId ? '✓' : '✗'} · alert bot {data?.bot?.linked ? '✓' : '✗'}
          </span>
        </button>
        {showSetup && data && (
          <div className="mt-3 space-y-4 text-sm">
            <Step n={1} done={data.telegram.apiConfigured} title="Telegram app keys">
              {data.telegram.apiConfigured ? 'TELEGRAM_API_ID and TELEGRAM_API_HASH are set.' : 'Add TELEGRAM_API_ID and TELEGRAM_API_HASH (from my.telegram.org) in Railway and redeploy.'}
              <div className="text-[11px] text-muted-foreground">Connection: {data.telegram.status}</div>
            </Step>
            <Step n={2} done={data.telegram.loggedIn} title="Log in to Telegram (once)">
              {data.telegram.loggedIn ? (
                <div className="flex items-center gap-2">Logged in as <b>{data.telegram.me}</b>
                  <button disabled={busy} onClick={() => window.confirm('Log the app out of Telegram? Auto-trade will switch off.') && post('/api/signals/tg/logout')}
                    className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-popover text-muted-foreground"><LogOut className="w-3 h-3" /> Log out</button></div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2 flex-wrap">
                    <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+971 phone number" inputMode="tel"
                      className="h-8 px-2 rounded-md bg-popover border border-border font-mono w-48" />
                    <button disabled={busy || !data.telegram.apiConfigured} onClick={async () => { const d = await post('/api/signals/tg/send-code', { phone }); if (d.ok) toast.success(d.viaApp ? 'Code sent to your Telegram app' : 'Code sent by SMS'); }}
                      className="text-xs font-bold px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-40">Send code</button>
                  </div>
                  {data.telegram.awaitingCode && (
                    <div className="flex gap-2 flex-wrap">
                      <input value={code} onChange={e => setCode(e.target.value)} placeholder="code" inputMode="numeric"
                        className="h-8 px-2 rounded-md bg-popover border border-border font-mono w-28" />
                      {needPw && <input value={pw} onChange={e => setPw(e.target.value)} placeholder="2-step password" type="password"
                        className="h-8 px-2 rounded-md bg-popover border border-border w-44" />}
                      <button disabled={busy} onClick={async () => { const d = await post('/api/signals/tg/sign-in', { code, password: pw });
                          if (d.needPassword) setNeedPw(true); if (d.ok) { setCode(''); setPw(''); toast.success(`Logged in as ${d.me}`); } }}
                        className="text-xs font-bold px-3 py-2 rounded-lg bg-primary text-primary-foreground">Log in</button>
                    </div>
                  )}
                  <div className="text-[11px] text-muted-foreground">The app reads the channel as you. Telegram sends the code to your Telegram app. Never share this code with anyone.</div>
                </div>
              )}
            </Step>
            <Step n={3} done={!!s?.channelId} title="Choose the channel">
              {s?.channelId && <div>Reading <b>{s.channelTitle}</b></div>}
              <button disabled={busy || !data.telegram.loggedIn} onClick={async () => { const d = await post('/api/signals/tg/channels'); if (d.ok) setChannels(d.channels); }}
                className="flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-lg bg-popover disabled:opacity-40"><RefreshCw className="w-3 h-3" /> {s?.channelId ? 'Change' : 'Show my channels'}</button>
              {channels && (
                <div className="max-h-64 overflow-y-auto border border-border rounded-lg divide-y divide-border/60">
                  {channels.map(c => (
                    <button key={c.id} onClick={async () => { const d = await post('/api/signals/channel', { id: c.id, title: c.title }); if (d.ok) { setChannels(null); toast.success(`Reading ${c.title}`); } }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-popover flex justify-between">
                      <span>{c.title}</span><span className="text-muted-foreground">{c.broadcast ? 'channel' : 'group'}</span>
                    </button>
                  ))}
                </div>
              )}
            </Step>
            <Step n={4} done={data.bot.linked} title="Alerts with buttons (bot)">
              {!data.bot.configured ? 'Add TELEGRAM_BOT_TOKEN (from @BotFather) in Railway and redeploy. Without it, alerts go to your Saved Messages, with no buttons.'
                : data.bot.linked ? <span>Linked{data.bot.username ? <> to <b>@{data.bot.username}</b></> : ''}.</span>
                : <span>Open {data.bot.username ? <a className="text-primary underline" href={`https://t.me/${data.bot.username}`} target="_blank" rel="noreferrer">@{data.bot.username}</a> : 'your bot'} in Telegram and press <b>Start</b> (after step 2).</span>}
              <button disabled={busy || !data.telegram.loggedIn} onClick={async () => { const d = await post('/api/signals/test-alert'); if (d.ok) toast.success(d.linked ? 'Test alert sent to the bot' : 'Test alert sent to your Saved Messages'); }}
                className="flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-lg bg-popover disabled:opacity-40"><Bot className="w-3 h-3" /> Send a test alert</button>
            </Step>
          </div>
        )}
      </div>

      {/* what the app is seeing */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <h2 className="font-bold mb-2">Latest channel messages</h2>
          {!(data?.recentMessages || []).length && <div className="text-xs text-muted-foreground">Nothing read since the app started.</div>}
          <div className="space-y-1.5">
            {(data?.recentMessages || []).map((m: any, i: number) => (
              <div key={i} className="text-xs flex gap-2">
                <span className="font-mono text-muted-foreground shrink-0">{t(m.at).slice(0, 5)}</span>
                <span className={cn('shrink-0 text-[10px] font-bold px-1.5 rounded', m.parsed === 'ignored' ? 'bg-muted text-muted-foreground' : 'bg-emerald-500/15 text-emerald-400')}>{m.parsed === 'CALL' ? 'call' : m.parsed === 'LEVELS' ? 'TP/SL' : 'ignored'}</span>
                <span className="truncate">{m.text}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <h2 className="font-bold mb-2">Activity</h2>
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {(data?.events || []).map((e: any, i: number) => (
              <div key={i} className="text-xs flex gap-2"><span className="font-mono text-muted-foreground shrink-0">{t(e.at).slice(0, 5)}</span><span>{e.text}</span></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className={cn('w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0', done ? 'bg-emerald-500 text-white' : 'bg-popover text-muted-foreground')}>
        {done ? <Check className="w-3.5 h-3.5" /> : n}
      </div>
      <div className="flex-1 space-y-1.5"><div className="font-semibold">{title}</div>{children}</div>
    </div>
  );
}
