export interface BollingerBandItem {
  time: number;
  middle: number;
  upper: number;
  lower: number;
}

/**
 * Bollinger Bands — matches TradingView's defaults:
 *   basis  = SMA(close, period)
 *   dev    = population standard deviation of close over the same window
 *   upper  = basis + stdDev * dev
 *   lower  = basis - stdDev * dev
 *
 * Computed straight through on every call. A 20-period SMA over a few hundred
 * candles is microseconds, so there is no need for a cache. The previous
 * cached/incremental version keyed only on the FIRST candle's time+params, so
 * switching timeframe (e.g. 5m -> 1m, which often share the same 09:15 first
 * candle) collided on the same key and reused another timeframe's band values —
 * drawing bands that no longer matched the candles (candles poking outside the
 * bands). Recomputing every time removes that whole class of bug.
 */
export function calculateBollingerBands(
  candles: { time: number; close: number }[],
  period: number = 20,
  stdDev: number = 2
): BollingerBandItem[] {
  if (!candles || candles.length < period || period < 1) {
    return [];
  }

  const results: BollingerBandItem[] = [];

  // Running sum of close and close^2 for an O(n) sliding window.
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i].close;
    sum += c;
    sumSq += c * c;

    // Once the window is full, drop the candle that falls out of it.
    if (i >= period) {
      const out = candles[i - period].close;
      sum -= out;
      sumSq -= out * out;
    }

    if (i >= period - 1) {
      const mean = sum / period;
      // population variance = E[x^2] - (E[x])^2, guarded against tiny negatives
      let variance = sumSq / period - mean * mean;
      if (variance < 0) variance = 0;
      const sd = Math.sqrt(variance);

      results.push({
        time: candles[i].time,
        middle: parseFloat(mean.toFixed(2)),
        upper: parseFloat((mean + stdDev * sd).toFixed(2)),
        lower: parseFloat((mean - stdDev * sd).toFixed(2)),
      });
    }
  }

  return results;
}
