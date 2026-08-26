import { getKiteClient, getIndexFuturesTokens } from "./kite_service.js";
import { aggregateCandles } from "./aggregator.js";
import { scoreBounceAt } from "./bounce_conviction.js";

function calculateRSI(closes: number[], period: number = 14) {
  if (closes.length <= period) return new Array(closes.length).fill(50);

  const rsiArray = new Array(closes.length).fill(50);
  let gain = 0, loss = 0;
  
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;

  if (loss === 0) rsiArray[period] = 100;
  else if (gain === 0) rsiArray[period] = 0;
  else rsiArray[period] = 100 - (100 / (1 + (gain / loss)));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const currentGain = d > 0 ? d : 0;
    const currentLoss = d < 0 ? -d : 0;

    gain = (gain * (period - 1) + currentGain) / period;
    loss = (loss * (period - 1) + currentLoss) / period;

    if (loss === 0) rsiArray[i] = 100;
    else if (gain === 0) rsiArray[i] = 0;
    else rsiArray[i] = 100 - (100 / (1 + (gain / loss)));
  }
  return rsiArray;
}

// Wilder's ADX with directional indicators. Returns full series so callers can
// read the latest value and detect whether ADX is rising. Mirrors the standard
// TradingView/Wilder calculation: TR + directional movement, Wilder-smoothed over
// `period`, DX = |+DI − −DI| / (+DI + −DI), ADX = Wilder-smoothed DX.
function calculateADX(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = highs.length;
  const adx = new Array(n).fill(0);
  const plusDI = new Array(n).fill(0);
  const minusDI = new Array(n).fill(0);
  if (n < period * 2) return { adx, plusDI, minusDI };

  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }

  // Wilder smoothing of TR / +DM / −DM (seed = sum of first `period` values).
  let trS = 0, pdmS = 0, mdmS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pdmS += plusDM[i]; mdmS += minusDM[i]; }

  const dx = new Array(n).fill(0);
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pdmS = pdmS - pdmS / period + plusDM[i];
    mdmS = mdmS - mdmS / period + minusDM[i];
    const pDI = trS === 0 ? 0 : (100 * pdmS) / trS;
    const mDI = trS === 0 ? 0 : (100 * mdmS) / trS;
    plusDI[i] = pDI;
    minusDI[i] = mDI;
    const sum = pDI + mDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / sum;
  }

  // ADX = Wilder-smoothed DX. First ADX value seeds at index (period*2) as the
  // simple average of the first `period` DX values, then Wilder-smooths.
  const firstAdxIdx = period * 2;
  if (firstAdxIdx < n) {
    let dxSum = 0;
    for (let i = period + 1; i <= firstAdxIdx; i++) dxSum += dx[i];
    adx[firstAdxIdx] = dxSum / period;
    for (let i = firstAdxIdx + 1; i < n; i++) {
      adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return { adx, plusDI, minusDI };
}

// Standard EMA. Seeds with the SMA of the first `period` values.
function calculateEMA(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  sma /= period;
  out[period - 1] = sma;
  for (let i = period; i < n; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// First-15-minutes opening range: high/low of 09:15–09:30 IST on the most recent trading
// day in the data. Works on any intraday base interval (candle START times 09:15/09:20/09:25
// for 5m, the single 09:15 bar for 15m, etc.). Returns null when there are no intraday bars
// in that window (e.g. daily/weekly timeframes), so the chart simply won't draw the lines.
// Demand/Supply zones: a "base" of small-bodied candles followed by an explosive
// leg away. The base before a strong up-leg is a DEMAND zone; before a strong
// down-leg, a SUPPLY zone. A zone is invalidated once a candle CLOSES through its
// far edge. Thresholds scale with ATR so the detector adapts to volatility.
export function computeDemandSupplyZones(
  candles: { open: number; high: number; low: number; close: number }[],
  opts?: { atrPeriod?: number; legBodyAtr?: number; baseBodyAtr?: number; maxBase?: number; maxZones?: number }
): { demand: { top: number; bottom: number; index: number }[]; supply: { top: number; bottom: number; index: number }[] } {
  const atrPeriod = opts?.atrPeriod ?? 14;
  const legBodyAtr = opts?.legBodyAtr ?? 1.2;   // leg-out body must exceed 1.2× ATR
  const baseBodyAtr = opts?.baseBodyAtr ?? 0.5; // base candles' bodies stay under 0.5× ATR
  const maxBase = opts?.maxBase ?? 4;           // base = 1..4 candles
  const maxZones = opts?.maxZones ?? 3;         // keep the freshest N per side
  const n = candles.length;
  const out = { demand: [] as any[], supply: [] as any[] };
  if (n < atrPeriod + maxBase + 2) return out;

  // Wilder-style ATR
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let atr = trs.slice(0, atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
  const atrAt: number[] = new Array(n).fill(atr);
  for (let i = atrPeriod; i < trs.length; i++) {
    atr = (atr * (atrPeriod - 1) + trs[i]) / atrPeriod;
    atrAt[i + 1] = atr;
  }

  for (let i = atrPeriod + 1; i < n; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const a = atrAt[i] || 0;
    if (a <= 0 || body < legBodyAtr * a) continue;
    const bullish = c.close > c.open;
    // gather the base: consecutive small-bodied candles immediately before the leg
    let bStart = i - 1, count = 0;
    while (bStart >= 0 && count < maxBase && Math.abs(candles[bStart].close - candles[bStart].open) <= baseBodyAtr * a) {
      bStart--; count++;
    }
    if (count < 1) continue;
    const base = candles.slice(bStart + 1, i);
    const top = Math.max(...base.map(b => Math.max(b.open, b.close, b.high)));
    const bottom = Math.min(...base.map(b => Math.min(b.open, b.close, b.low)));
    if (!(top > bottom)) continue;
    if (bullish) out.demand.push({ top, bottom, index: i });
    else out.supply.push({ top, bottom, index: i });
  }

  // Invalidate zones price has closed through (far edge), keep freshest per side
  const lastValid = (zs: any[], side: 'demand' | 'supply') => {
    const alive = zs.filter(z => {
      for (let j = z.index; j < n; j++) {
        const cl = candles[j].close;
        if (side === 'demand' && cl < z.bottom) return false;
        if (side === 'supply' && cl > z.top) return false;
      }
      return true;
    });
    // de-duplicate heavily overlapping zones (keep the most recent)
    const dedup: any[] = [];
    for (const z of alive.sort((x, y) => y.index - x.index)) {
      if (!dedup.some(d => Math.min(d.top, z.top) - Math.max(d.bottom, z.bottom) > 0.5 * (z.top - z.bottom))) dedup.push(z);
      if (dedup.length >= maxZones) break;
    }
    return dedup;
  };
  out.demand = lastValid(out.demand, 'demand');
  out.supply = lastValid(out.supply, 'supply');
  return out;
}

function computeOpeningRange(raw: any[]): { high: number; low: number; date: string } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const toIst = (d: any) => new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000);
  let maxDay = "";
  for (const c of raw) { const day = toIst(c.date).toISOString().slice(0, 10); if (day > maxDay) maxDay = day; }
  let hi = -Infinity, lo = Infinity, cnt = 0;
  for (const c of raw) {
    const ist = toIst(c.date);
    if (ist.toISOString().slice(0, 10) !== maxDay) continue;
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (mins >= 9 * 60 + 15 && mins < 9 * 60 + 30) {
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
      cnt++;
    }
  }
  if (cnt === 0 || hi === -Infinity) return null;
  return { high: hi, low: lo, date: maxDay };
}

const cacheMap = new Map<string, { data: any, lastUpdate: number, lastFullFetch?: number }>();

// ---------------------------------------------------------------- volume caches
// An index has no volume of its own, so the chart borrows it from the futures. The
// original code downloaded the FULL history of EVERY listed expiry on every cold
// request just to discover which contract was most active — three ~7,500-candle
// pulls for a 5-minute chart, sequential, each behind a 350ms throttle, and the
// whole thing repeated once the 60s TA cache expired. That was the bulk of the
// 5-8 second first load Martin reported.
//
// Two things are cached instead:
//   activeExpiryCache — WHICH contract is most active. It changes once a month at
//     rollover, so it is resolved once a day. Confirmed by re-scanning if the
//     remembered contract ever returns nothing.
//   futVolCache — the volume series itself. Volume on a candle that has already
//     closed never changes; only the newest candle moves. Refreshed on the same
//     cadence as a candle, so a 5-minute chart re-pulls at most once per 5 minutes
//     instead of once per minute.
const activeExpiryCache = new Map<string, { token: number; expiry: string; day: string }>();
const futVolCache = new Map<string, { at: number; map: Map<number, number>; expiry: string }>();
const istDay = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const inFlightRequests = new Map<string, Promise<any>>();

let nextAvailableTime = Date.now();
const REQUEST_INTERVAL_MS = 350; // Max 3 requests per second

export const kiteDiagnostics = {
  requestCountPerMinute: 0,
  lastRequestTime: 0,
  cacheHits: 0,
  cacheMisses: 0,
  error429Count: 0,
  endpoints: new Map<string, number>()
};

// Reset count every minute
setInterval(() => {
  kiteDiagnostics.requestCountPerMinute = 0;
}, 60000);

async function throttleRequest<T>(fn: () => Promise<T>, endpointName: string = "unknown"): Promise<T> {
  const now = Date.now();
  kiteDiagnostics.requestCountPerMinute++;
  kiteDiagnostics.lastRequestTime = now;
  kiteDiagnostics.endpoints.set(endpointName, (kiteDiagnostics.endpoints.get(endpointName) || 0) + 1);

  let delay = 0;
  if (now < nextAvailableTime) {
    delay = nextAvailableTime - now;
  }
  
  // Advance the next available time
  nextAvailableTime = now + delay + REQUEST_INTERVAL_MS;
  
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  try {
    return await fn();
  } catch (error: any) {
    if (error?.status === 429 || error?.message?.includes("429")) {
      kiteDiagnostics.error429Count++;
    }
    throw error;
  }
}


/**
 * Candle-freshness diagnostic. Answers ONE question in a single tap: are the newest
 * candles missing because Kite is not giving them to us, or because our own cache is
 * serving an old copy? It reports both sides for the same timeframe:
 *   servedTail  — the last candles the chart would receive right now (from cache if warm)
 *   kiteTail    — the last candles a FRESH, cache-bypassing call to Kite returns
 * If kiteTail is current and servedTail is behind, the fault is ours. If both are behind,
 * Kite (or the proxy carrying the request) is not returning the recent candles.
 */
export async function taFreshness(timeframeMin: number, instrument_token: string) {
  const istStr = (ms: number) => new Date(ms + 5.5 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
  const tail = (arr: any[], n = 3) => (arr || []).slice(-n).map((c: any) => {
    const t = new Date(c.time ? (typeof c.time === 'number' ? c.time * 1000 : c.time) : c.date).getTime();
    return { at: istStr(t), ageMin: +(((Date.now() - t) / 60000)).toFixed(1), close: c.close, volume: c.volume ?? null };
  });

  const cacheKey = `${instrument_token}_${timeframeMin}`;
  const cached = cacheMap.get(cacheKey);
  const out: any = {
    serverNow: istStr(Date.now()),
    timeframeMin, instrument_token,
    cache: cached
      ? {
          present: true,
          ageSec: Math.round((Date.now() - cached.lastUpdate) / 1000),
          fullFetchAgeSec: Math.round((Date.now() - (cached.lastFullFetch ?? cached.lastUpdate)) / 1000),
          candles: cached.data?.candles?.length ?? 0,
          servedTail: tail(cached.data?.candles || []),
        }
      : { present: false },
  };

  try {
    const kc = getKiteClient();
    // @ts-ignore — same session check the rest of the module uses
    if (!kc || !kc.access_token) throw new Error('no Kite session (log in to Zerodha)');
    const interval = timeframeMin === 1 ? 'minute'
      : timeframeMin === 3 ? '3minute'
      : timeframeMin === 5 ? '5minute'
      : timeframeMin === 10 ? '10minute'
      : timeframeMin >= 1440 ? 'day' : '15minute';
    const istString = (d: Date) => {
      const x = new Date(d.getTime() + 5.5 * 3600000);
      return x.toISOString().slice(0, 10) + ' ' + x.toISOString().slice(11, 19);
    };
    const t0 = Date.now();
    // Deliberately a SMALL window (2 days): this must not be slowed by the 100-day
    // pull the chart uses, or the timing below tells us nothing about freshness.
    const raw = await kc.getHistoricalData(
      parseInt(instrument_token, 10), interval as any,
      istString(new Date(Date.now() - 2 * 86400000)), istString(new Date()),
    );
    out.kite = {
      ok: true, interval, tookMs: Date.now() - t0,
      candles: raw?.length ?? 0,
      kiteTail: tail(raw || []),
    };
    const newest = (raw || []).length ? new Date(raw[raw.length - 1].date).getTime() : 0;
    out.verdict = !newest ? 'Kite returned no candles at all'
      : (Date.now() - newest) / 60000 > timeframeMin + 3
        ? 'KITE IS BEHIND — the newest candle it will give us is older than one timeframe'
        : cached && (cached.data?.candles?.length ?? 0) > 0 &&
          new Date(cached.data.candles[cached.data.candles.length - 1].time * 1000).getTime() < newest - timeframeMin * 60000
          ? 'OUR CACHE IS BEHIND — Kite has newer candles than we are serving'
          : 'both current';
  } catch (e: any) {
    out.kite = { ok: false, error: e?.message || String(e) };
    out.verdict = 'could not reach Kite for a fresh comparison — see kite.error';
  }
  return out;
}

export async function getTechnicalAnalysis(
  spot: number,
  timeframeMin: number = 5,
  instrument_token: string = "256265",
  symbol: string = "NIFTY 50"
) {
  const now = Date.now();
  const cacheKey = `${instrument_token}_${timeframeMin}`;

  try {
    const kc = getKiteClient();
    if (kc && (kc as any).access_token) {
      let resolvedSpot = spot;
      try {
        const cleanSymbol = symbol.replace("NSE:", "").replace("NFO:", "").replace("BSE:", "").trim();
        let formatSymbol = `NSE:${cleanSymbol}`;
        if (symbol.startsWith("NFO:")) {
          formatSymbol = symbol;
        }
        const ltpRes = await throttleRequest(() => kc.getLTP([formatSymbol]), `ltp_${formatSymbol}`);
        if (ltpRes && ltpRes[formatSymbol]) {
          resolvedSpot = ltpRes[formatSymbol].last_price;
        }
      } catch (ltpErr: any) {
        // ignore, fallback to passed spot
      }

      let cachedItem = cacheMap.get(cacheKey);
      if (cachedItem && !cachedItem.data.isMock && cachedItem.data.candles && cachedItem.data.candles.length > 0) {
        const lastCandle = cachedItem.data.candles[cachedItem.data.candles.length - 1];
        const lastCandleTime = new Date(lastCandle.time || lastCandle.date).getTime();
        const roundedNow = Math.floor(now / (timeframeMin * 60000)) * (timeframeMin * 60000);
        const roundedLast = Math.floor(lastCandleTime / (timeframeMin * 60000)) * (timeframeMin * 60000);
        if (roundedNow > roundedLast) {
          cacheMap.delete(cacheKey);
          cachedItem = undefined;
        }
      }
      
      // Serve cache only if the last FULL fetch (which re-pulls futures volume)
      // was within 60s. We intentionally check lastFullFetch, not lastUpdate:
      // the price-touch branch below bumps lastUpdate every hit, which would
      // otherwise keep the cache alive forever and freeze volume for the whole
      // candle. Falling back to lastUpdate keeps older cache entries valid.
      if (
        cachedItem &&
        !cachedItem.data.isMock &&
        now - (cachedItem.lastFullFetch ?? cachedItem.lastUpdate) <= 60000 &&
        (instrument_token !== "256265" || Math.abs(cachedItem.data.baseSpot - resolvedSpot) <= 500)
      ) {
         if (
           cachedItem.data.candles &&
           cachedItem.data.candles.length > 0 &&
           now - cachedItem.lastUpdate > 2000
         ) {
            const lastCandle = cachedItem.data.candles[cachedItem.data.candles.length - 1];
            const tol = Math.max(50, resolvedSpot * 0.05);
            if (Math.abs(lastCandle.close - resolvedSpot) < tol) {
              lastCandle.close = resolvedSpot;
              lastCandle.high = Math.max(lastCandle.high, resolvedSpot);
              lastCandle.low = Math.min(lastCandle.low, resolvedSpot);
            }
            cachedItem.data.spot = resolvedSpot;
            cachedItem.lastUpdate = now;
         }
         kiteDiagnostics.cacheHits++;
         return cachedItem.data;
      }
      kiteDiagnostics.cacheMisses++;

      // Check if we are already fetching this exact data
      if (inFlightRequests.has(cacheKey)) {
        kiteDiagnostics.cacheHits++;
        return await inFlightRequests.get(cacheKey);
      }

      const fetchPromise = (async () => {
        // Format a Date as an IST string for Kite API ("YYYY-MM-DD HH:MM:SS").
        // The Kite SDK formats dates using the server's LOCAL timezone, but Kite
        // expects IST (UTC+5:30). Running on a non-IST machine (e.g. Dubai UTC+4)
        // causes toDate to appear ~1.5 h earlier than it should, making Kite return
        // no today's candles (because toDate falls before market open at 09:15 IST).
        const toISTString = (d: Date): string => {
          const istMs = d.getTime() + (5.5 * 60 * 60 * 1000); // shift to IST
          const ist = new Date(istMs);
          const pad = (n: number) => String(n).padStart(2, '0');
          return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ` +
                 `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
        };

        const toDate = toISTString(new Date());
        let fromDate: any = new Date();
        
        let intervalName = "minute";
        let daysToFetch = 15;
        let baseIntervalMin = 1;

        if (timeframeMin === 1) {
            intervalName = "minute";
            daysToFetch = 40; // Kite limit for 1min is 60d
            baseIntervalMin = 1;
        } else if (timeframeMin === 3) {
            intervalName = "3minute";
            daysToFetch = 60;
            baseIntervalMin = 3;
        } else if (timeframeMin === 5) {
            intervalName = "5minute";
            daysToFetch = 100; // More history = exact RSI
            baseIntervalMin = 5;
        } else if (timeframeMin === 10) {
            intervalName = "10minute";
            daysToFetch = 100;
            baseIntervalMin = 10;
        } else if (timeframeMin >= 15 && timeframeMin < 1440) {
            intervalName = "15minute";
            daysToFetch = 150; // Get more days to build larger timeframes like 4h
            baseIntervalMin = 15;
        } else if (timeframeMin >= 1440) {
            intervalName = "day";
            daysToFetch = 400; 
            baseIntervalMin = 1440;
        }

        fromDate = toISTString(new Date(Date.now() - daysToFetch * 24 * 60 * 60 * 1000));

        // We use the provided instrument_token
        const rawHist = await throttleRequest(() => kc.getHistoricalData(
          parseInt(instrument_token, 10),
          intervalName as any,
          fromDate,  // IST-formatted string — Kite always receives correct time
          toDate,    // IST-formatted string — Kite always receives correct time
        ), `historical_${intervalName}`);
        
        console.log(`[Kite API Request] Symbol: ${symbol}, Token: ${instrument_token}, Timeframe: ${timeframeMin}m, Candles: ${rawHist?.length || 0}`);

        // The NIFTY spot index (256265) has no traded volume. Borrow it from the MOST-ACTIVE
        // NIFTY futures contract. We pull the two nearest expiries and pick whichever carried
        // more total volume over the window — this auto-handles the expiry roll (near expiry,
        // volume migrates to next month), which is what TradingView's continuous future shows.
        // WHICH index are we drawing? An index has no traded volume of its own, so
        // the bars come from its futures. This used to be hardcoded to NIFTY's spot
        // token, which is exactly why a SENSEX chart showed Vol 0 — it never even
        // tried. NIFTY behaviour is unchanged; SENSEX and BANKEX now borrow from
        // their own BSE futures.
        // OPTION CONTRACTS MUST NEVER BORROW. They have real traded volume of their
        // own, and their tradingsymbols contain the underlying's name
        // (BANKNIFTY25AUG52000CE, SENSEX2672376000CE), so a name-based test alone
        // would overwrite genuine option volume with futures volume. Matching the
        // CE/PE suffix is what separates a contract from an index.
        const isOptionContract = /(CE|PE)$/i.test(String(symbol || '').trim());
        // NIFTY BANK is checked BEFORE the plain NIFTY test — "NIFTY BANK" contains
        // "NIFTY", so the looser rule would otherwise claim it and borrow the wrong
        // contract's volume.
        const volumeUnderlying = isOptionContract ? null
          : /SENSEX/i.test(symbol) ? 'SENSEX'
          : /BANKEX/i.test(symbol) ? 'BANKEX'
          : (/NIFTY\s*BANK/i.test(symbol) || /BANKNIFTY/i.test(symbol) || String(instrument_token) === '260105') ? 'BANKNIFTY'
          : String(instrument_token) === '256265' ? 'NIFTY'
          : null;
        if (volumeUnderlying && rawHist && rawHist.length > 0) {
          try {
            const volKey = `${volumeUnderlying}_${intervalName}`;
            let bestVolByTime: Map<number, number> | null = null;
            let bestExpiry = '';

            // 1) Serve the cached volume series while it is still current. One
            //    candle's worth of staleness at most, and only on the newest bar.
            const vCached = futVolCache.get(volKey);
            const volTtl = Math.max(60000, baseIntervalMin * 60000);
            if (vCached && Date.now() - vCached.at < volTtl) {
              bestVolByTime = vCached.map;
              bestExpiry = vCached.expiry + ' (cached)';
            } else {
              const futs = await getIndexFuturesTokens(volumeUnderlying);
              if (!futs.length) console.warn(`[Volume Merge] no listed futures found for ${volumeUnderlying} — chart will show no volume`);

              // 2) Fetch ONLY the contract already known to be most active. The
              //    full scan runs just once a day, or if that contract comes back
              //    empty (rollover, or a bad remembered token).
              const remembered = activeExpiryCache.get(volumeUnderlying);
              const useRemembered = remembered && remembered.day === istDay()
                && futs.some(f => f.token === remembered.token);
              const pullOne = async (fut: { token: number; expiry: string }) => {
                const h = await throttleRequest(() => kc.getHistoricalData(
                  fut.token, intervalName as any, fromDate, toDate,
                ), `historical_fut_${intervalName}`);
                if (!h || h.length === 0) return null;
                const m = new Map<number, number>();
                let total = 0;
                for (const f of h) { const t = new Date(f.date).getTime(); const v = f.volume || 0; m.set(t, v); total += v; }
                return { m, total, expiry: fut.expiry, token: fut.token };
              };

              let picked: any = null;
              if (useRemembered) {
                picked = await pullOne(futs.find(f => f.token === remembered!.token)!);
                if (!picked || picked.total <= 0) picked = null;   // stale — fall through to a full scan
              }
              if (!picked) {
                let best: any = null;
                for (const fut of futs) {
                  const r = await pullOne(fut);
                  if (r && (!best || r.total > best.total)) best = r;
                }
                picked = best;
                if (picked) activeExpiryCache.set(volumeUnderlying, { token: picked.token, expiry: picked.expiry, day: istDay() });
              }
              if (picked) {
                bestVolByTime = picked.m;
                bestExpiry = picked.expiry;
                futVolCache.set(volKey, { at: Date.now(), map: picked.m, expiry: picked.expiry });
              }
            }
            if (bestVolByTime) {
              let matched = 0;
              for (const r of rawHist) {
                const t = new Date(r.date).getTime();
                if (bestVolByTime.has(t)) { r.volume = bestVolByTime.get(t); matched++; }
              }
              console.log(`[Volume Merge] ${volumeUnderlying} futures volume (most-active expiry ${bestExpiry}) mapped onto ${matched}/${rawHist.length} candles`);
            }
          } catch (e) {
            console.error('[Volume Merge] failed, continuing without volume:', e);
          }
        }

        if (rawHist && rawHist.length > 0) {
          const hist = aggregateCandles(rawHist, timeframeMin, baseIntervalMin);
          
          const actualSpot = resolvedSpot;
          const tolerance = Math.max(50, actualSpot * 0.05);
          
          if (
            hist.length > 0 &&
            Math.abs(hist[hist.length - 1].close - actualSpot) < tolerance
          ) {
            hist[hist.length - 1].close = actualSpot;
            hist[hist.length - 1].high = Math.max(hist[hist.length - 1].high, actualSpot);
            hist[hist.length - 1].low = Math.min(hist[hist.length - 1].low, actualSpot);
          }

          const closes = hist.map((h: any) => h.close);
          const rsiValues = calculateRSI(closes, 14);

          // Real Wilder ADX/DI and EMA20 from the (timeframe-aggregated) candles.
          const highs = hist.map((h: any) => h.high);
          const lows = hist.map((h: any) => h.low);
          const adxRes = calculateADX(highs, lows, closes, 14);
          const lastIdx = closes.length - 1;
          const adxNow = Math.round((adxRes.adx[lastIdx] || 0) * 10) / 10;
          const adxPrev = adxRes.adx[lastIdx - 1] || 0;
          const plusDiNow = Math.round((adxRes.plusDI[lastIdx] || 0) * 10) / 10;
          const minusDiNow = Math.round((adxRes.minusDI[lastIdx] || 0) * 10) / 10;
          const adxRising = adxNow > adxPrev;
          let realAdxTrend = "Balanced";
          if (adxNow >= 25) realAdxTrend = plusDiNow >= minusDiNow ? "Bulls dominant" : "Bears dominant";
          else if (adxNow < 20) realAdxTrend = "No trend";
          else realAdxTrend = "Building";

          const emaArr = calculateEMA(closes, 20);
          const ema20Val = emaArr[lastIdx];
          const realEma20 = Number.isFinite(ema20Val) ? Math.round(ema20Val * 100) / 100 : actualSpot;

          // Real session VWAP, resetting each IST trading day. Typical price x volume.
          // Falls back to close when a session has no merged volume (avoids divide-by-zero).
          let cumPV = 0, cumV = 0, curDay = "";
          let lastVwap = actualSpot;
          for (const h of hist) {
            const istDay = new Date(new Date(h.date).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
            if (istDay !== curDay) { curDay = istDay; cumPV = 0; cumV = 0; }
            const tp = (h.high + h.low + h.close) / 3;
            const v = h.volume || 0;
            cumPV += tp * v;
            cumV += v;
            lastVwap = cumV > 0 ? cumPV / cumV : h.close;
          }
          const realVwap = Math.round(lastVwap * 100) / 100;

          // Bounce Conviction (technical core) — reuses the exact series we just built.
          const volSeries = hist.map((h: any) => h.volume || 0);
          // Pace-adjust the forming (last) candle's volume so the score's volume
          // component isn't understated mid-candle: project the partial volume to a
          // full-bar equivalent by the fraction of the bar that has elapsed. Only
          // intraday, and only while the last bar is genuinely still forming
          // (2%–98% elapsed) — completed bars and out-of-session data are left as-is.
          const volForScore = volSeries.slice();
          if (timeframeMin < 1440 && hist.length > 0) {
            const lastStartMs = new Date(hist[lastIdx].date).getTime();
            const fracElapsed = (Date.now() - lastStartMs) / (timeframeMin * 60000);
            if (fracElapsed > 0.02 && fracElapsed < 0.98) {
              volForScore[lastIdx] = volSeries[lastIdx] / Math.max(fracElapsed, 0.15);
            }
          }
          const bounce = scoreBounceAt({
            high: highs, low: lows, close: closes, volume: volForScore,
            rsi: rsiValues, adx: adxRes.adx, plusDI: adxRes.plusDI, minusDI: adxRes.minusDI,
          }, lastIdx);

          const openingRange = computeOpeningRange(rawHist);

          // Demand/Supply zones — intraday only (that's their use case here); on
          // the last ~200 candles to keep zones recent and computation light.
          const dsZones = timeframeMin < 1440
            ? computeDemandSupplyZones(hist.slice(-200).map((h: any) => ({ open: h.open, high: h.high, low: h.low, close: h.close })))
            : { demand: [], supply: [] };

          const rsiMap = hist
            .map((h: any, i: number) => ({ ...h, rsi14: rsiValues[i] }));

          const candles = rsiMap.map((h: any) => ({
            open: h.open,
            high: h.high,
            low: h.low,
            close: h.close,
            volume: h.volume || 0,
            rsi14: h.rsi14 === 0 ? 50 : h.rsi14,
            time: h.date instanceof Date ? h.date.toISOString() : new Date(h.date).toISOString(),
          }));

          const latestRsi = candles[candles.length - 1]?.rsi14 || 50;
          let rsiZoneShift = null;
          if (latestRsi > 60) rsiZoneShift = "BULLISH ZONE";
          else if (latestRsi < 40) rsiZoneShift = "BEARISH ZONE";

          const volumes = rawHist.map((r: any) => r.volume || 0);
          let maxVol = 0, minVol = 0, avgVol = 0;
          if (volumes.length > 0) {
            maxVol = Math.max(...volumes);
            minVol = Math.min(...volumes);
            avgVol = Math.round(volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length);
          }

          const resultData = {
            isMock: false,
            rsi: latestRsi,
            rsiZoneShift,
            adx: adxNow,
            adxTrend: realAdxTrend,
            plusDi: plusDiNow,
            minusDi: minusDiNow,
            adxRising,
            currentPattern: "REAL DATA",
            timeframe: timeframeMin,
            instrument_token,
            spot: actualSpot,
            baseSpot:
              Math.abs(cachedItem?.data?.baseSpot - actualSpot) < (actualSpot * 0.05)
                ? cachedItem?.data?.baseSpot
                : actualSpot,
            vwap: realVwap,
            ema20: realEma20,
            bounce,
            openingRange,
            dsZones,
            candles,
            rawTop5: rawHist.slice(0, 5),
            rawVolumeStats: { max: maxVol, min: minVol, avg: avgVol },
          };
          
          cacheMap.set(cacheKey, { data: resultData, lastUpdate: Date.now(), lastFullFetch: Date.now() });
          return resultData;
        }
        throw new Error("Empty history format");
      })();
      
      inFlightRequests.set(cacheKey, fetchPromise);
      try {
        const res = await fetchPromise;
        inFlightRequests.delete(cacheKey);
        return res;
      } catch (err) {
        inFlightRequests.delete(cacheKey);
        throw err;
      }
    }
  } catch (e: any) {
    console.error(`[NIFTY DIAGNOSTIC] Error fetching historical TA for ${instrument_token} / ${timeframeMin}m:`, e.message || e);
  }

  // Fallback to MOCK data
  const mockCacheItem = cacheMap.get(cacheKey);
  if (
    mockCacheItem &&
    mockCacheItem.data.isMock &&
    Math.abs(mockCacheItem.data.baseSpot - spot) < 500
  ) {
    if (now - mockCacheItem.lastUpdate > 2000) {
      const lastCandle = mockCacheItem.data.candles[mockCacheItem.data.candles.length - 1];
      lastCandle.close = spot;
      lastCandle.high = Math.max(lastCandle.high, spot);
      lastCandle.low = Math.min(lastCandle.low, spot);

      const roundedNow = Math.floor(now / (timeframeMin * 60000)) * (timeframeMin * 60000);
      const lastTime = new Date(lastCandle.time).getTime();
      const roundedLastTime = Math.floor(lastTime / (timeframeMin * 60000)) * (timeframeMin * 60000);

      if (roundedNow > roundedLastTime) {
        mockCacheItem.data.candles.shift();
        mockCacheItem.data.candles.push({
          open: spot,
          close: spot,
          high: spot,
          low: spot,
          rsi14: Math.random() * 40 + 30,
          time: new Date(roundedNow).toISOString(),
        });
      }
      mockCacheItem.lastUpdate = now;
      mockCacheItem.data.spot = spot;
    }
    return mockCacheItem.data;
  }

  // Generate realistic TA data
  const rsi = Math.floor(35 + Math.random() * 40); // 35 to 75

  let rsiZoneShift = null;
  if (rsi > 60 && Math.random() > 0.5) rsiZoneShift = "BEARISH ZONE SHIFT";
  else if (rsi < 40 && Math.random() > 0.5) rsiZoneShift = "BULLISH ZONE SHIFT";

  const adx = Math.floor(15 + Math.random() * 30);
  const plusDi = Math.floor(20 + Math.random() * 20);
  const minusDi = Math.floor(20 + Math.random() * 20);

  let adxTrend = "Balanced";
  if (adx > 25) {
    if (plusDi > minusDi) adxTrend = "Bulls dominant";
    else adxTrend = "Bears dominant";
  }

  const patterns = [
    "Doji",
    "Hammer",
    "Shooting Star",
    "Bullish Engulfing",
    "Bearish Engulfing",
    "Morning Star",
    "Evening Star",
  ];
  const currentPattern =
    Math.random() > 0.4
      ? patterns[Math.floor(Math.random() * patterns.length)]
      : "No major pattern detected";

    const candlesData: any[] = [];
    let lastClose = spot - 50 + Math.sin(0) * 50;
    
    for (let i = 0; i < 500; i++) {
      const open = lastClose; // No price gaps!
      const close = open + (Math.random() * 20 - 10);
      const high = Math.max(open, close) + Math.random() * 15;
      const low = Math.min(open, close) - Math.random() * 15;
      const volume = Math.floor(Math.abs(close - open) * 1000) + 100;
      
      const roundedNow = Math.floor(now / (timeframeMin * 60000)) * (timeframeMin * 60000);
      const candleTime = new Date(
        roundedNow - (499 - i) * timeframeMin * 60000,
      ).toISOString();
      
      candlesData.push({ open, high, low, close, volume, time: candleTime });
      lastClose = close; // Persist for next candle
    }

    // Force the last candle's close to be exactly the current spot
    if (candlesData.length > 0) {
      const last = candlesData[candlesData.length - 1];
      last.close = spot;
      last.high = Math.max(last.high, spot);
      last.low = Math.min(last.low, spot);
    }

    const closes = candlesData.map(c => c.close);
    const mockRsiValues = calculateRSI(closes, 14);
    candlesData.forEach((c, i) => {
      c.rsi14 = mockRsiValues[i] === 0 ? 50 : mockRsiValues[i];
    });

    const result = {
      isMock: true,
      rsi,
      rsiZoneShift,
      adx,
      plusDi,
      minusDi,
      adxTrend,
      currentPattern,
      timeframe: timeframeMin,
      instrument_token,
      spot,
      baseSpot: spot,
      vwap: spot - (Math.random() * 20 - 10),
      ema20: spot - (Math.random() * 40 - 20),
      candles: candlesData,
    };

  cacheMap.set(cacheKey, { data: result, lastUpdate: now, lastFullFetch: now });

  return result;
}
