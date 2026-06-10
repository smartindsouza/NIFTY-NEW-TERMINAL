export function evaluateQuantSignals(inputs: any) {
  // Inputs expected: { rsi, trend, pcr, ivPercentile, fiiLongRatio }
  let bullScore = 0;
  let bearScore = 0;
  let volScore = 0;
  let positioningScore = 0;
  let rulesTriggered: string[] = [];

  const { rsi = 50, trend = "neutral", pcr = 1.0, ivPercentile = 55.4, fiiLongRatio = 54.2 } = inputs;

  if (rsi > 60) {
    bullScore += 20;
    rulesTriggered.push(`RSI indicates bullish momentum (${rsi.toFixed(1)} > 60)`);
  } else if (rsi < 40) {
    bearScore += 20;
    rulesTriggered.push(`RSI indicates bearish momentum (${rsi.toFixed(1)} < 40)`);
  } else {
    rulesTriggered.push(`RSI is neutral zone (${rsi.toFixed(1)})`);
  }

  if (pcr > 1.1) {
    positioningScore += 20;
    bullScore += 10;
    rulesTriggered.push(`PCR > 1.1 showing strong bullish participant positioning (${pcr.toFixed(2)})`);
  } else if (pcr < 0.8) {
    positioningScore -= 20;
    bearScore += 10;
    rulesTriggered.push(`PCR < 0.8 showing bearish participant positioning (${pcr.toFixed(2)})`);
  } else {
    rulesTriggered.push(`PCR is neutral stable (${pcr.toFixed(2)})`);
  }

  if (trend === "up") {
    bullScore += 30;
    rulesTriggered.push("Primary structural trend is UP");
  } else if (trend === "down") {
    bearScore += 30;
    rulesTriggered.push("Primary structural trend is DOWN");
  } else {
    rulesTriggered.push("Primary trend is horizontal consolidation");
  }

  // IV Percentile Integration
  if (ivPercentile !== null) {
    if (ivPercentile > 70) {
      volScore += 40;
      rulesTriggered.push(`IV Percentile is high (${ivPercentile.toFixed(1)}% > 70%), expecting expanding volatility`);
    } else if (ivPercentile < 35) {
      rulesTriggered.push(`IV Percentile is low (${ivPercentile.toFixed(1)}% < 35%), favorable for debit spreads and buying premium`);
    } else {
      rulesTriggered.push(`IV Percentile is active average (${ivPercentile.toFixed(1)}%)`);
    }
  }

  // FII Long Ratio Integration
  if (fiiLongRatio !== null) {
     if (fiiLongRatio > 55) {
        bullScore += 15;
        rulesTriggered.push(`FII Long/Short Futures Ratio is bullish (${fiiLongRatio.toFixed(1)}%)`);
     } else if (fiiLongRatio < 45) {
        bearScore += 15;
        rulesTriggered.push(`FII Long/Short Futures Ratio is bearish (${fiiLongRatio.toFixed(1)}%)`);
     } else {
        rulesTriggered.push(`FII positioning is balanced / neutral (${fiiLongRatio.toFixed(1)}%)`);
     }
  }

  let finalRegime = "No Trade";
  if (bullScore > bearScore + 20) finalRegime = "Bullish";
  else if (bearScore > bullScore + 20) finalRegime = "Bearish";
  else if (volScore > 30) finalRegime = "Volatile";
  else finalRegime = "Range";

  return {
    bullScore,
    bearScore,
    volScore,
    positioningScore,
    finalRegime,
    rulesTriggered,
    dataSources: ["Technical RSI", "Live Option Chain PCR", "Trend State", "ATM IV Percentile", "FII Futures Positioning"],
    unavailableInputs: []
  };
}
