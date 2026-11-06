// NIFTY HISTORY EXPORT (1 Nov 2026). Martin asked for his intraday "what comes
// before a sharp move" study to be re-run on ~2 years of data instead of the
// ~3 months the chart caches. This hands out NIFTY 50 index candles only (public
// market data, no account data), read through today's Zerodha session.
//   GET /api/research/nifty-history?interval=minute|5minute|15minute&days=1..730
// One fetch at a time, results kept for 6 hours, so repeated calls cost Zerodha
// nothing. Requests are spaced like the existing backtests (400 ms apart).
import { getKiteClient } from './kite_service';

const IST = 5.5 * 3600000;
const toIst = (ms: number) => new Date(ms + IST).toISOString().slice(0, 19).replace('T', ' ');
// 1minute added 6 Nov 2026 for the breaker scalping test; Kite serves at most 60
// days of 1-minute candles per request.
const CHUNK_DAYS: Record<string, number> = { 'minute': 60, '5minute': 90, '15minute': 180 };
const cache = new Map<string, { at: number; rows: number[][] }>();
let busy: Promise<any> | null = null;

async function fetchHistory(interval: string, days: number): Promise<number[][]> {
  const kc: any = getKiteClient();
  if (!kc || !kc.access_token) throw new Error('Zerodha is not logged in today');
  const chunk = CHUNK_DAYS[interval];
  const rows: number[][] = [];
  let to = Date.now(); let left = days;
  const spans: [number, number][] = [];
  while (left > 0) { const s = Math.min(chunk, left); spans.unshift([to - s * 86400000, to]); to -= s * 86400000; left -= s; }
  for (const [f, t] of spans) {
    const hist = await kc.getHistoricalData(256265, interval, toIst(f), toIst(t));
    for (const c of hist || []) rows.push([new Date(c.date).getTime(), +c.open, +c.high, +c.low, +c.close]);
    await new Promise((r) => setTimeout(r, 400));
  }
  rows.sort((a, b) => a[0] - b[0]);
  return rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
}

export function registerResearchExport(app: any) {
  app.get('/api/research/nifty-history', async (req: any, res: any) => {
    const interval = String(req.query.interval || '5minute');
    if (!CHUNK_DAYS[interval]) return res.status(400).json({ ok: false, error: 'interval must be minute, 5minute or 15minute' });
    const days = Math.max(1, Math.min(730, parseInt(String(req.query.days || '730'), 10) || 730));
    const key = `${interval}:${days}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600000) return res.json({ ok: true, interval, days, cached: true, columns: ['t_ms', 'open', 'high', 'low', 'close'], rows: hit.rows });
    if (busy) return res.status(429).json({ ok: false, error: 'another history fetch is running — try again in a minute' });
    try {
      busy = fetchHistory(interval, days);
      const rows = await busy;
      cache.set(key, { at: Date.now(), rows });
      res.json({ ok: true, interval, days, cached: false, columns: ['t_ms', 'open', 'high', 'low', 'close'], rows });
    } catch (e: any) { res.status(503).json({ ok: false, error: e?.message || String(e) }); }
    finally { busy = null; }
  });
}
