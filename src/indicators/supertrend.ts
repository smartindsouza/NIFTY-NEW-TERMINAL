export interface SupertrendItem {
  time: number;
  value: number; // The active stop line
  direction: 'up' | 'down';
}

interface CacheDetails {
  candles: { time: number; high: number; low: number; close: number }[];
  results: SupertrendItem[];
}

const cacheMap = new Map<string, CacheDetails>();

/**
 * Calculates Supertrend indicator with ATR and basic upper/lower bands with incremental caching.
 */
export function calculateSupertrend(
  candles: { time: number; high: number; low: number; close: number }[],
  period: number = 10,
  multiplier: number = 3
): SupertrendItem[] {
  if (!candles || candles.length < period) {
    return [];
  }

  const firstCandleTime = candles[0]?.time || 0;
  const cacheKey = `${firstCandleTime}_p${period}_m${multiplier}`;
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
      c.close !== cc.close
    ) {
      firstDiffIdx = j;
      break;
    }
  }

  if (firstDiffIdx === -1 && cachedResults.length > 0) {
    return cachedResults;
  }

  let finalResults: SupertrendItem[] = [];
  let startCandleIdx = period;

  if (firstDiffIdx !== -1 && cachedResults.length > 0) {
    // Keep results before the difference
    const keepCount = firstDiffIdx;
    if (keepCount > period && cachedResults.length >= keepCount) {
      finalResults = cachedResults.slice(0, keepCount - period);
      startCandleIdx = keepCount;
    }
  }

  // Pre-calculate True Range (TR) for all candles
  const tr: number[] = new Array(candles.length);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  // We need basic upper/lower band values
  // EMA/SMA of TR is the ATR
  const atr: number[] = new Array(candles.length);
  
  // Calculate first ATR point
  let trSum = 0;
  for (let i = 0; i < period; i++) {
    trSum += tr[i];
  }
  atr[period - 1] = trSum / period;

  // Wilder's smoothing or simple moving range
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  const basicUpperBand = candles.map((c, i) => (c.high + c.low) / 2 + multiplier * (atr[i] || 0));
  const basicLowerBand = candles.map((c, i) => (c.high + c.low) / 2 - multiplier * (atr[i] || 0));

  const finalUpperBand = new Array(candles.length).fill(0);
  const finalLowerBand = new Array(candles.length).fill(0);
  const supertrend = new Array(candles.length).fill(0);
  const direction: ('up' | 'down')[] = new Array(candles.length);

  // Initialize first valid supertrend item
  finalUpperBand[period - 1] = basicUpperBand[period - 1];
  finalLowerBand[period - 1] = basicLowerBand[period - 1];
  supertrend[period - 1] = basicUpperBand[period - 1];
  direction[period - 1] = 'down';

  // Seed finalResults with the starter item if empty
  if (finalResults.length === 0) {
    finalResults.push({
      time: candles[period - 1].time,
      value: parseFloat(supertrend[period - 1].toFixed(2)),
      direction: direction[period - 1]
    });
  }

  // Re-sync basicUpper/Lower bands history from start
  for (let i = period; i < candles.length; i++) {
    // Upper band logic
    if (basicUpperBand[i] < finalUpperBand[i - 1] || candles[i - 1].close > finalUpperBand[i - 1]) {
      finalUpperBand[i] = basicUpperBand[i];
    } else {
      finalUpperBand[i] = finalUpperBand[i - 1];
    }

    // Lower band logic
    if (basicLowerBand[i] > finalLowerBand[i - 1] || candles[i - 1].close < finalLowerBand[i - 1]) {
      finalLowerBand[i] = basicLowerBand[i];
    } else {
      finalLowerBand[i] = finalLowerBand[i - 1];
    }

    // Determine trend direction
    if (supertrend[i - 1] === finalUpperBand[i - 1]) {
      direction[i] = candles[i].close > finalUpperBand[i] ? 'up' : 'down';
    } else {
      direction[i] = candles[i].close < finalLowerBand[i] ? 'down' : 'up';
    }

    supertrend[i] = direction[i] === 'up' ? finalLowerBand[i] : finalUpperBand[i];

    if (i >= startCandleIdx) {
      finalResults.push({
        time: candles[i].time,
        value: parseFloat(supertrend[i].toFixed(2)),
        direction: direction[i]
      });
    }
  }

  const candlesSnapshot = candles.map(c => ({ time: c.time, high: c.high, low: c.low, close: c.close }));
  cacheMap.set(cacheKey, {
    candles: candlesSnapshot,
    results: finalResults,
  });

  return finalResults;
}
