export interface BollingerBandItem {
  time: number;
  middle: number;
  upper: number;
  lower: number;
}

interface CacheKeyDetails {
  candles: { time: number; close: number }[];
  results: BollingerBandItem[];
}

const cacheMap = new Map<string, CacheKeyDetails>();

/**
 * Calculates Bollinger Bands for the given candles.
 * 
 * Performance:
 * This uses an incremental calculation algorithm with a cache.
 * When a new ticker candle is updated or appended, only the affected
 * calculations are performed.
 * All other previous data points are reused instantly.
 */
export function calculateBollingerBands(
  candles: { time: number; close: number }[],
  period: number = 20,
  stdDev: number = 2
): BollingerBandItem[] {
  if (!candles || candles.length < period) {
    return [];
  }

  // Create a cache key using the first candle's time and the parameters
  const firstCandleTime = candles[0]?.time || 0;
  const cacheKey = `${firstCandleTime}_p${period}_s${stdDev}`;

  let cached = cacheMap.get(cacheKey);

  // If there's no cache or the cache has different candles, find the starting point of difference
  let cachedCandles = cached ? cached.candles : [];
  let cachedResults = cached ? cached.results : [];

  let firstDiffIdx = -1;
  const maxLen = Math.max(candles.length, cachedCandles.length);
  for (let j = 0; j < maxLen; j++) {
    if (
      !cachedCandles[j] ||
      !candles[j] ||
      candles[j].time !== cachedCandles[j].time ||
      candles[j].close !== cachedCandles[j].close
    ) {
      firstDiffIdx = j;
      break;
    }
  }

  // If no difference, return cache directly
  if (firstDiffIdx === -1 && cachedResults.length > 0) {
    return cachedResults;
  }

  let finalResults: BollingerBandItem[] = [];
  let startCandleIdx = period - 1;

  if (firstDiffIdx !== -1 && cachedResults.length > 0) {
    // Keep results that do not depend on any changed candle
    // Bollinger Band at candle index `k` depends on candle closes from `k - period + 1` to `k`.
    // It is affected if is >= firstDiffIdx.
    // So all result items matching candle indices < firstDiffIdx are safe to keep.
    // Result at index j corresponds to candle index j + period - 1.
    // So j + period - 1 < firstDiffIdx => j < firstDiffIdx - period + 1.
    const keepCount = firstDiffIdx - period + 1;
    if (keepCount > 0) {
      finalResults = cachedResults.slice(0, keepCount);
      startCandleIdx = Math.max(period - 1, firstDiffIdx);
    }
  }

  // Calculate for all indices starting from startCandleIdx
  for (let i = startCandleIdx; i < candles.length; i++) {
    // middle band (SMA)
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[i - j].close;
    }
    const sma = sum / period;

    // standard deviation
    let varianceSum = 0;
    for (let j = 0; j < period; j++) {
      varianceSum += Math.pow(candles[i - j].close - sma, 2);
    }
    const variance = varianceSum / period;
    const sd = Math.sqrt(variance);

    finalResults.push({
      time: candles[i].time,
      middle: parseFloat(sma.toFixed(2)),
      upper: parseFloat((sma + stdDev * sd).toFixed(2)),
      lower: parseFloat((sma - stdDev * sd).toFixed(2)),
    });
  }

  // Update cached copy
  // Create shallow clones of candles to protect against mutation
  const candlesSnapshot = candles.map(c => ({ time: c.time, close: c.close }));
  cacheMap.set(cacheKey, {
    candles: candlesSnapshot,
    results: finalResults,
  });

  return finalResults;
}
