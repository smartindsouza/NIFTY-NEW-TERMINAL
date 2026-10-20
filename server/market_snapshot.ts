// /api/market-snapshot — a READ-ONLY market picture for an external scheduled
// analysis (the ~09:32 IST "first 15 minutes vs overnight cues" brief).
//
// Hard rules for this file:
//   * Only quote, historical and instrument-list calls. Never orders, positions,
//     holdings, margins/funds or profile — nothing here can trade or reveal money.
//   * Never returns or logs the Kite access token, API key/secret or any session
//     data. Every error message is passed through clean() before it leaves.
//   * Each section fails on its own: its reason goes into "errors" and the rest of
//     the response is still returned. Only a missing/invalid session is a 503.
//   * Protected by SNAPSHOT_API_KEY (query ?key=), compared in constant time.
//   * Cached ~20s, and concurrent calls share one in-flight build, so repeated
//     calls cannot hammer Kite's rate limits.

import crypto from 'crypto';
import { getKiteClient, getGiftNiftyInstrument, getNfoInstruments } from './kite_service';

const IST_MS = 5.5 * 3600 * 1000;
const CACHE_MS = 20_000;

// Kite index tokens. Checked against the quote response on every build (the quote
// carries the instrument_token); a mismatch is reported in "errors" and the token
// from the quote is used instead.
const TOKENS = { nifty: 256265, banknifty: 260105, vix: 264969 };
const SYMBOLS = { nifty: 'NSE:NIFTY 50', banknifty: 'NSE:NIFTY BANK', vix: 'NSE:INDIA VIX' };

