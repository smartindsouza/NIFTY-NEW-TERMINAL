export interface RsiItem {
  time: number;
  value: number;
}

interface CacheDetails {
  candles: { time: number; close: number }[];
  results: RsiItem[];
}

const cacheMap = new Map<string, CacheDetails>();

/**
 * Calculates Relative Strength Index (RSI) using Wilder's smoothing technique with incremental caching.
 */
export function calculateRSI(
  candles: { time: number; close: number }[],
  period: number = 14
): RsiItem[] {
  if (!candles || candles.length <= period) {
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

  // RSI relies on averages that cascade down. Any change at index `firstDiffIdx` affects all subsequent values.
  let finalResults: RsiItem[] = [];
  let startCandleIdx = period;

  if (firstDiffIdx !== -1 && cachedResults.length > 0) {
    const keepCount = firstDiffIdx - 1; // leave 1 index buffer to avoid carryover errors
    if (keepCount > 0 && cachedResults.length >= keepCount) {
      finalResults = cachedResults.slice(0, keepCount);
      startCandleIdx = Math.max(period, keepCount);
    }
  }

  // Calculate deltas
  const deltas = candles.slice(1).map((c, i) => c.close - candles[i].close);

  if (finalResults.length === 0) {
    // Warm up the initial averages for gains and losses
    let gain = 0;
    let loss = 0;
    for (let i = 0; i < period; i++) {
      const d = deltas[i];
      if (d > 0) gain += d;
      else loss -= d;
    }
    gain /= period;
    loss /= period;

    const rs = loss === 0 ? 100 : gain / loss;
    const rsi = loss === 0 ? 100 : 100 - 100 / (1 + rs);

    finalResults.push({
      time: candles[period].time,
      value: parseFloat(rsi.toFixed(2)),
    });

    startCandleIdx = period + 1;
  }

  // To calculate Wilderness smoothing, we require rolling averages.
  // Because Wilder's uses `let gain = (prevGain * 13 + currentGain) / 14`, we must recalculate smoothed elements.
  // We can track the gain & loss state backward from the last kept result to maintain total precision:
  let avgGain = 0;
  let avgLoss = 0;

  // Let's re-seed the state
  const seedIndex = startCandleIdx - 1;
  let seedGain = 0;
  let seedLoss = 0;

  for (let i = 0; i < period; i++) {
    const d = deltas[i];
    if (d > 0) seedGain += d;
    else seedLoss -= d;
  }
  seedGain /= period;
  seedLoss /= period;

  avgGain = seedGain;
  avgLoss = seedLoss;

  for (let i = period; i < seedIndex; i++) {
    const d = deltas[i];
    const currentGain = d > 0 ? d : 0;
    const currentLoss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  for (let i = startCandleIdx - 1; i < candles.length - 1; i++) {
    const d = deltas[i];
    const currentGain = d > 0 ? d : 0;
    const currentLoss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);

    // If i + 1 corresponds to a recalculation index, add it
    if (i + 1 >= startCandleIdx) {
      finalResults.push({
        time: candles[i + 1].time,
        value: parseFloat(rsi.toFixed(2)),
      });
    }
  }

  const candlesSnapshot = candles.map(c => ({ time: c.time, close: c.close }));
  cacheMap.set(cacheKey, {
    candles: candlesSnapshot,
    results: finalResults,
  });

  return finalResults;
}
