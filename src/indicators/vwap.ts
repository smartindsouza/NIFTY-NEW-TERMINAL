export interface VwapItem {
  time: number;
  value: number;
}

interface CacheDetails {
  candles: { time: number; high: number; low: number; close: number; volume: number }[];
  results: VwapItem[];
}

const cacheMap = new Map<string, CacheDetails>();

/**
 * Calculates Volume Weighted Average Price (VWAP) with incremental caching and intraday accumulation.
 */
export function calculateVWAP(
  candles: { time: number; high: number; low: number; close: number; volume: number }[]
): VwapItem[] {
  if (!candles || candles.length === 0) {
    return [];
  }

  const firstCandleTime = candles[0]?.time || 0;
  const cacheKey = `${firstCandleTime}_vwap`;
  const cached = cacheMap.get(cacheKey);

  const cachedCandles = cached ? cached.candles : [];
  const cachedResults = cached ? cached.results : [];

  let firstDiffIdx = -1;
  const maxLen = Math.max(candles.length, cachedCandles.length);
  for (let j = 0; j < maxLen; j++) {
    const cc = cachedCandles[j];
    const c = candles[j];
    if (
      !cc ||
      !c ||
      c.time !== cc.time ||
      c.high !== cc.high ||
      c.low !== cc.low ||
      c.close !== cc.close ||
      c.volume !== cc.volume
    ) {
      firstDiffIdx = j;
      break;
    }
  }

  if (firstDiffIdx === -1 && cachedResults.length > 0) {
    return cachedResults;
  }

  let finalResults: VwapItem[] = [];
  let startCandleIdx = 0;

  let cumulativePv = 0;
  let cumulativeVol = 0;

  if (firstDiffIdx !== -1 && cachedResults.length > 0) {
    const keepCount = firstDiffIdx;
    if (keepCount > 0 && cachedResults.length >= keepCount) {
      finalResults = cachedResults.slice(0, keepCount);
      startCandleIdx = keepCount;

      // Recalculate cumulative sums up to startCandleIdx
      for (let i = 0; i < startCandleIdx; i++) {
        const c = candles[i];
        const typicalPrice = (c.high + c.low + c.close) / 3;
        cumulativePv += typicalPrice * c.volume;
        cumulativeVol += c.volume;
      }
    }
  }

  for (let i = startCandleIdx; i < candles.length; i++) {
    const c = candles[i];
    
    // Simple Intraday reset check: reset cumulative values on a new day (if timestamps reflect multi-day)
    if (i > 0) {
      const prevDate = new Date(candles[i - 1].time * 1000).getUTCDate();
      const currDate = new Date(candles[i].time * 1000).getUTCDate();
      if (prevDate !== currDate) {
        cumulativePv = 0;
        cumulativeVol = 0;
      }
    }

    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativePv += typicalPrice * c.volume;
    cumulativeVol += c.volume;

    const vwapValue = cumulativeVol === 0 ? typicalPrice : cumulativePv / cumulativeVol;

    finalResults.push({
      time: c.time,
      value: parseFloat(vwapValue.toFixed(2)),
    });
  }

  const candlesSnapshot = candles.map(c => ({ time: c.time, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  cacheMap.set(cacheKey, {
    candles: candlesSnapshot,
    results: finalResults,
  });

  return finalResults;
}
