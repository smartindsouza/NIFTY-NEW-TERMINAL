import { OptionContract } from './simulate_data';

export interface AnalyticsResult {
  pcr: number;
  maxPain: number;
  totalCeOi: number;
  totalPeOi: number;
  // The same totals over EVERY strike of the expiry (what other apps and NSE
  // show), where the chain carries them; otherwise equal to the near-strike
  // totals above, and oiScope says which it is. Display only: the bias, the
  // signal and everything else in this file still work from the strikes near
  // spot, exactly as before.
  totalCeOiAll: number;
  totalPeOiAll: number;
  pcrAll: number;
  oiScope: 'all' | 'near';
  oiStrikes: number;
  marketBias: string;
  confidence: number;
  topCeStrikes: any[];
  topPeStrikes: any[];
  supportZone: any;
  resistanceZone: any;
  tradeSignal: { direction: string; confidence: number; reasons: string[] };
}

export function computeAnalytics(
  chain: { spot: number, strikes: number[], ceData: Record<number, OptionContract>, peData: Record<number, OptionContract>,
           oiAll?: { ce: number; pe: number; strikes: number; asOf: number } | null }
): AnalyticsResult {
  let totalCeOi = 0;
  let totalPeOi = 0;
  
  chain.strikes.forEach(strike => {
    totalCeOi += chain.ceData[strike]?.oi || 0;
    totalPeOi += chain.peData[strike]?.oi || 0;
  });

  const pcr = totalPeOi / (totalCeOi || 1);
  // All-strike totals, if the chain has them (server/kite_service.ts). They can
  // never be smaller than the near-strike totals they contain; a figure that is
  // would be a bad read, and is not shown.
  const all = chain.oiAll;
  const hasAll = !!all && Number.isFinite(all.ce) && Number.isFinite(all.pe) && all.ce >= totalCeOi - 0.01 && all.pe >= totalPeOi - 0.01 && all.ce + all.pe > 0;

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
    totalCeOiAll: parseFloat((hasAll ? all!.ce : totalCeOi).toFixed(2)),
    totalPeOiAll: parseFloat((hasAll ? all!.pe : totalPeOi).toFixed(2)),
    pcrAll: parseFloat((hasAll ? all!.pe / (all!.ce || 1) : pcr).toFixed(2)),
    oiScope: hasAll ? 'all' : 'near',
    oiStrikes: hasAll ? all!.strikes : chain.strikes.length,
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
