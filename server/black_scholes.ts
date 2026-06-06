export const MAX_IV = 2.0; // 200%
export const MIN_IV = 0.01; // 1%

// standard normal CDF
function _ncdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  x = Math.abs(x) / Math.sqrt(2.0);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

function _npdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function _d1(S: number, K: number, T: number, r: number, sigma: number): number {
  return (Math.log(S / K) + (r + (sigma * sigma) / 2.0) * T) / (sigma * Math.sqrt(T));
}

function _d2(S: number, K: number, T: number, r: number, sigma: number): number {
  return _d1(S, K, T, r, sigma) - sigma * Math.sqrt(T);
}

function _bs_price(S: number, K: number, T: number, r: number, sigma: number, opt_type: 'CE' | 'PE'): number {
  const d1 = _d1(S, K, T, r, sigma);
  const d2 = _d2(S, K, T, r, sigma);
  
  if (opt_type === 'CE') {
    return S * _ncdf(d1) - K * Math.exp(-r * T) * _ncdf(d2);
  } else {
    return K * Math.exp(-r * T) * _ncdf(-d2) - S * _ncdf(-d1);
  }
}

function _vega(S: number, K: number, T: number, r: number, sigma: number): number {
  const d1 = _d1(S, K, T, r, sigma);
  return S * Math.sqrt(T) * _npdf(d1);
}

export function compute_iv(market_price: number, spot: number, strike: number, T: number, opt_type: 'CE' | 'PE', r: number = 0.10): number {
  if (T <= 0 || market_price <= 0 || spot <= 0 || strike <= 0) return 0.0;
  
  // Brenner-Subrahmanyam ATM approx for initial guess
  let sigma = Math.sqrt(2 * Math.PI / T) * (market_price / spot);
  if (sigma < MIN_IV || sigma > MAX_IV) {
    sigma = 0.5; // fallback guess
  }

  const MAX_ITERATIONS = 100;
  const TOLERANCE = 1e-4;
  
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const price = _bs_price(spot, strike, T, r, sigma, opt_type);
    const diff = market_price - price;
    
    if (Math.abs(diff) < TOLERANCE) {
      return Math.min(Math.max(sigma * 100, MIN_IV * 100), MAX_IV * 100);
    }
    
    const vega_val = _vega(spot, strike, T, r, sigma);
    if (Math.abs(vega_val) < 1e-8) {
      break;
    }
    
    sigma = sigma + diff / vega_val;
    
    // Bounds check
    if (sigma < MIN_IV) {
      sigma = MIN_IV;
    } else if (sigma > MAX_IV) {
      sigma = MAX_IV;
    }
  }

  // If failed to converge, re-check boundaries
  return 0.0;
}
