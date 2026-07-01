export function getCandleOiSentiment(currentClose: number, prevClose: number, currentOi: number, prevOi: number): string {
  const priceUp = currentClose > prevClose;
  const priceDown = currentClose < prevClose;
  const oiUp = currentOi > prevOi;
  const oiDown = currentOi < prevOi;
  
  if (currentClose === prevClose || currentOi === prevOi) return 'NEUTRAL';
  if (priceUp && oiUp) return 'LONG BUILDUP';
  if (priceDown && oiUp) return 'SHORT BUILDUP';
  if (priceDown && oiDown) return 'LONG UNWINDING';
  if (priceUp && oiDown) return 'SHORT COVERING';
  
  return 'NEUTRAL';
}

export function computeMasterSignal(analytics: any, taData: any, fiiDiiData: any) {
  let bullScore = 0;
  let bearScore = 0;
  
  if (!analytics || !taData) return null;

  const { spot, resistanceZone, supportZone, pcr } = analytics;
  const { rsi, plusDi, minusDi, currentPattern } = taData;

  // Real session VWAP when the TA feed provides it (it now does). Falls back to
  // the last candle's open only if VWAP is unavailable. Previously this compared
  // close > open — i.e. just "is the last candle green" — despite the VWAP name.
  const lastCandle = taData.candles?.[taData.candles.length - 1];
  const lastClose = lastCandle?.close ?? spot;
  const vwapRef = (typeof taData.vwap === 'number' && taData.vwap > 0)
    ? taData.vwap
    : (lastCandle?.open ?? spot);
  const isAboveVwap = lastClose > vwapRef;

  // Bullish Checks
  if (spot > (resistanceZone?.strikePrice || spot + 100)) bullScore += 3;
  if (isAboveVwap) bullScore += 2;
  if (spot > (supportZone?.strikePrice || spot - 100)) bullScore += 2;
  if (plusDi > minusDi) bullScore += 1;
  if (rsi > 60) bullScore += 1;
  if (currentPattern?.toLowerCase().includes('bull')) bullScore += 1;
  if (fiiDiiData?.bias === 'bullish') bullScore += 1;

  // Bearish Checks
  if (spot < (supportZone?.strikePrice || spot - 100)) bearScore += 3;
  if (!isAboveVwap) bearScore += 2;
  if (spot < (resistanceZone?.strikePrice || spot + 100)) bearScore += 2;
  if (minusDi > plusDi) bearScore += 1;
  if (rsi < 40) bearScore += 1;
  if (currentPattern?.toLowerCase().includes('bear')) bearScore += 1;
  if (pcr < 0.7) bearScore += 1;
  if (fiiDiiData?.bias === 'bearish') bearScore += 1;

  // Regime Detection
  let regime = 'NO TRADE';
  if (spot >= (supportZone?.strikePrice || spot - 100) && spot <= (resistanceZone?.strikePrice || spot + 100)) {
    regime = 'RANGE';
  } else if (spot > (resistanceZone?.strikePrice || spot + 100)) {
    regime = 'BREAKOUT';
  } else if (spot < (supportZone?.strikePrice || spot - 100)) {
    regime = 'BREAKDOWN';
  }

  if (regime !== 'RANGE') {
    if (bullScore >= bearScore + 3) regime = 'BULLISH TREND';
    if (bearScore >= bullScore + 3) regime = 'BEARISH TREND';
  }

  // Final Signal
  let signal = 'WAIT';
  let confidence = 50;

  if (regime === 'RANGE') {
    signal = 'RANGE TRADE ONLY';
    confidence = 65; // Simulated base confidence for range
  } else if (bullScore >= bearScore + 3) {
    signal = 'BUY CALL';
    confidence = Math.min(65 + (bullScore - bearScore) * 5, 95);
  } else if (bearScore >= bullScore + 3) {
    signal = 'BUY PUT';
    confidence = Math.min(65 + (bearScore - bullScore) * 5, 95);
  }

  if (confidence < 65) {
    signal = 'WAIT';
  }

  return {
    signal,
    confidence,
    regime,
    bullScore,
    bearScore,
    entry: signal.includes('CALL') ? `Buy CE near ${supportZone?.strikePrice}` : signal.includes('PUT') ? `Buy PE near ${resistanceZone?.strikePrice}` : `Trade edges: ${supportZone?.strikePrice} - ${resistanceZone?.strikePrice}`,
    stopLoss: signal === 'WAIT' ? 'N/A' : `Decisive 15-min close beyond support/resistance`,
    target1: signal.includes('CALL') ? `${resistanceZone?.strikePrice}` : signal.includes('PUT') ? `${supportZone?.strikePrice}` : 'Opposite edge',
    target2: signal.includes('CALL') ? `${resistanceZone?.strikePrice + 100}` : signal.includes('PUT') ? `${supportZone?.strikePrice - 100}` : 'Mid-range',
    invalidation: `Break of structure/levels`,
    reasons: [
      `Spot at ${spot.toFixed(2)} in ${regime} regime`,
      `Bull Score: ${bullScore} | Bear Score: ${bearScore}`,
      pcr < 0.7 ? 'PCR is extremely bearish' : pcr > 1.3 ? 'PCR is extremely bullish' : 'Neutral PCR options positioning'
    ].slice(0, 3)
  };
}
