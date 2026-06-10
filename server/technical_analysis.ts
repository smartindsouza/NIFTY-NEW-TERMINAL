import { getKiteClient } from "./kite_service.js";
import { aggregateCandles } from "./aggregator.js";

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

const cacheMap = new Map<string, { data: any, lastUpdate: number }>();
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
      
      // If valid cache exists within 60 seconds (but spot update diff is within 500 for NIFTY)
      if (
        cachedItem &&
        !cachedItem.data.isMock &&
        now - cachedItem.lastUpdate <= 60000 &&
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
            adx: 25,
            adxTrend: "TRENDING",
            currentPattern: "REAL DATA",
            timeframe: timeframeMin,
            instrument_token,
            spot: actualSpot,
            baseSpot:
              Math.abs(cachedItem?.data?.baseSpot - actualSpot) < (actualSpot * 0.05)
                ? cachedItem?.data?.baseSpot
                : actualSpot,
            vwap: actualSpot,
            ema20: actualSpot,
            candles,
            rawTop5: rawHist.slice(0, 5),
            rawVolumeStats: { max: maxVol, min: minVol, avg: avgVol },
          };
          
          cacheMap.set(cacheKey, { data: resultData, lastUpdate: Date.now() });
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

  cacheMap.set(cacheKey, { data: result, lastUpdate: now });

  return result;
}
