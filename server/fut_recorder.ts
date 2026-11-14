// NIFTY FUTURES FEED RECORDER (14 Nov 2026, Martin). Records only. Never trades.
//
// WHY. Martin sent a footprint (order-flow) chart from Dhan's terminal — each
// candle split into price rows showing how much was sold into bids and bought
// from offers — and asked whether it could be built here and whether it is
// really helpful. Neither can be answered from history: Zerodha and Dhan sell
// candles, not ticks, so there is nothing to backtest a footprint reading on.
// The only way to get evidence is to start keeping the feed. Two questions, in
// this order:
//   1. After ONE day: is Zerodha's feed detailed enough for a footprint at all?
//      It sends one or two snapshots a second, not every trade. How much of the
//      day's volume can be pinned to a price and a side from those snapshots?
//   2. After about 20 trading days: do footprint-style readings (who was more
//      aggressive, at which price) say anything about the next move? One day
//      cannot answer that — every candle of one day shares that day's direction.
//
// WHAT IS KEPT, per update of the front-month NIFTY future (the contract the
// app already streams for its buy/sell "pressure" figure): time, last price,
// last trade's quantity, the day's volume so far, best bid and ask with their
// quantities, total buy and sell quantity, open interest. That is everything a
// footprint is built from. Prices are stored ×100 as whole numbers to keep a
// day near 2 MB; 45 days are kept, then the oldest go.
//
// A separate database file, so a month of ticks never bloats the file that
// holds the Zerodha login, the journal and the exit rules.
import Database from 'better-sqlite3';
import { getDeltaFuturesToken } from './delta_tracker';
import { currentTickerKind, setRawTickTap } from './ticker_service';
import { isTradingDay } from './calendar_service';

const IST = 19800000;
const istDay = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);
const istMin = (ms: number) => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const KEEP_DAYS = 45;
const COLS = ['ts', 'ex_ts', 'ltt', 'ltp', 'ltq', 'vol', 'bid', 'bid_q', 'ask', 'ask_q', 'tbq', 'tsq', 'oi'];

let fdb: any = null, buf: any[][] = [], day = '', dayOk = false, tokenToday = 0;
// Replaced only by the test (a fixed clock, a fixed contract).
const env = { now: () => Date.now(), token: () => getDeltaFuturesToken(), kind: () => currentTickerKind(), tradingDay: (d: string) => isTradingDay(d) };
const st = { rows: 0, flushed: 0, lastTickAt: 0, lastError: '' };
const p100 = (v: any) => { const n = Number(v); return n > 0 ? Math.round(n * 100) : null; };
const secs = (v: any) => { const ms = v instanceof Date ? v.getTime() : v ? new Date(v).getTime() : NaN; return Number.isFinite(ms) ? Math.round(ms / 1000) : null; };

/** Called for EVERY raw tick of every instrument, inside the feed loop that also
 *  drives the exits — so the first line throws away everything that is not the
 *  future, and nothing here touches the disk. Rows wait in memory for the timer. */
