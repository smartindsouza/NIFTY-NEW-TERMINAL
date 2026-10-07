// GIFT NIFTY ↔ NIFTY 50 divergence (replaces the RSI divergence on the chart).
//
// GIFT NIFTY LEADS, so the signal points the way GIFT went (Martin, 7 Oct 2026):
// Bullish: GIFT NIFTY makes a HIGHER HIGH — a closed candle trades above GIFT's
//          last swing high — while NIFTY 50 does NOT: no NIFTY candle since that
//          swing has traded above NIFTY's high at the same swing candle.
// Bearish: GIFT makes a LOWER LOW while NIFTY does not (NIFTY holds a higher low).
// 'extreme' says which side the divergence is on (highs or lows).
//
// Details:
//   * Only candles both charts have (same start time) are compared, i.e. the NIFTY
//     session; GIFT's extra hours are ignored.
//   * A swing high/low is a GIFT candle with `lookback` candles on each side that
//     are all lower/higher — confirmed only once those right-hand candles exist,
//     so nothing uses future data.
//   * The signal is the FIRST closed candle that breaks the swing; one signal per
//     swing. The swing and the signal must be on the same trading day and within
//     `maxBars` candles of each other.
//   * Candles still forming (start + tfSec > nowSec) are dropped first.

import { ssTime, ssIstDay } from './swapSweep';

export type GiftDiv = {
  kind: 'bear' | 'bull'; extreme: 'high' | 'low'; time: number; swingTime: number;
  niftySwing: number; niftyNow: number; giftSwing: number; giftNow: number;
};
type C = { time: number; high: number; low: number };

export function detectGiftDivergence(niftyIn: any[], giftIn: any[], opts: { tfSec: number; nowSec?: number; lookback?: number; maxBars?: number }): GiftDiv[] {
  const L = opts.lookback ?? 3, maxBars = opts.maxBars ?? 40;
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
    for (let p = L; p < g.length - L; p++) {
      // GIFT swing at p (strict on both sides)
      let isSwing = true;
      for (let k = 1; k <= L && isSwing; k++) if (!beyond(v(g[p]), v(g[p - k])) || !beyond(v(g[p]), v(g[p + k]))) isSwing = false;
      if (!isSwing) continue;
      const day = ssIstDay(g[p].time);
      // first candle after the confirmation window that breaks the GIFT swing
      let i = -1;
      for (let j = p + 1; j < g.length && j - p <= maxBars && ssIstDay(g[j].time) === day; j++) {
        if (beyond(v(g[j]), v(g[p]))) { i = j; break; }
      }
      if (i < 0 || i <= p + L) continue;              // (cannot happen for a strict swing; kept as a guard)
      // NIFTY must NOT have gone past its own level at the swing candle, at any candle since
      let niftyFailed = true;
      for (let j = p + 1; j <= i; j++) if (beyond(v(n[j]), v(n[p]))) { niftyFailed = false; break; }
      if (!niftyFailed) continue;
      out.push({ kind: hi ? 'bull' : 'bear', extreme: side, time: n[i].time, swingTime: n[p].time, niftySwing: v(n[p]), niftyNow: v(n[i]), giftSwing: v(g[p]), giftNow: v(g[i]) });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}
