function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return new Array(closes.length).fill(50);
  let deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const rsiArray = new Array(closes.length).fill(50);
  let gain = 0, loss = 0;
  for (let i = 0; i < period; i++) {
    if (deltas[i] > 0) gain += deltas[i];
    else loss -= deltas[i];
  }
  gain /= period;
  loss /= period;
  let rs = loss === 0 ? 100 : gain / loss;
  rsiArray[period] = loss === 0 ? 100 : 100 - 100 / (1 + rs);

  for (let i = period + 1; i < closes.length; i++) {
    const d = deltas[i - 1]; 
    const currentGain = d > 0 ? d : 0;
    const currentLoss = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + currentGain) / period;
    loss = (loss * (period - 1) + currentLoss) / period;
    let rsNext = loss === 0 ? 100 : gain / loss;
    rsiArray[i] = loss === 0 ? 100 : 100 - 100 / (1 + rsNext);
  }
  return rsiArray;
}
const testCloses = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03];
console.log(calculateRSI(testCloses, 14));
