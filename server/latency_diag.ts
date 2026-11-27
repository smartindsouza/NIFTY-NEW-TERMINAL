// PRICE-AGE MEASUREMENT (2 Nov 2026, Martin: "measure how old each price is when
// it reaches my phone"). Diagnostic only — it changes no price, chart or order.
//
// Three clocks are compared:
//   exchange time  — Zerodha's exchange_timestamp on the tick (whole seconds)
//   server time    — when this server received it, and when it sent it on
//   phone time     — when the phone received it, corrected to server time with a
//                    ping (so a phone clock that is off does not distort it)
// The server keeps its own numbers (exchange → server); the phone posts a
// summary every 30 s (server → phone, and exchange → phone). Read it back at
//   GET /api/diag/latency
// Exchange timestamps are whole seconds, so single readings are ±1 s; the
// medians over hundreds of ticks are what to read.

const MAX = 3000;
const srvLag: number[] = [];               // ms, exchange → server, NIFTY ticks
const gaps: number[] = [];                 // ms between NIFTY ticks at the server
let lastNiftyAt = 0;
const reports: any[] = [];
const freqWarnings: any[] = [];

export function noteServerTick(token: number, exTs: number | null, recvTs: number) {
  if (token !== 256265) return;
  if (exTs && exTs > 0) { srvLag.push(recvTs - exTs); if (srvLag.length > MAX) srvLag.shift(); }
  if (lastNiftyAt) { gaps.push(recvTs - lastNiftyAt); if (gaps.length > MAX) gaps.shift(); }
  lastNiftyAt = recvTs;
}

const pct = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};
const summary = (a: number[]) => ({ n: a.length, p50: pct(a, 0.5), p90: pct(a, 0.9), max: a.length ? Math.round(Math.max(...a)) : null });

// WHERE THE TIME TO ZERODHA GOES (27 Nov 2026). After the server was moved from
// San Francisco to Singapore one Zerodha call took LONGER (about 2.0 s for the
// funds, against 1.15 s before), which says the outbound proxy is not where a
// look-up of its address had placed it. This measures instead of guessing:
//   GET /api/diag/egress
// times a bare TCP connection (the handshake only: nothing is sent, no login,
// no API call) from this server to the proxy and, for comparison, straight to
// Zerodha's API host. A handshake takes one round trip, so each figure is the
// round-trip time of that leg. Only milliseconds are returned: not the proxy's
// address, and never its user name or password.
import net from 'node:net';
function tcpMs(host: string, port: number, timeoutMs = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let done = false;
    const fin = (v: number | null) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };
    const s = net.connect({ host, port, family: 4 });
    s.setTimeout(timeoutMs, () => fin(null));
    s.once('connect', () => fin(Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10));
    s.once('error', () => fin(null));
  });
}
async function leg(host: string, port: number) {
  const out: (number | null)[] = [];
  for (let i = 0; i < 5; i++) out.push(await tcpMs(host, port));
  const ok = out.filter((x): x is number => x != null).sort((a, b) => a - b);
  return { samples: out, best: ok.length ? ok[0] : null, median: ok.length ? ok[Math.floor(ok.length / 2)] : null };
}

