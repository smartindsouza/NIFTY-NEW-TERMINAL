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

export function registerLatencyDiag(app: any, express: any) {
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
  app.get('/api/diag/freq-warnings', (_req: any, res: any) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, warnings: freqWarnings.slice(-100) }); });
  app.get('/api/diag/latency', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, note: 'ms; exchange timestamps are whole seconds, so read medians',
      server: { exchangeToServer: summary(srvLag), gapBetweenNiftyTicks: summary(gaps) },
      phoneReports: reports.slice(-200) });
  });
}
