// US30 (Dow Jones) chart data — 11 Nov 2026.
//
// SOURCE: Zerodha first. Kite lists "US30" under its global indices (Martin's
// Kite screenshot, 11 Nov), so the instrument is looked up in Kite's full dump
// by tradingsymbol and its candles fetched through the same historical API as
// every other chart. If Kite cannot serve it (not in the dump, or the
// historical API refuses that segment), the chart falls back to Yahoo's Dow
// futures (YM=F), which trade ~23 hours. `lastUs30Source` records which one
// fed the latest candles so the chart can say so.
//
// Candles come back in Kite's shape ({date, open, high, low, close, volume}) so
// the existing chart pipeline and every indicator work unchanged. Intraday
// candles are bucketed on a plain wall-clock grid — the NSE 09:15 grid the
// Kite path uses would collapse a 23-hour instrument's night into one candle.
// Reference only: it is never tradeable from the app.

export const US30_TOKEN = 'US30';
export const US30_SYMBOL = 'YM=F';
export const isUs30Token = (t: any) => String(t || '').toUpperCase() === US30_TOKEN;

type Kc = { date: Date; open: number; high: number; low: number; close: number; volume: number };

// Yahoo's limits: 1m → 7 days, 5m/15m → 60 days, 1h → 730 days.
function yahooPlan(timeframeMin: number): { interval: string; range: string; baseMin: number } {
  if (timeframeMin >= 1440) return { interval: '1d', range: '2y', baseMin: 1440 };
  if (timeframeMin >= 60 && timeframeMin % 60 === 0) return { interval: '60m', range: '730d', baseMin: 60 };
  if (timeframeMin >= 15 && timeframeMin % 15 === 0) return { interval: '15m', range: '60d', baseMin: 15 };
  if (timeframeMin >= 5 && timeframeMin % 5 === 0) return { interval: '5m', range: '60d', baseMin: 5 };
  return { interval: '1m', range: '7d', baseMin: 1 };
}

export function bucketWallClock(c: Kc[], minutes: number): Kc[] {
  if (minutes < 1) return c;
  const dur = minutes * 60000, out: Kc[] = [];
  let cur: Kc | null = null, curKey = -1;
  for (const k of c) {
    const key = Math.floor(k.date.getTime() / dur);
    if (!cur || key !== curKey) {
      if (cur) out.push(cur);
      cur = { date: new Date(key * dur), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume };
      curKey = key;
    } else {
      cur.high = Math.max(cur.high, k.high); cur.low = Math.min(cur.low, k.low);
      cur.close = k.close; cur.volume += k.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const cache = new Map<string, { at: number; data: Kc[] }>();
export let lastUs30Source: { source: 'kite' | 'yahoo' | null; detail: string; token?: number; exchange?: string } = { source: null, detail: '' };
let kiteUs30: { token: number; exchange: string; segment: string } | null | undefined;   // undefined = not looked up yet
let kiteUs30At = 0;

async function kiteCandles(timeframeMin: number, deps: { findAny: (p: (i: any) => boolean) => Promise<any>; kc: any }): Promise<Kc[] | null> {
  if (!deps.kc || !deps.kc.access_token) return null;
  if (kiteUs30 === undefined || Date.now() - kiteUs30At > 6 * 3600e3) {
    const i = await deps.findAny((x: any) => String(x.tradingsymbol || '').toUpperCase() === 'US30').catch(() => null);
    kiteUs30 = i ? { token: Number(i.instrument_token), exchange: String(i.exchange), segment: String(i.segment) } : null;
    kiteUs30At = Date.now();
  }
  if (!kiteUs30) { lastUs30Source = { source: null, detail: 'US30 not in Kite instrument dump' }; return null; }
  const interval = timeframeMin >= 1440 ? 'day' : timeframeMin >= 15 && timeframeMin % 15 === 0 ? '15minute' : timeframeMin >= 5 && timeframeMin % 5 === 0 ? '5minute' : 'minute';
  const days = interval === 'day' ? 400 : interval === 'minute' ? 20 : 60;
  const fmt = (ms: number) => { const d = new Date(ms + 5.5 * 3600e3); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`; };
  const raw: any[] = (await deps.kc.getHistoricalData(kiteUs30.token, interval, fmt(Date.now() - days * 86400e3), fmt(Date.now()))) || [];
  if (!raw.length) { lastUs30Source = { source: null, detail: `Kite returned no ${interval} candles for US30 (${kiteUs30.exchange})`, token: kiteUs30.token, exchange: kiteUs30.exchange }; return null; }
  let c: Kc[] = raw.map((k: any) => ({ date: new Date(k.date), open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +(k.volume || 0) }));
  const base = interval === 'day' ? 1440 : interval === '15minute' ? 15 : interval === '5minute' ? 5 : 1;
  if (timeframeMin < 1440 && timeframeMin !== base) c = bucketWallClock(c, timeframeMin);
  lastUs30Source = { source: 'kite', detail: `Zerodha ${kiteUs30.exchange} US30, ${interval}`, token: kiteUs30.token, exchange: kiteUs30.exchange };
  return c;
}

// Returns candles already at `timeframeMin` for intraday (so the caller's
// aggregation is a no-op) and daily candles for >= 1 day (the caller rolls
// those into weeks/months as it does for every other chart).
export async function fetchUs30Candles(timeframeMin: number, deps?: { findAny: (p: (i: any) => boolean) => Promise<any>; kc: any }): Promise<{ candles: Kc[]; baseMin: number }> {
  const baseMin = timeframeMin >= 1440 ? 1440 : timeframeMin;
  const kKey = `kite_${timeframeMin}`;
  const kHit = cache.get(kKey);
  if (kHit && Date.now() - kHit.at < 20000) return { candles: kHit.data, baseMin };
  if (deps) {
    try {
      const k = await kiteCandles(timeframeMin, deps);
      if (k && k.length) { cache.set(kKey, { at: Date.now(), data: k }); return { candles: k, baseMin }; }
    } catch (e: any) { lastUs30Source = { source: null, detail: `Kite US30 failed: ${e?.message || e}`, token: kiteUs30?.token, exchange: kiteUs30?.exchange }; }
  }
  const kiteWhy = lastUs30Source.detail;
  const plan = yahooPlan(timeframeMin);
  const key = `${plan.interval}_${timeframeMin}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20000) return { candles: hit.data, baseMin };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(US30_SYMBOL)}?interval=${plan.interval}&range=${plan.range}&includePrePost=true`;
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (terminal chart)' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const j: any = await r.json();
    const res = j?.chart?.result?.[0];
    const ts: number[] = res?.timestamp || [];
    const q = res?.indicators?.quote?.[0] || {};
    let c: Kc[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], cl = q.close?.[i];
      if ([o, h, l, cl].some(v => v == null || !isFinite(v))) continue;   // Yahoo pads gaps with nulls
      c.push({ date: new Date(ts[i] * 1000), open: +o, high: +h, low: +l, close: +cl, volume: +(q.volume?.[i] || 0) });
    }
    // Always re-grid intraday: Yahoo stamps its still-forming bar with the time of
    // the last trade (e.g. 09:11:21), which would sit off the chart's grid.
    if (timeframeMin < 1440) c = bucketWallClock(c, timeframeMin);
    cache.set(key, { at: Date.now(), data: c });
    lastUs30Source = { source: 'yahoo', detail: `Yahoo ${US30_SYMBOL} ${plan.interval} (Kite: ${kiteWhy || 'not tried'})` };
    return { candles: c, baseMin };
  } finally { clearTimeout(to); }
}
