export interface EmaItem {
  time: number;
  value: number;
}

interface CacheDetails {
  candles: { time: number; close: number }[];
  results: EmaItem[];
}

const cacheMap = new Map<string, CacheDetails>();

/**
 * Calculates Exponential Moving Average (EMA) with incremental caching.
 */
export function calculateEMA(
  candles: { time: number; close: number }[],
  period: number = 20
): EmaItem[] {
  if (!candles || candles.length < period) {
    return [];
  }

  const firstCandleTime = candles[0]?.time || 0;
  const cacheKey = `${firstCandleTime}_p${period}`;
  const cached = cacheMap.get(cacheKey);

  const cachedCandles = cached ? cached.candles : [];
  const cachedResults = cached ? cached.results : [];

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

  if (firstDiffIdx === -1 && cachedResults.length > 0) {
    return cachedResults;
  }

  let finalResults: EmaItem[] = [];
  let startCandleIdx = period - 1;

  if (firstDiffIdx !== -1 && cachedResults.length > 0) {
    // EMA at index i depends on EMA at index i-1.
    // If candle differs at firstDiffIdx, then the result at firstDiffIdx and all subsequent indices need recalculation.
    // So all items before firstDiffIdx can be securely kept.
    const keepCount = firstDiffIdx;
    if (keepCount > 0 && cachedResults.length >= keepCount) {
      finalResults = cachedResults.slice(0, keepCount);
      startCandleIdx = firstDiffIdx;
    }
  }

  const k = 2 / (period + 1);

  if (finalResults.length === 0) {
    // Initial SMA for the first EMA point
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += candles[i].close;
    }
    const sma = sum / period;
    finalResults.push({
      time: candles[period - 1].time,
      value: parseFloat(sma.toFixed(2)),
    });
    startCandleIdx = period;
  }

  for (let i = startCandleIdx; i < candles.length; i++) {
    const prevEma = finalResults[finalResults.length - 1].value;
    const currentEma = candles[i].close * k + prevEma * (1 - k);
    finalResults.push({
      time: candles[i].time,
      value: parseFloat(currentEma.toFixed(2)),
    });
  }

  // Update cached copy
  const candlesSnapshot = candles.map(c => ({ time: c.time, close: c.close }));
  cacheMap.set(cacheKey, {
    candles: candlesSnapshot,
    results: finalResults,
  });

  return finalResults;
}
