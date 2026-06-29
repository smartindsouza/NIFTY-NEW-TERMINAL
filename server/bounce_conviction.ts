// Bounce Conviction — a composite that grades an RSI-off-oversold bounce by how much
// confluence is behind it, to separate a runner from a fizzle. PURE and stateless so the
// identical logic runs live (latest candle) AND inside the RSI backtest (any candle index).
//
// The four scored components are all price/RSI/ADX/volume based, so they are fully
// backtestable. The options layer (Premium Pulse / OI) is a LIVE-ONLY confirmation added by
// the frontend, never baked in here, so backtest parity is preserved.

export interface BounceSeries {
  open?: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  rsi: number[];
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

export interface BounceParams {
  oversoldLevel?: number;    // RSI must have dipped to/below this recently to be a "bounce"
  oversoldLookback?: number; // how many candles back to look for that dip
  thrustFull?: number;       // RSI points of rise off the low that counts as a full thrust
  volAvgPeriod?: number;     // lookback for the average-volume baseline
  volFull?: number;          // volume / avg ratio that counts as full expansion
  weights?: { thrust: number; reclaim: number; trend: number; expansion: number };
}

export interface BounceResult {
  inBounceContext: boolean;
  score: number;             // 0–100 technical conviction
  label: "NO SETUP" | "LOW" | "BUILDING" | "STRONG";
  components: { rsiThrust: number; rsiReclaim: number; trend: number; expansion: number };
  detail: {
    rsi: number; recentMinRsi: number;
    adx: number; adxRising: boolean; plusDI: number; minusDI: number;
    volRatio: number; closePos: number;
  };
}

const DEFAULTS: Required<Omit<BounceParams, "weights">> & { weights: NonNullable<BounceParams["weights"]> } = {
  oversoldLevel: 35,
  oversoldLookback: 5,
  thrustFull: 20,
  volAvgPeriod: 20,
  volFull: 2,
  weights: { thrust: 0.3, reclaim: 0.2, trend: 0.25, expansion: 0.25 },
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function scoreBounceAt(s: BounceSeries, i: number, params?: BounceParams): BounceResult {
  const p = { ...DEFAULTS, ...params, weights: { ...DEFAULTS.weights, ...(params?.weights || {}) } };
  const empty: BounceResult = {
    inBounceContext: false, score: 0, label: "NO SETUP",
    components: { rsiThrust: 0, rsiReclaim: 0, trend: 0, expansion: 0 },
    detail: { rsi: s.rsi[i] ?? 50, recentMinRsi: s.rsi[i] ?? 50, adx: s.adx[i] ?? 0, adxRising: false, plusDI: s.plusDI[i] ?? 0, minusDI: s.minusDI[i] ?? 0, volRatio: 0, closePos: 0.5 },
  };
  if (i < 1 || i >= s.close.length) return empty;

  // 1) Bounce context: RSI dipped into oversold within the lookback and is now turning up.
  const from = Math.max(0, i - p.oversoldLookback);
  let recentMinRsi = Infinity;
  for (let k = from; k <= i; k++) recentMinRsi = Math.min(recentMinRsi, s.rsi[k]);
  const rsiNow = s.rsi[i];
  const inBounceContext = recentMinRsi <= p.oversoldLevel && rsiNow > recentMinRsi;
  if (!inBounceContext) return { ...empty, detail: { ...empty.detail, rsi: rsiNow, recentMinRsi } };

  // 2) RSI thrust: how far/fast RSI has risen off its recent low.
  const rsiThrust = clamp((rsiNow - recentMinRsi) / p.thrustFull, 0, 1);

  // 3) Midline reclaim: 40 → 0, 55 → 1.
  const rsiReclaim = clamp((rsiNow - 40) / 15, 0, 1);

  // 4) Trend: ADX rising (half) + bullish directional spread (half).
  const adxRising = (s.adx[i] || 0) > (s.adx[i - 1] || 0);
  const diSpread = (s.plusDI[i] || 0) - (s.minusDI[i] || 0);
  const trend = (adxRising ? 0.5 : 0) + clamp(diSpread / 20, 0, 0.5);

  // 5) Expansion: volume vs its recent average (60%) + close strength within the bar (40%).
  const vFrom = Math.max(0, i - p.volAvgPeriod);
  let vSum = 0, vCnt = 0;
  for (let k = vFrom; k < i; k++) { vSum += s.volume[k] || 0; vCnt++; }
  const avgVol = vCnt > 0 ? vSum / vCnt : 0;
  const volRatio = avgVol > 0 ? (s.volume[i] || 0) / avgVol : 0;
  const volPart = clamp((volRatio - 1) / Math.max(0.01, p.volFull - 1), 0, 1);
  const rng = s.high[i] - s.low[i];
  const closePos = rng > 0 ? clamp((s.close[i] - s.low[i]) / rng, 0, 1) : 0.5;
  const expansion = 0.6 * volPart + 0.4 * closePos;

  const w = p.weights;
  const raw = rsiThrust * w.thrust + rsiReclaim * w.reclaim + trend * w.trend + expansion * w.expansion;
  const score = Math.round(clamp(raw, 0, 1) * 100);
  const label: BounceResult["label"] = score >= 70 ? "STRONG" : score >= 40 ? "BUILDING" : "LOW";

  return {
    inBounceContext: true,
    score,
    label,
    components: {
      rsiThrust: Math.round(rsiThrust * 100),
      rsiReclaim: Math.round(rsiReclaim * 100),
      trend: Math.round(trend * 100),
      expansion: Math.round(expansion * 100),
    },
    detail: {
      rsi: Math.round(rsiNow * 10) / 10,
      recentMinRsi: Math.round(recentMinRsi * 10) / 10,
      adx: Math.round((s.adx[i] || 0) * 10) / 10,
      adxRising,
      plusDI: Math.round((s.plusDI[i] || 0) * 10) / 10,
      minusDI: Math.round((s.minusDI[i] || 0) * 10) / 10,
      volRatio: Math.round(volRatio * 100) / 100,
      closePos: Math.round(closePos * 100) / 100,
    },
  };
}