export function registerLatencyDiag(app: any, express: any) {
  app.get('/api/diag/egress', async (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      let proxy: any = { configured: false };
      try {
        const u = new URL(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
        proxy = { configured: true, ...(await leg(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80))) };
      } catch (e) { /* no proxy set */ }
      const direct = await leg('api.kite.trade', 443);
      res.json({ ok: true, note: 'ms for one TCP handshake (one round trip) from this server; nothing is sent', region: process.env.RAILWAY_REPLICA_REGION || null, toProxy: proxy, toZerodhaDirect: direct });
    } catch (e: any) { res.json({ ok: false, error: e?.message || String(e) }); }
  });

  // ping for the phone's clock correction
  app.get('/api/diag/time', (_req: any, res: any) => { res.setHeader('Cache-Control', 'no-store'); res.json({ now: Date.now() }); });
  app.post('/api/diag/latency/client', express.json({ limit: '8kb' }), (req: any, res: any) => {
    const b = req.body || {};
    const num = (v: any) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
    reports.push({
      at: Date.now(), device: String(b.device || '').slice(0, 60), visible: !!b.visible, rttMs: num(b.rttMs),
      ticks: num(b.ticks), net: b.net ? { p50: num(b.net.p50), p90: num(b.net.p90), max: num(b.net.max) } : null,
      total: b.total ? { p50: num(b.total.p50), p90: num(b.total.p90), max: num(b.total.max) } : null,
      gap: b.gap ? { p50: num(b.gap.p50), p90: num(b.gap.p90), max: num(b.gap.max) } : null,
    });
    if (reports.length > 500) reports.shift();
    res.json({ ok: true });
  });
  // WHICH ENDPOINT THE APP'S "HIGH FREQUENCY API WARNING" NAMED, AND WHERE (18
  // Nov 2026). Martin: "High frequency api warnings still appear" — and nothing
  // recorded which one. The toast is raised in the phone's browser and was
  // gone six seconds later; finding it meant walking every screen and counting.
  // The app now tells the server each time it shows one: the endpoint, the
  // count, the page. Written to the log and kept here (the last 100), read back
  // at GET /api/diag/freq-warnings. Diagnostic only.
  app.post('/api/diag/freq-warning', express.json({ limit: '2kb' }), (req: any, res: any) => {
    const b = req.body || {};
    const row = {
      at: Date.now(), endpoint: String(b.endpoint || '').slice(0, 120), rate: Number(b.rate) || 0,
      page: String(b.page || '').slice(0, 80), screen: String(b.screen || '').slice(0, 40), version: String(b.version || '').slice(0, 12),
    };
    freqWarnings.push(row); if (freqWarnings.length > 100) freqWarnings.shift();
    console.warn(`[freq-warning] ${row.endpoint} x${row.rate} in 15s on ${row.page}${row.screen ? ` (${row.screen})` : ''} v${row.version}`);
    res.json({ ok: true });
  });
  // Which code put a trade into the phone's saved copy of open trades, or
  // emptied it (src/lib/positionCardLog.ts). Kept in memory and logged; read at
  // GET /api/diag/card-notes. Diagnostic only: nothing acts on it.
  const cardNotes: any[] = [];
  app.post('/api/diag/card-note', express.json({ limit: '2kb' }), (req: any, res: any) => {
    const b = req.body || {};
    const row = { at: Date.now(), what: String(b.what || '').slice(0, 10), symbol: String(b.symbol || '').slice(0, 40), id: String(b.id || '').slice(0, 40),
      entry: Number(b.entry) || 0, cardAgeS: Number(b.cardAgeS), cards: Number(b.cards) || 0, stack: String(b.stack || '').slice(0, 420), version: String(b.version || '').slice(0, 12) };
    cardNotes.push(row); if (cardNotes.length > 200) cardNotes.shift();
    console.warn(`[card-note] ${row.what} ${row.symbol} id=${row.id} entry=${row.entry} cardAge=${row.cardAgeS}s cards=${row.cards} v${row.version} :: ${row.stack}`);
    res.json({ ok: true });
  });
  app.get('/api/diag/card-notes', (_req: any, res: any) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, notes: cardNotes.slice(-200) }); });
  // What the indicator sharing on a device found wrong (src/lib/indicatorSync.ts:
  // a device new to it or with emptied storage, a whole set refused, the same
  // send repeating). Kept in memory and logged; GET /api/diag/sync-notes.
  const syncNotes: any[] = [];
  app.post('/api/diag/sync-note', express.json({ limit: '96kb' }), (req: any, res: any) => {
    const b = req.body || {};
    const row = { at: Date.now(), kind: String(b.kind || '').slice(0, 30), n: Number(b.n) || 0, keys: Array.isArray(b.keys) ? b.keys.slice(0, 60).map((k: any) => String(k).slice(0, 900)) : [],
      chars: Number(b.chars) || 0, entries: Number(b.entries) || 0, canWrite: !!b.canWrite, seenKept: !!b.seenKept, device: String(b.device || '').slice(0, 12), standalone: !!b.standalone };
    syncNotes.push(row); if (syncNotes.length > 200) syncNotes.shift();
    console.warn(`[sync-note] ${row.kind} n=${row.n} ${row.device}${row.standalone ? ' (home-screen app)' : ''} storage ${row.chars} chars in ${row.entries} entries, canWrite=${row.canWrite} seenKept=${row.seenKept} :: ${row.keys.join(',')}`);
    res.json({ ok: true });
  });
  app.get('/api/diag/sync-notes', (_req: any, res: any) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, notes: syncNotes.slice(-200) }); });
  app.get('/api/diag/freq-warnings', (_req: any, res: any) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, warnings: freqWarnings.slice(-100) }); });
  app.get('/api/diag/latency', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, note: 'ms; exchange timestamps are whole seconds, so read medians',
      server: { exchangeToServer: summary(srvLag), gapBetweenNiftyTicks: summary(gaps) },
      phoneReports: reports.slice(-200) });
  });
}
