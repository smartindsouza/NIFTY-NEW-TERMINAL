// BREAKER BLOCK AND SWAP-SWEEP ALERTS, NIFTY, 5-MINUTE AND UP (20 Nov 2026).
// Martin: "Remove all the alerts which are currently getting a delivered. I just
// want a breaker block alert and Swap sweep reversal indicator alert forming in
// every time frame except the 1 min and 3 min time frame". Asked which index and
// where: NIFTY only; Telegram and in the app, both.
//
// Every minute in market hours the server reads NIFTY's completed candles on the
// 5, 15, 30 and 60-minute timeframes (ten calendar days of them, so the swings a
// breaker needs are there), and runs the app's OWN indicators over them — the same
// files the chart draws with (src/indicators/breakerLiquidity.ts, default
// settings; src/lib/swapSweep.ts, same session) — so an alert is always something
// the chart shows. It announces:
//   - a breaker block formed: the candle that closed through the swing has just
//     closed;
//   - a Swap-Sweep Reversal: its third candle has just closed.
// "Just" = within the last two candles of that timeframe and at most twelve
// minutes ago, so a restart or a missed minute does not lose one, and nothing old
// is ever replayed. Each is sent once (kept in setup_alerts), to Telegram, and is
// listed at GET /api/setup-alerts for the app to show.
// These are observations, not advice; nothing here places or changes an order.
import { computeBreakersAndGrabs, BL_DEFAULTS } from '../src/indicators/breakerLiquidity';
import { detectSwapSweep } from '../src/lib/swapSweep';

type Deps = { db: any; getKiteClient: () => any; notify: (text: string) => any };
const NIFTY = 256265;
const TFS = [5, 15, 30, 60] as const;
const IST = 5.5 * 3600 * 1000;
const kiteTime = (ms: number) => { const d = new Date(ms + IST); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
const istParts = (ms: number) => { const d = new Date(ms + IST); return { date: d.toISOString().slice(0, 10), day: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
const time12 = (sec: number) => new Date(sec * 1000).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const tfName = (tf: number) => (tf === 60 ? '1h' : `${tf}m`);

export type SetupAlert = { id: string; at: number; tf: number; kind: 'breaker' | 'swap-sweep'; dir: 'bull' | 'bear'; title: string; body: string; candle: number };

/** Pure: the alerts due from one timeframe's completed candles at `nowMs`. Exported for the test. */
export function dueAlerts(c: { time: number; open: number; high: number; low: number; close: number }[], tf: number, nowMs: number): SetupAlert[] {
  const out: SetupAlert[] = [];
  if (c.length < 3) return out;
  const fresh = (start: number) => {
    const closeMs = (start + tf * 60) * 1000;
    return start >= c[Math.max(0, c.length - 2)].time && nowMs - closeMs <= 12 * 60000 && closeMs <= nowMs;
  };
  const { breakers } = computeBreakersAndGrabs(c as any, BL_DEFAULTS);
  for (const b of breakers) {
    if (!fresh(b.breakTime)) continue;
    const bull = b.dir === 'bull';
    out.push({ id: `bb|${tf}|${b.dir}|${b.breakTime}`, at: nowMs, tf, kind: 'breaker', dir: b.dir, candle: b.breakTime,
      title: `🧱 NIFTY ${tfName(tf)} · ${bull ? 'Bullish' : 'Bearish'} breaker block`,
      body: `${bull ? 'Support' : 'Resistance'} zone ${fmt(b.bottom)}–${fmt(b.top)}. Formed when the ${time12(b.breakTime)} candle closed ${bull ? 'above' : 'below'} ${fmt(b.swingLevel)}.` });
  }
  for (const s of detectSwapSweep(c)) {
    const k = c[s.idx];
    if (!fresh(k.time)) continue;
    const bull = s.kind === 'bull';
    out.push({ id: `ss|${tf}|${s.kind}|${k.time}`, at: nowMs, tf, kind: 'swap-sweep', dir: s.kind, candle: k.time,
      title: `🔄 NIFTY ${tfName(tf)} · ${bull ? 'Bullish' : 'Bearish'} Swap-Sweep Reversal`,
      body: `The ${time12(k.time)} candle swept ${bull ? 'below' : 'above'} and closed back at ${fmt(k.close)} (${bull ? 'low' : 'high'} ${fmt(bull ? k.low : k.high)}).` });
  }
  return out;
}

let lastRun: any = { running: false };
const lastFetch: Record<number, number> = {};

export function registerSetupAlerts(app: any, D: Deps) {
  D.db.exec(`CREATE TABLE IF NOT EXISTS setup_alerts (id TEXT PRIMARY KEY, at INTEGER, tf INTEGER, kind TEXT, dir TEXT, title TEXT, body TEXT)`);
  const has = D.db.prepare('SELECT 1 FROM setup_alerts WHERE id = ?');
  const put = D.db.prepare('INSERT OR IGNORE INTO setup_alerts (id, at, tf, kind, dir, title, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const now = Date.now(); const { day, mins } = istParts(now);
      if (day === 0 || day === 6 || mins < 9 * 60 + 20 || mins > 15 * 60 + 40) { lastRun = { running: true, market: 'closed', at: now }; return; }
      const kc = D.getKiteClient();
      if (!kc || !kc.access_token) { lastRun = { running: true, error: 'Zerodha not logged in', at: now }; return; }
      const sent: string[] = [];
      for (const tf of TFS) {
        // Ask for a timeframe only when a candle of it can have closed since the last ask.
        const slot = Math.floor((now - 30000) / (tf * 60000));
        if (lastFetch[tf] === slot) continue;
        const raw: any[] = (await kc.getHistoricalData(NIFTY, tf === 60 ? '60minute' : `${tf}minute`, kiteTime(now - 10 * 86400000), kiteTime(now))) || [];
        lastFetch[tf] = slot;
        const c = raw.map((r) => ({ time: Math.floor(new Date(r.date).getTime() / 1000), open: +r.open, high: +r.high, low: +r.low, close: +r.close }))
          .filter((x) => (x.time + tf * 60) * 1000 <= now);                // completed candles only
        for (const a of dueAlerts(c, tf, now)) {
          if (has.get(a.id)) continue;
          put.run(a.id, a.at, a.tf, a.kind, a.dir, a.title, a.body);
          sent.push(a.id);
          console.log(`[setup-alerts] ${a.title} — ${a.body}`);
          try { await D.notify(`${a.title}\n${a.body}`); } catch (e) { /* in the app's list regardless */ }
        }
      }
      lastRun = { running: true, at: now, sent };
    } catch (e: any) { lastRun = { running: true, error: String(e?.message || e), at: Date.now() }; }
    finally { busy = false; }
  };
  setInterval(tick, 60000); setTimeout(tick, 15000);
  // The app's own list: what was sent since `since` (ms), newest last. Read-only.
  app.get('/api/setup-alerts', (req: any, res: any) => {
    const since = Number(req.query.since) || Date.now() - 6 * 3600000;
    const rows = D.db.prepare('SELECT * FROM setup_alerts WHERE at > ? ORDER BY at LIMIT 200').all(since);
    res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, alerts: rows, status: lastRun });
  });
  console.log('[setup-alerts] registered: NIFTY breaker blocks + Swap-Sweep, 5m/15m/30m/1h');
}
