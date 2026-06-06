import { OptionContract } from './simulate_data';

export interface AnalyticsResult {
  pcr: number;
  maxPain: number;
  totalCeOi: number;
  totalPeOi: number;
  marketBias: string;
  confidence: number;
  topCeStrikes: any[];
  topPeStrikes: any[];
  supportZone: any;
  resistanceZone: any;
  tradeSignal: { direction: string; confidence: number; reasons: string[] };
}

export function computeAnalytics(
  chain: { spot: number, strikes: number[], ceData: Record<number, OptionContract>, peData: Record<number, OptionContract> }
): AnalyticsResult {
  let totalCeOi = 0;
  let totalPeOi = 0;
  
  chain.strikes.forEach(strike => {
    totalCeOi += chain.ceData[strike]?.oi || 0;
    totalPeOi += chain.peData[strike]?.oi || 0;
  });

  const pcr = totalPeOi / (totalCeOi || 1);

  // Max Pain
  let maxPain = chain.spot;
  let minPainValue = Infinity;
  chain.strikes.forEach(K => {
    let currentPain = 0;
    chain.strikes.forEach(strike => {
      // CE payout at expiry K
      if (K > strike) currentPain += (K - strike) * (chain.ceData[strike]?.oi || 0);
      // PE payout at expiry K
      if (K < strike) currentPain += (strike - K) * (chain.peData[strike]?.oi || 0);
    });
    if (currentPain < minPainValue) {
      minPainValue = currentPain;
      maxPain = K;
    }
  });

  const topCeStrikes = [...chain.strikes].map(k => chain.ceData[k]).filter(Boolean).sort((a, b) => b.oi - a.oi).slice(0, 5);
  const topPeStrikes = [...chain.strikes].map(k => chain.peData[k]).filter(Boolean).sort((a, b) => b.oi - a.oi).slice(0, 5);

  const resistanceZone = topCeStrikes.find(c => c.strikePrice >= chain.spot) || topCeStrikes[0] || { strikePrice: chain.spot, oi: 0 };
  const supportZone = topPeStrikes.find(p => p.strikePrice <= chain.spot) || topPeStrikes[0] || { strikePrice: chain.spot, oi: 0 };

  let biasScore = 0;
  if (pcr > 1.2) biasScore += 2;
  else if (pcr > 1) biasScore += 1;
  else if (pcr < 0.6) biasScore -= 2;
  else if (pcr < 0.8) biasScore -= 1;

  if (maxPain > chain.spot) biasScore += 1;
  else if (maxPain < chain.spot) biasScore -= 1;

  let marketBias = "Neutral";
  if (biasScore >= 2) marketBias = "Strongly Bullish";
  else if (biasScore === 1) marketBias = "Mildly Bullish";
  else if (biasScore === -1) marketBias = "Mildly Bearish";
  else if (biasScore <= -2) marketBias = "Strongly Bearish";

  let direction = biasScore > 0 ? "BUY CALL" : (biasScore < 0 ? "BUY PUT" : "NEUTRAL");

  return {
    pcr: parseFloat(pcr.toFixed(2)),
    maxPain,
    totalCeOi: parseFloat(totalCeOi.toFixed(2)),
    totalPeOi: parseFloat(totalPeOi.toFixed(2)),
    marketBias,
    confidence: Math.min(Math.abs(biasScore) * 30 + 10, 95),
    topCeStrikes,
    topPeStrikes,
    supportZone,
    resistanceZone,
    tradeSignal: {
      direction,
      confidence: Math.min(Math.abs(biasScore) * 30 + 10, 95),
      reasons: [
        `PCR is ${pcr.toFixed(2)}`,
        `Max Pain at ${maxPain} (${maxPain > chain.spot ? 'Above' : 'Below'} Spot)`
      ]
    }
  };
}
