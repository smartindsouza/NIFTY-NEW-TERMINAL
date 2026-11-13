// NIFTY HISTORY EXPORT (1 Nov 2026). Martin asked for his intraday "what comes
// before a sharp move" study to be re-run on ~2 years of data instead of the
// ~3 months the chart caches. This hands out NIFTY 50 index candles only (public
// market data, no account data), read through today's Zerodha session.
//   GET /api/research/nifty-history?interval=minute|5minute|15minute&days=1..1500
//       [&symbol=NIFTY|BANKNIFTY] [&end=YYYY-MM-DD]
// One fetch at a time, results kept for 6 hours, so repeated calls cost Zerodha
// nothing. Requests are spaced like the existing backtests (400 ms apart).
import { getKiteClient, getIndexFuturesTokens } from './kite_service';
// series=fut (11 Nov 2026, for Martin's VWAP options backtest): NIFTY FUTURES
// candles WITH VOLUME, from Kite's continuous series (rolled across expiries), so
// VWAP can be computed — the index itself has no volume.

const IST = 5.5 * 3600000;
const toIst = (ms: number) => new Date(ms + IST).toISOString().slice(0, 19).replace('T', ' ');
// 1minute added 6 Nov 2026 for the breaker scalping test; Kite serves at most 60
// days of 1-minute candles per request.
const CHUNK_DAYS: Record<string, number> = { 'minute': 60, '5minute': 90, '15minute': 180 };
const cache = new Map<string, { at: number; rows: number[][] }>();
let busy: Promise<any> | null = null;

// symbol + end (13 Nov 2026, for the breaker-block validity study). The conditions
// that separate breakers that hold from breakers that fail were found on NIFTY,
// Nov 2022 – Nov 2026, and a rule is only worth building into the indicator if it
// also holds on candles it was never fitted to. So the export can now hand out an
// OLDER window (`end=YYYY-MM-DD` moves the right edge back; `days` still counts
// back from there) and a SECOND index (`symbol=BANKNIFTY`). Still index candles
// only, still no account data. The tokens are Zerodha's fixed index tokens; an
// unknown symbol is refused rather than guessed, because a wrong token would
// quietly return some other instrument's candles.
const INDEX_TOKENS: Record<string, number> = { NIFTY: 256265, BANKNIFTY: 260105 };

async function fetchHistory(interval: string, days: number, fut = false, token = 256265, endMs = Date.now()): Promise<number[][]> {
  const kc: any = getKiteClient();
  if (!kc || !kc.access_token) throw new Error('Zerodha is not logged in today');
  const chunk = CHUNK_DAYS[interval];
  const rows: number[][] = [];
  let to = endMs; let left = days;
  const spans: [number, number][] = [];
  while (left > 0) { const s = Math.min(chunk, left); spans.unshift([to - s * 86400000, to]); to -= s * 86400000; left -= s; }
  // Kite serves the continuous (rolled) futures series for DAY candles only
  // ("invalid interval for continuous data" intraday), so intraday futures come
  // from the nearest live contracts one by one, each over its own listed life —
  // roughly the last 2–3 months. Older intraday futures volume is not available
  // from Zerodha.
  if (fut) {
    const fx = await getIndexFuturesTokens('NIFTY');
    if (!fx?.length) throw new Error('no NIFTY futures contract found');
    for (const c of fx.slice(0, 3)) {
      for (const [f, t] of spans) {
        try {
          const hist = await kc.getHistoricalData(c.token, interval, toIst(f), toIst(t));
          for (const k of hist || []) rows.push([new Date(k.date).getTime(), +k.open, +k.high, +k.low, +k.close, +(k.volume || 0), Date.parse(c.expiry)]);
        } catch { }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    rows.sort((a, b) => a[0] - b[0] || a[6] - b[6]);
    // keep the nearest expiry for each timestamp (the front month)
    return rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]).map(r => r.slice(0, 6));
  }
  for (const [f, t] of spans) {
    const hist = await kc.getHistoricalData(token, interval, toIst(f), toIst(t));
    for (const c of hist || []) rows.push(fut ? [new Date(c.date).getTime(), +c.open, +c.high, +c.low, +c.close, +(c.volume || 0)] : [new Date(c.date).getTime(), +c.open, +c.high, +c.low, +c.close]);
    await new Promise((r) => setTimeout(r, 400));
  }
  rows.sort((a, b) => a[0] - b[0]);
  return rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
}

export function registerResearchExport(app: any) {
  app.get('/api/research/nifty-history', async (req: any, res: any) => {
    const interval = String(req.query.interval || '5minute');
    if (!CHUNK_DAYS[interval]) return res.status(400).json({ ok: false, error: 'interval must be minute, 5minute or 15minute' });
    // Up to ~4 years (12 Nov 2026): the expired-option backtest now runs on Dhan
    // data back to Nov 2022, and the NIFTY candles it trades on must cover the
    // same span. Kite still serves it in the same 60/90/180-day chunks.
    const days = Math.max(1, Math.min(1500, parseInt(String(req.query.days || '730'), 10) || 730));
    const fut = String(req.query.series || '') === 'fut';
    const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
    const token = INDEX_TOKENS[symbol];
    if (!token) return res.status(400).json({ ok: false, error: `symbol must be one of ${Object.keys(INDEX_TOKENS).join(', ')}` });
    const endStr = String(req.query.end || '');
    let endMs = Date.now();
    if (endStr) {
      // 18:00 IST on that day, so the whole session of the end date is included.
      endMs = /^\d{4}-\d{2}-\d{2}$/.test(endStr) ? Date.parse(`${endStr}T18:00:00+05:30`) : NaN;
      if (!Number.isFinite(endMs) || endMs > Date.now() + 86400000) return res.status(400).json({ ok: false, error: 'end must be a past date, YYYY-MM-DD' });
    }
    if (fut && (symbol !== 'NIFTY' || endStr)) return res.status(400).json({ ok: false, error: 'series=fut is NIFTY only and has no end date' });
    const columns = fut ? ['t_ms', 'open', 'high', 'low', 'close', 'volume'] : ['t_ms', 'open', 'high', 'low', 'close'];
    const key = `${interval}:${days}:${fut ? 'fut' : 'idx'}:${symbol}`;
    // A window with an explicit end is a one-off research pull of up to ~370,000
    // rows; keeping several of those for six hours would hold a few hundred MB in
    // the same process that runs the tick feed and the exit engine. So they are
    // served and dropped. The plain "up to now" windows are cached as before.
    const hit = endStr ? undefined : cache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600000) return res.json({ ok: true, interval, days, series: fut ? 'fut' : 'index', symbol, cached: true, columns, rows: hit.rows });
    if (busy) return res.status(429).json({ ok: false, error: 'another history fetch is running — try again in a minute' });
    try {
      busy = fetchHistory(interval, days, fut, token, endMs);
      const rows = await busy;
      if (!endStr) cache.set(key, { at: Date.now(), rows });
      res.json({ ok: true, interval, days, series: fut ? 'fut' : 'index', symbol, end: endStr || null, cached: false, columns, rows });
    } catch (e: any) { res.status(503).json({ ok: false, error: e?.message || String(e) }); }
    finally { busy = null; }
  });
}
