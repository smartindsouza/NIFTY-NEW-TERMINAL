// RSI divergence detection.
//
// A divergence is only meaningful between genuine turning points in the RSI —
// its swing highs and swing lows (pivots) — NOT between arbitrary candles.
// The previous version compared every red candle's low (or green candle's high)
// to every other within a window, which drew lines "everywhere" and re-drew them
// on every tick of the forming candle. This version:
//   1. Finds RSI pivots: a bar whose RSI is a local max/min vs `pivotLookback`
//      bars on EACH side (so it's a confirmed turning point, not any candle).
//   2. Pairs only CONSECUTIVE same-type pivots (low↔low, high↔high).
//   3. Excludes the still-forming last candle, so signals don't flicker/appear
//      on the in-progress bar.

interface Pivot { index: number; price: number; rsi: number; time: any; }

const rsiOf = (c: any): number =>
  typeof c?.rsi14 === "number" ? c.rsi14 : (typeof c?.rsi === "number" ? c.rsi : 50);

// A confirmed pivot needs `lookback` bars on both sides, so the last `lookback`
// bars (including the forming candle) can never be pivots — which is exactly the
// behaviour we want (no signals on the in-progress bar).
const findRsiPivotLows = (candles: any[], lookback: number): Pivot[] => {
  const out: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const r = rsiOf(candles[i]);
    let isLow = true;
    for (let k = 1; k <= lookback; k++) {
      // str* on the left, >= on the right avoids double-counting flat ties
      if (rsiOf(candles[i - k]) < r || rsiOf(candles[i + k]) < r) { isLow = false; break; }
      if (rsiOf(candles[i - k]) === r) { isLow = false; break; }
    }
    if (isLow) {
      out.push({ index: i, price: candles[i].low, rsi: r, time: candles[i].time });
    }
  }
  return out;
};

const findRsiPivotHighs = (candles: any[], lookback: number): Pivot[] => {
  const out: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const r = rsiOf(candles[i]);
    let isHigh = true;
    for (let k = 1; k <= lookback; k++) {
      if (rsiOf(candles[i - k]) > r || rsiOf(candles[i + k]) > r) { isHigh = false; break; }
      if (rsiOf(candles[i - k]) === r) { isHigh = false; break; }
    }
    if (isHigh) {
      out.push({ index: i, price: candles[i].high, rsi: r, time: candles[i].time });
    }
  }
  return out;
};

const parseToDate = (timeInput: any): Date | null => {
  if (timeInput === null || timeInput === undefined) return null;
  if (typeof timeInput === "number") {
    return new Date(timeInput < 10000000000 ? timeInput * 1000 : timeInput);
  }
  if (typeof timeInput === "string") {
    if (/^\d+$/.test(timeInput)) {
      const num = parseInt(timeInput, 10);
      return new Date(num < 10000000000 ? num * 1000 : num);
    }
    return new Date(timeInput);
  }
  if (timeInput instanceof Date) return timeInput;
  return null;
};

const isSameDay = (time1: any, time2: any) => {
  try {
    const d1 = parseToDate(time1);
    const d2 = parseToDate(time2);
    if (!d1 || !d2 || isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist1 = new Date(d1.getTime() + istOffset);
    const ist2 = new Date(d2.getTime() + istOffset);
    return ist1.getUTCFullYear() === ist2.getUTCFullYear() &&
           ist1.getUTCMonth() === ist2.getUTCMonth() &&
           ist1.getUTCDate() === ist2.getUTCDate();
  } catch (e) {
    return false;
  }
};

// Bullish: price makes a LOWER low while RSI makes a HIGHER low — between two
// consecutive RSI pivot lows.
export const detectBullishRSIDivergence = (
  pivotLows: Pivot[],
  maxDistance: number,
  minRSIDiff: number,
  restrictSameDay: boolean
) => {
  const detected: { type: "bullish"; p1: Pivot; p2: Pivot }[] = [];
  for (let i = 1; i < pivotLows.length; i++) {
    const p1 = pivotLows[i - 1]; // consecutive pivots only
    const p2 = pivotLows[i];
    if ((p2.index - p1.index) > maxDistance) continue;
    if (restrictSameDay && !isSameDay(p1.time, p2.time)) continue;
    if (p2.price < p1.price && (p2.rsi - p1.rsi) >= minRSIDiff) {
      detected.push({ type: "bullish", p1, p2 });
    }
  }
  return detected;
};

// Bearish: price makes a HIGHER high while RSI makes a LOWER high — between two
// consecutive RSI pivot highs.
export const detectBearishRSIDivergence = (
  pivotHighs: Pivot[],
  maxDistance: number,
  minRSIDiff: number,
  restrictSameDay: boolean
) => {
  const detected: { type: "bearish"; p1: Pivot; p2: Pivot }[] = [];
  for (let i = 1; i < pivotHighs.length; i++) {
    const p1 = pivotHighs[i - 1];
    const p2 = pivotHighs[i];
    if ((p2.index - p1.index) > maxDistance) continue;
    if (restrictSameDay && !isSameDay(p1.time, p2.time)) continue;
    if (p2.price > p1.price && (p1.rsi - p2.rsi) >= minRSIDiff) {
      detected.push({ type: "bearish", p1, p2 });
    }
  }
  return detected;
};

// Kept for backward-compatibility with any other importers; now returns RSI pivots.
export const findRedCandles = (candles: any[]) => findRsiPivotLows(candles, 3);
export const findGreenCandles = (candles: any[]) => findRsiPivotHighs(candles, 3);

export const getDivergences = (
  candles: any[],
  maxDistance: number = 30,
  minRSIDiff: number = 3,
  timeframe?: string | number,
  pivotLookback: number = 3
) => {
  if (!candles || candles.length === 0) return [];

  const restrictSameDay = String(timeframe) === "15";

  // Pivots need bars on both sides, so the forming last bar is naturally excluded.
  const pivotLows = findRsiPivotLows(candles, pivotLookback);
  const pivotHighs = findRsiPivotHighs(candles, pivotLookback);

  const bearishDivs = detectBearishRSIDivergence(pivotHighs, maxDistance, minRSIDiff, restrictSameDay);
  const bullishDivs = detectBullishRSIDivergence(pivotLows, maxDistance, minRSIDiff, restrictSameDay);

  return [...bearishDivs, ...bullishDivs];
};
