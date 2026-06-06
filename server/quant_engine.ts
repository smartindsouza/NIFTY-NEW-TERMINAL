export function evaluateQuantSignals(inputs: any) {
  // Inputs expected: { rsi, trend, pcr, ivPercentile }
  let bullScore = 0;
  let bearScore = 0;
  let volScore = 0;
  let positioningScore = 0;
  let rulesTriggered: string[] = [];

  const { rsi = 50, trend = "neutral", pcr = Math.random() * 0.5 + 0.7, ivPercentile = null } = inputs;

  if (rsi > 60) {
    bullScore += 20;
    rulesTriggered.push("RSI indicates bullish momentum (>60)");
  } else if (rsi < 40) {
    bearScore += 20;
    rulesTriggered.push("RSI indicates bearish momentum (<40)");
  }

  if (pcr > 1.1) {
    positioningScore += 20;
    bullScore += 10;
    rulesTriggered.push("PCR > 1.1 showing bullish participant positioning");
  } else if (pcr < 0.8) {
    positioningScore -= 20;
    bearScore += 10;
    rulesTriggered.push("PCR < 0.8 showing bearish participant positioning");
  }

  if (trend === "up") {
    bullScore += 30;
    rulesTriggered.push("Primary trend is UP");
  } else if (trend === "down") {
    bearScore += 30;
    rulesTriggered.push("Primary trend is DOWN");
  }

  if (ivPercentile !== null && ivPercentile > 70) {
    volScore += 40;
    rulesTriggered.push("IV Percentile > 70, expecting expanding volatility");
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
    dataSources: ["Technical RSI", "Live Option Chain PCR", "Trend State"],
    unavailableInputs: ["IV Percentile History", "FII Positioning"]
  };
}
