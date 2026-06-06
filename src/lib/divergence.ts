export const findRedCandles = (candles: any[]) => {
  const redCandles: { index: number; price: number; rsi: number; time: string }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.close < candle.open) {
      redCandles.push({
        index: i,
        price: candle.low, // Use low for bullish divergence check
        rsi: candle.rsi14 || 50,
        time: candle.time,
      });
    }
  }
  return redCandles;
};

export const findGreenCandles = (candles: any[]) => {
  const greenCandles: { index: number; price: number; rsi: number; time: string }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.close > candle.open) {
      greenCandles.push({
        index: i,
        price: candle.high, // Use high for bearish divergence check
        rsi: candle.rsi14 || 50,
        time: candle.time,
      });
    }
  }
  return greenCandles;
};

const isWithinMaxCandleDistance = (p1Index: number, p2Index: number, maxDist: number) => {
  return (p2Index - p1Index) <= maxDist;
};

const signalAlreadyExists = (
  p1Index: number,
  p2Index: number,
  type: string,
  detected: any[]
) => {
  return detected.some(
    (d) => d.p1.index === p1Index && d.p2.index === p2Index && d.type === type
  );
};

const parseToDate = (timeInput: any): Date | null => {
  if (timeInput === null || timeInput === undefined) return null;
  
  if (typeof timeInput === 'number') {
    if (timeInput < 10000000000) {
      return new Date(timeInput * 1000);
    }
    return new Date(timeInput);
  }
  
  if (typeof timeInput === 'string') {
    if (/^\d+$/.test(timeInput)) {
      const num = parseInt(timeInput, 10);
      if (num < 10000000000) {
        return new Date(num * 1000);
      }
      return new Date(num);
    }
    return new Date(timeInput);
  }

  if (timeInput instanceof Date) {
    return timeInput;
  }

  return null;
};

const isSameDay = (time1: any, time2: any) => {
  try {
    const d1 = parseToDate(time1);
    const d2 = parseToDate(time2);
    if (!d1 || !d2 || isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;

    // Convert both strictly to Indian Standard Time (IST, UTC+5:30)
    // to compare trading days on a timezone-neutral basis
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

export const detectBullishRSIDivergence = (
  redCandles: any[],
  maxDistance: number = 7,
  minRSIDiff: number = 3,
  restrictSameDay: boolean = false
) => {
  const detected: { type: "bullish"; p1: any; p2: any }[] = [];
  const usedP2Indices = new Set<number>();
  
  for (let i = 1; i < redCandles.length; i++) {
    const p2 = redCandles[i];
    
    // Check backwards
    for (let j = i - 1; j >= 0; j--) {
      const p1 = redCandles[j];
      
      if (!isWithinMaxCandleDistance(p1.index, p2.index, maxDistance)) {
         break;
      }

      if (restrictSameDay && !isSameDay(p1.time, p2.time)) {
        break;
      }
      
      // Price makes lower low, RSI makes higher low
      if (p2.price < p1.price && (p2.rsi - p1.rsi) > 0) {
        if (!usedP2Indices.has(p2.index) && !signalAlreadyExists(p1.index, p2.index, "bullish", detected)) {
          detected.push({ type: "bullish", p1, p2 });
          usedP2Indices.add(p2.index);
          break; // Stop looking further back for this p2
        }
      }
    }
  }
  return detected;
};

export const detectBearishRSIDivergence = (
  greenCandles: any[],
  maxDistance: number = 7,
  minRSIDiff: number = 3,
  restrictSameDay: boolean = false
) => {
  const detected: { type: "bearish"; p1: any; p2: any }[] = [];
  const usedP2Indices = new Set<number>();

  for (let i = 1; i < greenCandles.length; i++) {
    const p2 = greenCandles[i];
    
    for (let j = i - 1; j >= 0; j--) {
      const p1 = greenCandles[j];

      if (!isWithinMaxCandleDistance(p1.index, p2.index, maxDistance)) {
         break;
      }

      if (restrictSameDay && !isSameDay(p1.time, p2.time)) {
        break;
      }

      // Price makes higher high, RSI makes lower high
      if (p2.price > p1.price && (p1.rsi - p2.rsi) > 0) {
         if (!usedP2Indices.has(p2.index) && !signalAlreadyExists(p1.index, p2.index, "bearish", detected)) {
            detected.push({ type: "bearish", p1, p2 });
            usedP2Indices.add(p2.index);
            break;
         }
      }
    }
  }
  return detected;
};

export const getDivergences = (
  candles: any[],
  maxDistance: number = 7,
  minRSIDiff: number = 3,
  timeframe?: string | number
) => {
    if (!candles || candles.length === 0) return [];
    
    const restrictSameDay = String(timeframe) === "15";
    
    const redCandles = findRedCandles(candles);
    const greenCandles = findGreenCandles(candles);

    const bearishDivs = detectBearishRSIDivergence(greenCandles, maxDistance, minRSIDiff, restrictSameDay);
    const bullishDivs = detectBullishRSIDivergence(redCandles, maxDistance, minRSIDiff, restrictSameDay);

    return [...bearishDivs, ...bullishDivs];
};
