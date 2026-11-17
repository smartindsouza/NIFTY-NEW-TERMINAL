// THE OPTION CHAIN'S IMPLIED VOLATILITY AND GREEKS (17 Nov 2026).
// The broker's quotes carry a price and open interest, no Greeks, so the chain
// works them out. The model is the one Lemonn's chain uses, which was found by
// fitting its own figures (Martin's recording of 16 Nov, 5:44 PM: twenty
// implied volatilities and the Vega, Theta and Rho of the 25,050 strike):
//   - Black-Scholes on the index's spot price, no dividend;
//   - an interest rate of 10% a year;
//   - the time left is the clock time from now to 3:30 PM IST on the expiry
//     day, as a fraction of a 365-day year (their figures move through the
//     evening with the market shut, so it is not trading time);
//   - Theta is for one calendar day, Vega and Rho for one percentage point.
// With those, every one of the twenty volatilities comes out within 0.04 of
// theirs and the three Greeks within half a percent. Pure functions, tested in
// optionGreeks.test.ts against the figures in the recording.

export const RISK_FREE_RATE = 0.10;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const cdf = (x: number) => {
  // Abramowitz & Stegun 7.1.26 on erf: an error under 1.5e-7, far inside what is shown.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + (x >= 0 ? y : -y));
};
const pdf = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

/** The fraction of a year from `nowMs` to 3:30 PM IST on `expiry` (YYYY-MM-DD, or any date text beginning so). Never less than a minute's worth. */
export function yearsToExpiry(expiry: string, nowMs: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expiry || ''));
  if (!m) return NaN;
  // 3:30 PM IST is 10:00 UTC.
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 10, 0, 0);
  return Math.max(60 * 1000, end - nowMs) / YEAR_MS;
}

export function bsPrice(spot: number, strike: number, years: number, vol: number, isCall: boolean, rate = RISK_FREE_RATE): number {
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + vol * vol / 2) * years) / sd, d2 = d1 - sd;
  const k = strike * Math.exp(-rate * years);
  return isCall ? spot * cdf(d1) - k * cdf(d2) : k * cdf(-d2) - spot * cdf(-d1);
}

/**
 * The volatility at which the model's price is the option's price. None (null)
 * when there is no such number: no price, a price under what the option is
 * worth if exercised (a stale quote), or one beyond any volatility.
 */
export function impliedVol(spot: number, strike: number, years: number, price: number, isCall: boolean, rate = RISK_FREE_RATE): number | null {
  if (!(spot > 0) || !(strike > 0) || !(years > 0) || !(price > 0)) return null;
  let lo = 1e-4, hi = 6;
  if (bsPrice(spot, strike, years, lo, isCall, rate) > price || bsPrice(spot, strike, years, hi, isCall, rate) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(spot, strike, years, mid, isCall, rate) > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface Greeks { iv: number; delta: number; gamma: number; vega: number; theta: number; rho: number }

/** The Greeks at a volatility: Theta a calendar day, Vega and Rho a percentage point. */
export function greeksAt(spot: number, strike: number, years: number, vol: number, isCall: boolean, rate = RISK_FREE_RATE): Greeks {
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + vol * vol / 2) * years) / sd, d2 = d1 - sd;
  const k = strike * Math.exp(-rate * years);
  return {
    iv: vol * 100,
    delta: isCall ? cdf(d1) : cdf(d1) - 1,
    gamma: pdf(d1) / (spot * sd),
    vega: spot * pdf(d1) * Math.sqrt(years) / 100,
    theta: (-(spot * pdf(d1) * vol) / (2 * Math.sqrt(years)) - (isCall ? rate * k * cdf(d2) : -rate * k * cdf(-d2))) / 365,
    rho: (isCall ? k * years * cdf(d2) : -k * years * cdf(-d2)) / 100,
  };
}

/** The volatility an option's price implies, and its Greeks there; null when the price implies none. */
export function optionGreeks(spot: number, strike: number, years: number, price: number, isCall: boolean, rate = RISK_FREE_RATE): Greeks | null {
  const vol = impliedVol(spot, strike, years, price, isCall, rate);
  return vol === null ? null : greeksAt(spot, strike, years, vol, isCall, rate);
}