// ── time helpers (all output is IST ISO-8601, e.g. 2026-10-21T09:15:00+05:30) ──
const p2 = (n: number) => String(n).padStart(2, '0');
export function istIso(ms: number): string {
  const d = new Date(ms + IST_MS);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}+05:30`;
}
const istDay = (ms: number) => istIso(ms).slice(0, 10);
/** Epoch ms of an IST wall-clock time on an IST date (YYYY-MM-DD, HH:MM). */
function istAt(day: string, hhmm: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST_MS;
}
/** Kite historical takes IST 'YYYY-MM-DD HH:mm:ss'. */
const kiteTime = (ms: number) => istIso(ms).slice(0, 19).replace('T', ' ');
const candleMs = (c: any) => new Date(c?.date).getTime();
const r2 = (x: any) => (x === null || x === undefined || !Number.isFinite(+x) ? null : Math.round(+x * 100) / 100);

/** Strip anything secret from an error before it is returned or logged. */
function clean(e: any, kc?: any): string {
  let m = String(e?.message || e || 'unknown error');
  const secrets = [kc?.access_token, process.env.KITE_API_KEY, process.env.KITE_API_SECRET, process.env.SNAPSHOT_API_KEY]
    .filter((s) => typeof s === 'string' && s.length >= 6) as string[];
  for (const s of secrets) m = m.split(s).join('[redacted]');
  return m.replace(/access_token\S*/gi, '[redacted]').slice(0, 240);
}
const isSessionError = (e: any) =>
  e?.error_type === 'TokenException' || e?.status === 403 || /token|session|api_key/i.test(String(e?.message || ''));

export type SnapshotDeps = {
  kc: any;                                          // a Kite client (read-only calls only)
  getGift: () => Promise<{ token: number; symbol: string } | null>;
  getNfo: () => Promise<any[]>;
  nowMs: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Builds the snapshot. Returns an HTTP status and body; never throws. */
export async function buildMarketSnapshot(deps: SnapshotDeps): Promise<{ status: number; body: any }> {
  const { kc, nowMs } = deps;
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const errors: string[] = [];
  const today = istDay(nowMs);
  const asOf = istIso(nowMs);

  if (!kc || !kc.access_token) {
    return { status: 503, body: { as_of: asOf, session_valid: false, error: 'Kite session is not ready yet (no access token for today). The terminal logs in automatically early each morning — try again shortly.' } };
  }

  // 1) One quote call for the three indices. A session problem shows up here.
  let q: Record<string, any> = {};
  try {
    q = (await kc.getQuote([SYMBOLS.nifty, SYMBOLS.banknifty, SYMBOLS.vix])) || {};
  } catch (e: any) {
    if (isSessionError(e)) {
      return { status: 503, body: { as_of: asOf, session_valid: false, error: 'Kite session is not valid (Zerodha rejected the token). The terminal needs to log in again.' } };
    }
    errors.push(`quote(indices): ${clean(e, kc)}`);
  }
  const tok = { ...TOKENS };
  for (const k of ['nifty', 'banknifty', 'vix'] as const) {
    const got = Number(q[SYMBOLS[k]]?.instrument_token);
    if (got && got !== TOKENS[k]) { errors.push(`${k}: token ${TOKENS[k]} did not match Kite (${got}); used ${got}`); tok[k] = got; }
  }

  // 2) NIFTY and BANK NIFTY: previous trading day + today's completed 5-min candles.
  //    "Previous day" = the latest DAILY candle dated before today, so weekends and
  //    NSE holidays are skipped by the exchange's own data, not a calendar guess.
  const open0915 = istAt(today, '09:15');
  async function indexSection(name: 'nifty' | 'banknifty') {
    const out: any = { prev_day: null, today_5m: [], ltp: r2(q[SYMBOLS[name]]?.last_price) };
    try {
      const days = await kc.getHistoricalData(tok[name], 'day', kiteTime(nowMs - 20 * 86400000), kiteTime(nowMs));
      const prev = (days || []).filter((c: any) => istDay(candleMs(c)) < today).pop();
      if (prev) out.prev_day = { date: istDay(candleMs(prev)), open: r2(prev.open), high: r2(prev.high), low: r2(prev.low), close: r2(prev.close) };
      else errors.push(`${name}.prev_day: no daily candle before ${today}`);
    } catch (e: any) { errors.push(`${name}.prev_day: ${clean(e, kc)}`); }
    await sleep(350);                                   // historical limit is 3 req/s
    if (nowMs >= open0915 + 5 * 60000) {
      try {
        const c5 = await kc.getHistoricalData(tok[name], '5minute', kiteTime(open0915), kiteTime(nowMs));
        out.today_5m = (c5 || [])
          .filter((c: any) => { const t = candleMs(c); return t >= open0915 && istDay(t) === today && t + 5 * 60000 <= nowMs; })
          .map((c: any) => ({ t: istIso(candleMs(c)), o: r2(c.open), h: r2(c.high), l: r2(c.low), c: r2(c.close) }));
      } catch (e: any) { errors.push(`${name}.today_5m: ${clean(e, kc)}`); }
      await sleep(350);
    }
    if (out.ltp === null) errors.push(`${name}.ltp: not in quote`);
    return out;
  }
  const nifty = await indexSection('nifty');
  const banknifty = await indexSection('banknifty');

  // 3) INDIA VIX — the quote's ohlc.close is the previous session's close.
  const vq = q[SYMBOLS.vix];
  const india_vix = { ltp: r2(vq?.last_price), prev_close: r2(vq?.ohlc?.close) };
  if (india_vix.ltp === null) errors.push('india_vix: not in quote');

  // 4) GIFT NIFTY — the NSE IX front month the terminal already resolves.
  let gift_nifty: any = null;
  try {
    const gi = await deps.getGift();
    if (!gi) throw new Error('GIFT NIFTY instrument not resolvable (NSE IX segment may not be enabled on this account)');
    gift_nifty = { tradingsymbol: gi.symbol, ltp: null, prev_close: null, overnight_high: null, overnight_low: null, overnight_window: null, price_at_0915: null, price_at_0915_time: null };
    await sleep(1100);                                   // quote limit is 1 req/s
    try {
      const gq = (await kc.getQuote([`NSEIX:${gi.symbol}`]))?.[`NSEIX:${gi.symbol}`];
      gift_nifty.ltp = r2(gq?.last_price);
      gift_nifty.prev_close = r2(gq?.ohlc?.close);
      if (gift_nifty.ltp === null) errors.push('gift_nifty.ltp: not in quote');
    } catch (e: any) { errors.push(`gift_nifty.quote: ${clean(e, kc)}`); }
    // Overnight = from the prior NSE close (15:30 on the previous trading day) to
    // today's 09:15 open — or to now, if called before 09:15.
    const prevDay = nifty.prev_day?.date || banknifty.prev_day?.date;
    if (!prevDay) errors.push('gift_nifty.overnight: previous trading day unknown');
    else {
      const from = istAt(prevDay, '15:30');
      const to = Math.min(nowMs, open0915);
      gift_nifty.overnight_window = { from: istIso(from), to: istIso(to) };
      try {
        const m1 = ((await kc.getHistoricalData(gi.token, 'minute', kiteTime(from), kiteTime(to))) || [])
          .filter((c: any) => { const t = candleMs(c); return t >= from && t < to; });
        if (!m1.length) errors.push('gift_nifty.overnight: no GIFT NIFTY candles in the window');
        else {
          gift_nifty.overnight_high = r2(Math.max(...m1.map((c: any) => +c.high)));
          gift_nifty.overnight_low = r2(Math.min(...m1.map((c: any) => +c.low)));
          if (nowMs >= open0915) {
            const last = m1.filter((c: any) => candleMs(c) < open0915).pop();
            if (last) { gift_nifty.price_at_0915 = r2(last.close); gift_nifty.price_at_0915_time = istIso(candleMs(last) + 60000); }
            else errors.push('gift_nifty.price_at_0915: no trade before 09:15');
          }
        }
      } catch (e: any) { errors.push(`gift_nifty.overnight: ${clean(e, kc)}`); }
    }
  } catch (e: any) { errors.push(`gift_nifty: ${clean(e, kc)}`); }

  // 5) Options (optional): nearest NIFTY expiry — ATM CE/PE OI and total PCR.
  let options: any = null;
  try {
    const spot = nifty.ltp ?? nifty.today_5m[nifty.today_5m.length - 1]?.c ?? nifty.prev_day?.close;
    if (!spot) throw new Error('no NIFTY price to find the ATM strike');
    const nfo = await deps.getNfo();
    const toDay = (x: any) => (x instanceof Date ? istDay(x.getTime()) : String(x).slice(0, 10));
    const opts = (nfo || []).filter((i: any) => i.name === 'NIFTY' && (i.instrument_type === 'CE' || i.instrument_type === 'PE'));
    const expiries = [...new Set(opts.map((i: any) => toDay(i.expiry)))].filter((d) => d >= today).sort();
    if (!expiries.length) throw new Error('no NIFTY option expiry found');
    const expiry = expiries[0];
    const chain = opts.filter((i: any) => toDay(i.expiry) === expiry);
    const strikes = [...new Set(chain.map((i: any) => +i.strike))].sort((a, b) => a - b);
    const atm = strikes.reduce((b, s) => (Math.abs(s - spot) < Math.abs(b - spot) ? s : b), strikes[0]);
    const syms = chain.map((i: any) => `NFO:${i.tradingsymbol}`);
    const quotes: Record<string, any> = {};
    for (let i = 0; i < syms.length; i += 500) {
      await sleep(1100);
      Object.assign(quotes, await kc.getQuote(syms.slice(i, i + 500)));
    }
    let ceTotal = 0, peTotal = 0, atmCe: number | null = null, atmPe: number | null = null;
    for (const ins of chain) {
      const oi = Number(quotes[`NFO:${ins.tradingsymbol}`]?.oi) || 0;
      if (ins.instrument_type === 'CE') ceTotal += oi; else peTotal += oi;
      if (+ins.strike === atm) { if (ins.instrument_type === 'CE') atmCe = oi; else atmPe = oi; }
    }
    options = { expiry, atm_strike: atm, atm_ce_oi: atmCe, atm_pe_oi: atmPe, pcr_total: ceTotal > 0 ? Math.round((peTotal / ceTotal) * 1000) / 1000 : null, strikes_counted: strikes.length };
  } catch (e: any) { errors.push(`options: ${clean(e, kc)}`); }

  return {
    status: 200,
    body: { as_of: asOf, session_valid: true, nifty, banknifty, india_vix, gift_nifty, options, errors },
  };
}

/** Constant-time key check. A missing env var rejects every call. */
export function snapshotKeyOk(given: unknown, expected = process.env.SNAPSHOT_API_KEY): boolean {
  if (!expected || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

let cache: { at: number; status: number; body: any } | null = null;
let inFlight: Promise<{ status: number; body: any }> | null = null;

export function registerMarketSnapshot(app: any) {
  app.get('/api/market-snapshot', async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!snapshotKeyOk(req.query?.key)) return res.status(401).json({ error: 'unauthorized' });
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) {
      return res.status(cache.status).json({ ...cache.body, cache_age_s: Math.round((now - cache.at) / 1000) });
    }
    try {
      if (!inFlight) {
        inFlight = buildMarketSnapshot({ kc: getKiteClient(), getGift: getGiftNiftyInstrument, getNfo: getNfoInstruments, nowMs: now })
          .finally(() => { inFlight = null; });
      }
      const out = await inFlight;
      if (out.status === 200) cache = { at: Date.now(), status: out.status, body: out.body };
      res.status(out.status).json({ ...out.body, cache_age_s: 0 });
    } catch (e: any) {
      // buildMarketSnapshot does not throw; this is a last line of defence.
      console.error('[market-snapshot] failed:', clean(e));
      res.status(500).json({ as_of: istIso(Date.now()), error: 'snapshot failed' });
    }
  });
  console.log('[market-snapshot] registered (read-only)');
}
