// Live futures "pressure" proxy (forward-only).
//
// HONEST SCOPE: Kite gives no aggressor-classified trades, so true delta is
// impossible. This uses the classic TICK RULE on the front-month NIFTY future:
// each volume increment since the last tick is signed by price direction
// (uptick = buying pressure, downtick = selling), accumulated into a session
// cumulative-volume-delta (CVD) proxy. It resets daily. It is an approximation,
// futures-based and live-only — never presented as real order flow.

interface DeltaState {
  token: number | null;
  day: string;            // IST yyyy-mm-dd for daily reset
  lastCumVol: number | null;
  lastPrice: number | null;
  cvd: number;            // session cumulative delta (signed volume)
  upVol: number;          // running buy-pressure volume today
  downVol: number;        // running sell-pressure volume today
  recent: { t: number; d: number }[]; // last N signed increments for a short-window pressure
}

const state: DeltaState = {
  token: null, day: '', lastCumVol: null, lastPrice: null,
  cvd: 0, upVol: 0, downVol: 0, recent: [],
};

const RECENT_MS = 90 * 1000; // 90-second rolling window for the "pressure" figure

function istDay(ts: number): string {
  return new Date(ts + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function setDeltaFuturesToken(token: number | null) {
  if (token !== state.token) {
    state.token = token;
    // new instrument (expiry roll): reset the running counters cleanly
    state.lastCumVol = null; state.lastPrice = null;
  }
}

export function getDeltaFuturesToken(): number | null {
  return state.token;
}

// Feed every futures tick here. tick: { token, ltp, volume(cumulative), ts(ms) }
export function onFuturesTick(tick: { token: number; ltp: number; volume?: number; ts?: number }) {
  if (state.token === null || tick.token !== state.token) return;
  const ts = tick.ts ?? Date.now();
  const day = istDay(ts);
  if (day !== state.day) {
    // daily reset
    state.day = day; state.cvd = 0; state.upVol = 0; state.downVol = 0;
    state.lastCumVol = null; state.lastPrice = null; state.recent = [];
  }

  const cum = typeof tick.volume === 'number' ? tick.volume : null;
  const price = tick.ltp;

  if (cum !== null && state.lastCumVol !== null && state.lastPrice !== null) {
    let inc = cum - state.lastCumVol;
    if (inc < 0) inc = 0; // volume only ever rises intraday; guard against resets
    if (inc > 0) {
      // tick rule: sign the increment by price move since last tick
      const sign = price > state.lastPrice ? 1 : price < state.lastPrice ? -1 : 0;
      const signed = inc * sign;
      state.cvd += signed;
      if (sign > 0) state.upVol += inc;
      else if (sign < 0) state.downVol += inc;
      state.recent.push({ t: ts, d: signed });
    }
  }
  if (cum !== null) state.lastCumVol = cum;
  state.lastPrice = price;

  // trim rolling window
  const cutoff = ts - RECENT_MS;
  while (state.recent.length && state.recent[0].t < cutoff) state.recent.shift();
}

// Snapshot for broadcasting to the frontend.
export function getDeltaSnapshot() {
  const recentSum = state.recent.reduce((a, r) => a + r.d, 0);
  const recentAbs = state.recent.reduce((a, r) => a + Math.abs(r.d), 0);
  // normalized short-window pressure in [-1, 1]
  const pressure = recentAbs > 0 ? Math.max(-1, Math.min(1, recentSum / recentAbs)) : 0;
  const total = state.upVol + state.downVol;
  return {
    token: state.token,
    cvd: Math.round(state.cvd),
    upVol: Math.round(state.upVol),
    downVol: Math.round(state.downVol),
    pressure: +pressure.toFixed(3),          // short-window (~90s) buy/sell lean
    dayBias: total > 0 ? +(((state.upVol - state.downVol) / total)).toFixed(3) : 0, // session lean
    ts: Date.now(),
  };
}
