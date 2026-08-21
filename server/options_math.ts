// Minimal Black-Scholes helpers for backing out implied volatility and delta from a live premium.

// Standard normal CDF (Abramowitz & Stegun 7.1.26, ~7.5e-8 max error)
export function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function d1d2(S: number, K: number, T: number, r: number, sig: number): [number, number] {
  const vsqrt = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sig * sig) / 2) * T) / vsqrt;
  return [d1, d1 - vsqrt];
}

// Standard normal PDF
export function normPDF(x: number): number {
  return 0.3989422804014327 * Math.exp((-x * x) / 2);
}

// Black-Scholes gamma (identical for calls and puts): rate of change of delta per 1 point of spot.
export function bsGamma(S: number, K: number, T: number, r: number, sig: number): number {
  if (T <= 0 || sig <= 0 || S <= 0) return 0;
  const [d1] = d1d2(S, K, T, r, sig);
  return normPDF(d1) / (S * sig * Math.sqrt(T));
}

export function bsPrice(type: 'CE' | 'PE', S: number, K: number, T: number, r: number, sig: number): number {
  const [d1, d2] = d1d2(S, K, T, r, sig);
  if (type === 'CE') return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

// Back out implied volatility from a market premium via bisection. Returns null if not solvable.
export function impliedVol(type: 'CE' | 'PE', S: number, K: number, T: number, r: number, price: number): number | null {
  if (T <= 0 || price <= 0) return null;
  let lo = 0.005, hi = 5;
  const f = (sig: number) => bsPrice(type, S, K, T, r, sig) - price;
  if (f(lo) > 0 || f(hi) < 0) return null; // price outside achievable band
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-4) return mid;
    if (fm < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function bsDelta(type: 'CE' | 'PE', S: number, K: number, T: number, r: number, sig: number): number {
  const [d1] = d1d2(S, K, T, r, sig);
  return type === 'CE' ? normCDF(d1) : normCDF(d1) - 1;
}

// Convenience: from a live premium, return { iv (decimal), delta } or nulls if not solvable.
/** THETA — what the option loses per DAY purely because time passed, holding the
 *  index and volatility still. This is the number that explains a call falling on
 *  an up day, and it is not otherwise visible anywhere in the app. Returned as a
 *  per-day figure (negative for a buyer) rather than the per-year convention,
 *  because "I lose this much by tomorrow" is the question actually being asked. */
export function bsThetaPerDay(type: 'CE' | 'PE', S: number, K: number, T: number, r: number, sig: number): number {
  if (!(T > 0) || !(sig > 0) || !(S > 0) || !(K > 0)) return 0;
  const d1 = (Math.log(S / K) + (r + (sig * sig) / 2) * T) / (sig * Math.sqrt(T));
  const d2 = d1 - sig * Math.sqrt(T);
  const term1 = -(S * normPDF(d1) * sig) / (2 * Math.sqrt(T));
  const perYear = type === 'CE'
    ? term1 - r * K * Math.exp(-r * T) * normCDF(d2)
    : term1 + r * K * Math.exp(-r * T) * normCDF(-d2);
  return perYear / 365;
}

export function ivAndDelta(type: 'CE' | 'PE', S: number, K: number, T: number, r: number, price: number): { iv: number | null; delta: number | null } {
  const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
  // Essentially no time value → deep ITM/OTM: delta saturates
  if (price <= intrinsic + 0.05) return { iv: null, delta: intrinsic > 0 ? (type === 'CE' ? 1 : -1) : 0 };
  const sig = impliedVol(type, S, K, T, r, price);
  if (sig == null) return { iv: null, delta: null };
  return { iv: sig, delta: bsDelta(type, S, K, T, r, sig) };
}
