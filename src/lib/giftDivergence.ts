// GIFT NIFTY ↔ NIFTY 50 divergence (replaces the RSI divergence on the chart).
//
// Compared SWING TO SWING on BOTH charts (Martin, 8 Oct 2026) — a signal only
// appears once the new low/high has actually FORMED, never while it is forming:
//   Bearish (red):  GIFT's latest swing low is LOWER than its previous swing low,
//                   while NIFTY's matching swing low is HIGHER than its previous one.
//   Bullish (green): GIFT's latest swing high is HIGHER than its previous swing high,
//                   while NIFTY's matching swing high is LOWER than its previous one.
// GIFT leads, so the signal points the way GIFT went.
//
// Details:
//   * A swing low/high is a candle with `lookback` candles on EACH side all higher
//     (lower). It is confirmed only when those right-hand candles have CLOSED — so
//     the signal is known `lookback` candles after the swing (knownAt), and is drawn
//     on the swing candle itself.
//   * The two GIFT swings are consecutive swings of the same kind, on the same
//     trading day, at most `maxBars` candles apart.
//   * NIFTY must have its own confirmed swing within `tol` candles of each GIFT
//     swing; those NIFTY swings are what is compared.
//   * Only candles both charts have (same start time) are used, i.e. the NIFTY
//     session. Candles still forming (start + tfSec > nowSec) are dropped first.

import { ssTime, ssIstDay } from './swapSweep';

export type GiftDiv = {
  kind: 'bear' | 'bull'; extreme: 'high' | 'low';
  time: number;            // NIFTY's second swing candle (where it is drawn)
  swingTime: number;       // NIFTY's first swing candle
  knownAt: number;         // start of the candle whose close confirmed it
  niftySwing: number; niftyNow: number; giftSwing: number; giftNow: number;
};
type C = { time: number; high: number; low: number };

export function detectGiftDivergence(niftyIn: any[], giftIn: any[], opts: { tfSec: number; nowSec?: number; lookback?: number; maxBars?: number; tol?: number }): GiftDiv[] {
  const L = opts.lookback ?? 3, maxBars = opts.maxBars ?? 40, tol = opts.tol ?? 2;
  const closed = (c: any) => opts.nowSec === undefined || ssTime(c.time) + opts.tfSec <= opts.nowSec;
  const gMap = new Map<number, C>();
  for (const c of giftIn || []) if (closed(c)) gMap.set(ssTime(c.time), { time: ssTime(c.time), high: +c.high, low: +c.low });
  const n: C[] = [], g: C[] = [];
  const nSorted = (niftyIn || []).filter(closed).map((c: any) => ({ time: ssTime(c.time), high: +c.high, low: +c.low })).sort((a, b) => a.time - b.time);
  for (const c of nSorted) { const gc = gMap.get(c.time); if (gc) { n.push(c); g.push(gc); } }

  const out: GiftDiv[] = [];
  for (const side of ['high', 'low'] as const) {
    const hi = side === 'high';
    const v = (c: C) => (hi ? c.high : c.low);
    const beyond = (a: number, b: number) => (hi ? a > b : a < b);       // a is past b in this side's direction
    const swings = (arr: C[]) => {
      const s: number[] = [];
      for (let p = L; p < arr.length - L; p++) {
        let ok = true;
        for (let k = 1; k <= L && ok; k++) if (!beyond(v(arr[p]), v(arr[p - k])) || !beyond(v(arr[p]), v(arr[p + k]))) ok = false;
        if (ok) s.push(p);
      }
      return s;
    };
    const gs = swings(g), ns = swings(n);
    const nearestN = (p: number) => {
      let best = -1;
      for (const q of ns) if (Math.abs(q - p) <= tol && ssIstDay(n[q].time) === ssIstDay(g[p].time) && (best < 0 || Math.abs(q - p) < Math.abs(best - p))) best = q;
      return best;
    };
    for (let k = 1; k < gs.length; k++) {
      const p1 = gs[k - 1], p2 = gs[k];
      if (ssIstDay(g[p1].time) !== ssIstDay(g[p2].time) || p2 - p1 > maxBars) continue;
      if (!beyond(v(g[p2]), v(g[p1]))) continue;                          // GIFT: higher high / lower low
      const q1 = nearestN(p1), q2 = nearestN(p2);
      if (q1 < 0 || q2 < 0 || q1 >= q2) continue;
      if (!beyond(v(n[q1]), v(n[q2]))) continue;                          // NIFTY: lower high / higher low
      const conf = Math.max(p2, q2) + L;                                  // both swings confirmed here
      out.push({ kind: hi ? 'bull' : 'bear', extreme: side, time: n[q2].time, swingTime: n[q1].time, knownAt: n[conf].time,
        niftySwing: v(n[q1]), niftyNow: v(n[q2]), giftSwing: v(g[p1]), giftNow: v(g[p2]) });
    }
  }
  return out.sort((a, b) => a.knownAt - b.knownAt);
}