function tap(t: any) {
  const tok = env.token(); if (!tok || t.instrument_token !== tok) return;
  const now = env.now(), d = istDay(now);
  if (d !== day) { day = d; dayOk = env.tradingDay(d); tokenToday = 0; }
  if (!dayOk) return;
  const m = istMin(now); if (m < 555 || m >= 940) return;            // 09:15 – 15:40 IST
  if (env.kind() !== 'kite') return;                                 // Dhan's tick has a different shape
  if (tok !== tokenToday) { tokenToday = tok; try { fdb.prepare('INSERT OR REPLACE INTO fut_days (day, token) VALUES (?, ?)').run(d, tok); } catch { } }
  const b = t.depth?.buy?.[0], a = t.depth?.sell?.[0];
  buf.push([now, secs(t.exchange_timestamp), secs(t.last_trade_time), p100(t.last_price), Number(t.last_traded_quantity) || 0, Number(t.volume_traded) || 0,
    p100(b?.price), Number(b?.quantity) || 0, p100(a?.price), Number(a?.quantity) || 0, Number(t.total_buy_quantity) || 0, Number(t.total_sell_quantity) || 0, Number(t.oi) || 0]);
  st.rows++; st.lastTickAt = now;
  if (buf.length > 20000) buf = buf.slice(-20000);                   // disk stuck: keep memory bounded
}
function flush() {
  if (!fdb || !buf.length) return;
  const rows = buf; buf = [];
  try {
    const ins = fdb.prepare(`INSERT INTO fut_ticks (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
    fdb.transaction(() => { for (const r of rows) ins.run(...r); })();
    st.flushed += rows.length;
  } catch (e: any) { st.lastError = e?.message || String(e); }
}
const dayBounds = (d: string) => [Date.parse(`${d}T00:00:00+05:30`), Date.parse(`${d}T00:00:00+05:30`) + 86400000];

function openStore(file: string) {
  fdb = new Database(file);
  if (file !== ':memory:') fdb.pragma('journal_mode = WAL');
  fdb.exec(`CREATE TABLE IF NOT EXISTS fut_ticks (id INTEGER PRIMARY KEY, ts INTEGER, ex_ts INTEGER, ltt INTEGER, ltp INTEGER, ltq INTEGER, vol INTEGER,
    bid INTEGER, bid_q INTEGER, ask INTEGER, ask_q INTEGER, tbq INTEGER, tsq INTEGER, oi INTEGER);
    CREATE INDEX IF NOT EXISTS idx_fut_ticks_ts ON fut_ticks(ts);
    CREATE TABLE IF NOT EXISTS fut_days (day TEXT PRIMARY KEY, token INTEGER);`);
}
function dayRows(d: string) {
  flush(); const [a, b] = dayBounds(d);
  return { token: (fdb.prepare('SELECT token FROM fut_days WHERE day = ?').get(d) as any)?.token || null, rows: fdb.prepare(`SELECT ${COLS.join(',')} FROM fut_ticks WHERE ts >= ? AND ts < ? ORDER BY id`).raw().all(a, b) };
}

export function registerFutRecorder(app: any) {
  try { openStore(`${process.env.KITE_DATA_DIR || '.'}/fut_ticks.db`); }
  catch (e: any) { console.error('[fut-rec] disk store unavailable — not recording:', e?.message || e); fdb = null; return; }
  setRawTickTap(tap);
  setInterval(flush, 2000);
  const prune = () => { try { const r = fdb.prepare('DELETE FROM fut_ticks WHERE ts < ?').run(Date.now() - KEEP_DAYS * 86400000); if (r.changes) console.log(`[fut-rec] pruned ${r.changes} old rows`); } catch { } };
  setTimeout(prune, 60000); setInterval(prune, 12 * 3600000);

  app.get('/api/research/fut-ticks/days', (_req: any, res: any) => {
    try {
      const days: any[] = fdb.prepare('SELECT day, token FROM fut_days ORDER BY day DESC LIMIT 60').all();
      const out = days.map(d => { const [a, b] = dayBounds(d.day); const r: any = fdb.prepare('SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last, MAX(vol) vol FROM fut_ticks WHERE ts >= ? AND ts < ?').get(a, b); return { ...d, rows: r.n, first: r.first, last: r.last, dayVolume: r.vol }; });
      res.json({ ok: true, purpose: 'Records the NIFTY futures feed so a footprint can be judged on evidence. Records only.', recording: !!fdb, inMemory: buf.length, sinceStart: st, keepDays: KEEP_DAYS, days: out });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
  // One day's rows. Prices are ×100. About 2–3 MB of JSON for a full session.
  app.get('/api/research/fut-ticks', (req: any, res: any) => {
    const d = String(req.query.day || istDay()); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ ok: false, error: 'day=YYYY-MM-DD' });
    try { const r = dayRows(d); res.json({ ok: true, day: d, token: r.token, pricesTimes100: true, columns: COLS, rows: r.rows }); }
    catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
  console.log('[fut-rec] NIFTY futures feed recorder registered — records only, never trades');
}
export const __test = { tap, flush, dayRows, openStore, env, state: st, COLS };
