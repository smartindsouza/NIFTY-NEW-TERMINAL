import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { BellRing, Bell, BellOff, TrendingUp, TrendingDown, RefreshCw, Volume2, VolumeX, CheckCircle2, AlertTriangle } from 'lucide-react';

const LS = { enabled: 'sa_enabled', log: 'sa_log', last: 'sa_last', sound: 'sa_sound', dw: 'sa_dw' };

const fmtClock = (s: string | number) => { try { return new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }); } catch { return String(s); } };

function beep() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const a = new Ctx();
    const o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, a.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.55);
    o.start(); o.stop(a.currentTime + 0.55);
  } catch { /* ignore */ }
}

// IST market hours: Mon–Fri, 09:15–15:30
function marketState(): { open: boolean; label: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === 'weekday')?.value || '';
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value || '0');
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value || '0');
  const mins = hh * 60 + mm;
  const weekend = wd === 'Sat' || wd === 'Sun';
  const open = !weekend && mins >= 555 && mins <= 930; // 09:15..15:30
  return { open, label: weekend ? 'Market closed (weekend)' : open ? 'Market open' : 'Market closed' };
}

export default function SignalAlerts() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(LS.enabled) === '1');
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(LS.sound) !== '0');
  const [divWindow, setDivWindow] = useState(() => parseInt(localStorage.getItem(LS.dw) || '5') || 5);
  const [perm, setPerm] = useState<NotificationPermission>(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const [log, setLog] = useState<any[]>(() => { try { return JSON.parse(localStorage.getItem(LS.log) || '[]'); } catch { return []; } });
  const watchStart = useRef<number>(Date.now());
  const lastNotified = useRef<string>(localStorage.getItem(LS.last) || '');

  useEffect(() => { localStorage.setItem(LS.enabled, enabled ? '1' : '0'); if (enabled) watchStart.current = Date.now(); }, [enabled]);
  useEffect(() => { localStorage.setItem(LS.sound, soundOn ? '1' : '0'); }, [soundOn]);
  useEffect(() => { localStorage.setItem(LS.dw, String(divWindow)); }, [divWindow]);
  useEffect(() => { localStorage.setItem(LS.log, JSON.stringify(log.slice(0, 50))); }, [log]);

  const { data, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ['signal-alert', divWindow],
    queryFn: async () => { const r = await fetch(`/api/signal/alert?divWindow=${divWindow}`); return await r.json(); },
    refetchInterval: enabled ? 60000 : false,
    refetchOnWindowFocus: true,
  });

  // Fire a notification when a NEW closed candle carries a qualifying signal
  useEffect(() => {
    if (!enabled || !data?.success || !data.signal) return;
    const ct: string = data.candleTime;
    if (!ct || ct === lastNotified.current) return;
    // Don't alert on a stale candle from before the user started watching this session
    if (new Date(ct).getTime() < watchStart.current - 6 * 60000) { lastNotified.current = ct; return; }
    lastNotified.current = ct; localStorage.setItem(LS.last, ct);
    const s = data.signal;
    const dirWord = s.dir === 'SHORT' ? 'bearish' : 'bullish';
    if (perm === 'granted') {
      try { new Notification(`NIFTY ${s.dir} signal`, { body: `RSI ${s.rsi} crossover + ${dirWord} divergence over ${s.divSpanCandles} candles · spot ${s.price} · ${data.candleIst} IST`, tag: ct }); } catch { /* ignore */ }
    }
    if (soundOn) beep();
    setLog((prev) => [{ ...s, candleTime: ct, candleIst: data.candleIst, at: Date.now() }, ...prev].slice(0, 50));
  }, [data?.candleTime, data?.signal, enabled, perm, soundOn]);

  const askPermission = async () => {
    if (typeof Notification === 'undefined') return;
    try { const p = await Notification.requestPermission(); setPerm(p); } catch { /* ignore */ }
  };
  const sendTest = () => {
    if (perm === 'granted') { try { new Notification('Test alert', { body: 'Notifications are working. You\u2019ll get a ping like this on a live signal.' }); } catch { /* ignore */ } }
    if (soundOn) beep();
  };

  const mkt = marketState();
  const ok = data?.success;
  const sig = ok ? data.signal : null;
  const cross = ok ? data.crossover : null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 pb-24">
      <div className="flex items-center gap-2 mb-1">
        <BellRing className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">Signal Alerts</h1>
      </div>
      <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
        Pings you when the latest closed <span className="text-foreground">5-min NIFTY</span> candle shows an <span className="text-foreground">RSI zone crossover</span> together with <span className="text-foreground">RSI divergence</span> (high-to-high or low-to-low) within ≤{divWindow} candles — the same entry condition as the backtest.
      </p>

      {/* Status strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-4">
        <div className="rounded-xl bg-card p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Market</div>
          <div className={cn('text-sm font-semibold mt-0.5', mkt.open ? 'text-emerald-400' : 'text-muted-foreground')}>{mkt.open ? 'Open' : 'Closed'}</div>
        </div>
        <div className="rounded-xl bg-card p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Last candle</div>
          <div className="text-sm font-semibold mt-0.5 text-foreground">{ok ? data.candleIst : '—'}</div>
        </div>
        <div className="rounded-xl bg-card p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Index RSI</div>
          <div className="text-sm font-semibold mt-0.5 font-mono text-foreground">{ok && data.currentRsi != null ? data.currentRsi : '—'}</div>
        </div>
        <div className="rounded-xl bg-card p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Checked</div>
          <div className="text-sm font-semibold mt-0.5 text-foreground">{dataUpdatedAt ? fmtClock(dataUpdatedAt) : '—'}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-2xl bg-card p-4 mb-4">
        {perm !== 'granted' && (
          <div className="flex items-start gap-2 mb-3 text-xs text-amber-400 bg-amber-500/10 rounded-lg p-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              Browser notifications are {perm === 'denied' ? 'blocked — enable them in your browser/site settings to get pings.' : 'not enabled yet.'}
              {perm === 'default' && <button onClick={askPermission} className="ml-2 underline font-semibold">Enable notifications</button>}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <button onClick={() => setEnabled((v) => !v)}
            className={cn('flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-colors',
              enabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>
            {enabled ? <BellRing className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
            {enabled ? 'Watching' : 'Paused'}
          </button>
          <button onClick={() => setSoundOn((v) => !v)}
            className={cn('flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl transition-colors', soundOn ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
            {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />} {soundOn ? 'Sound on' : 'Sound off'}
          </button>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Div ≤</span>
            <select value={divWindow} onChange={(e) => setDivWindow(parseInt(e.target.value))}
              className="text-xs font-mono px-2 py-2 rounded-lg bg-popover text-foreground border border-border focus:border-primary outline-none">
              {[3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="text-[11px] text-muted-foreground">candles</span>
          </div>
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-popover hover:bg-muted text-foreground disabled:opacity-50 transition-colors ml-auto">
            <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Check now
          </button>
          <button onClick={sendTest} className="text-xs font-semibold px-3 py-2 rounded-xl bg-popover hover:bg-muted text-foreground transition-colors">Test</button>
        </div>
        {enabled && <div className="text-[11px] text-muted-foreground mt-2.5">Checking every 60s while this page stays open. Keep the tab open (or add the app to your home screen) to keep receiving alerts.</div>}
      </div>

      {/* Current candle verdict */}
      {!ok ? (
        <div className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">{data?.error || 'Loading…'}</div>
      ) : sig ? (
        <div className={cn('rounded-2xl border p-5 mb-4', sig.dir === 'SHORT' ? 'bg-rose-500/10 border-rose-500/30' : 'bg-emerald-500/10 border-emerald-500/30')}>
          <div className="flex items-center gap-2 mb-2">
            {sig.dir === 'SHORT' ? <TrendingDown className="w-5 h-5 text-rose-400" /> : <TrendingUp className="w-5 h-5 text-emerald-400" />}
            <span className={cn('text-base font-bold', sig.dir === 'SHORT' ? 'text-rose-400' : 'text-emerald-400')}>{sig.dir} signal on the last candle</span>
          </div>
          <div className="text-sm text-foreground/90 leading-relaxed">
            RSI crossover at <span className="font-mono font-semibold">{sig.rsi}</span> with {sig.dir === 'SHORT' ? 'bearish' : 'bullish'} divergence over <span className="font-semibold">{sig.divSpanCandles}</span> candles
            ({sig.dir === 'SHORT' ? 'price' : 'price'} {sig.priceFrom} → {sig.priceTo}, RSI {sig.rsiFrom} → {sig.rsiTo}).
          </div>
          <div className="text-[11px] text-muted-foreground mt-2">Spot {sig.price} · candle {data.candleIst} IST · educational signal, not advice</div>
        </div>
      ) : (
        <div className="rounded-2xl bg-card p-5 mb-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="w-4 h-4" />
            No alert on the last candle.
          </div>
          {cross?.onLast && <div className="text-[11px] text-amber-400 mt-1.5">A {cross.dir} crossover fired, but there was no matching divergence within ≤{divWindow} candles — so no alert.</div>}
          {cross && !cross.onLast && <div className="text-[11px] text-muted-foreground mt-1.5">Last crossover was {cross.dir}, {cross.barsAgo} candle(s) ago.</div>}
        </div>
      )}

      {/* Alert log */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">Alert history</h2>
        {log.length > 0 && <button onClick={() => { setLog([]); }} className="text-[11px] text-muted-foreground hover:text-foreground">Clear</button>}
      </div>
      {log.length === 0 ? (
        <div className="text-sm text-muted-foreground">No alerts fired yet.</div>
      ) : (
        <div className="space-y-2">
          {log.map((a, k) => (
            <div key={k} className="rounded-xl bg-card p-3 flex items-center gap-3">
              {a.dir === 'SHORT' ? <TrendingDown className="w-4 h-4 text-rose-400 shrink-0" /> : <TrendingUp className="w-4 h-4 text-emerald-400 shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">{a.dir} · RSI {a.rsi} · div {a.divSpanCandles} candles</div>
                <div className="text-[11px] text-muted-foreground">spot {a.price} · candle {a.candleIst} IST</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground mt-5 leading-relaxed">
        Note: these alerts arrive while this page is open in your browser or installed app. For pings when the app is fully closed (true background push, including iPhone), a service-worker push setup is needed — ask and I can add it.
      </p>
    </div>
  );
}
