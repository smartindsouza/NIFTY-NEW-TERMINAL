// PATTERN LAB — Martin's hand-picked 3-candle examples that came before strong
// NIFTY falls (5-min), and the DRAFT rules meant to catch them.
//
// Process (agreed 13-14 Oct 2026):
//   1. Pull the EXACT candles for each example (no reading prices off screenshots).
//   2. Draft rules from what the examples share; show which examples each rule
//      catches and, where it misses, exactly which check failed — for Martin to
//      approve or adjust BEFORE any performance test.
//   3. Only then test the approved rules over ~2 years, judged on data from BEFORE
//      the period the examples were picked from.
// Everything here is pure (no I/O) so it is tested directly.

import { ssIstDay } from './swapSweep';

export type PC = { time: number; open: number; high: number; low: number; close: number };

export const PATTERN_DRAFT = {
  version: 'draft 1 · 14 Oct 2026',
  atrLen: 14,              // ATR = average true range of the 14 candles before the pattern
  pushMinBodyAtr: 0.6,     // the green push (1-2 green candles) has bodies totalling >= 0.6 x ATR
  pushHighLookback: 6,     // ...and reaches above the highs of the previous 6 candles (same day)
  rejectWickFrac: 0.5,     // rejection: upper wick at least half the failing candle's range
  openMinBodyAtr: 1.0,     // opening drop: red body at least 1 x ATR
  text: [
    'Failed push — wipe-out: one or two green candles push to the highest point of the last 30 minutes, with bodies totalling at least 0.6 × the average candle range (ATR). The very next candle closes BELOW where that push started.',
    'Failed push — rejection: the same push, and the next candle trades ABOVE the push\'s high but closes red, below the push\'s close, with an upper wick at least half its range.',
    'Opening drop: one of the first two candles of the day is red with a body of at least 1 × ATR; the next candle does not close back above that red candle\'s open; the one after closes red.',
    'Signal at the close of the candle that completes the pattern.',
  ],
} as const;

export type RuleKind = 'wipeout' | 'rejection' | 'opening';
export const RULE_LABEL: Record<RuleKind, string> = {
  wipeout: 'Failed push — wipe-out',
  rejection: 'Failed push — rejection',
  opening: 'Opening drop',
};

const sameDay = (a: PC, b: PC) => ssIstDay(a.time) === ssIstDay(b.time);
const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);
const fx = (x: number) => (Math.round(x * 100) / 100);

/** Average true range of up to `len` candles BEFORE index i (never includes i). */
export function atrBefore(c: PC[], i: number, len = PATTERN_DRAFT.atrLen): number | null {
  const from = Math.max(1, i - len);
  let sum = 0, n = 0;
  for (let k = from; k < i; k++) {
    const pc = c[k - 1].close;
    sum += Math.max(c[k].high - c[k].low, Math.abs(c[k].high - pc), Math.abs(c[k].low - pc));
    n++;
  }
  return n >= 5 ? sum / n : null;
}

export type Check = { ok: boolean; kind?: RuleKind; at: number; reason: string; time?: number };

/** Failed push ending at f (f = the failing candle; the push ends at f-1). */
export function checkFailedPush(c: PC[], f: number, d = PATTERN_DRAFT): Check {
  const P = f - 1;
  if (P < 1 || f >= c.length) return { ok: false, at: f, reason: 'not enough candles' };
  const F = c[f], p = c[P];
  if (!sameDay(F, p)) return { ok: false, at: f, reason: 'the push and the next candle are on different days' };
  if (!(p.close > p.open)) return { ok: false, at: f, reason: 'the candle before is not green (no push)' };
  // run of up to two consecutive green candles ending at P
  let s = P;
  if (P - 1 >= 0 && sameDay(c[P - 1], p) && c[P - 1].close > c[P - 1].open) s = P - 1;
  const atr = atrBefore(c, s, d.atrLen);
  if (atr === null) return { ok: false, at: f, reason: 'not enough history for ATR' };
  let body = 0, runHigh = -Infinity;
  for (let k = s; k <= P; k++) { body += c[k].close - c[k].open; runHigh = Math.max(runHigh, c[k].high); }
  if (body < d.pushMinBodyAtr * atr) return { ok: false, at: f, reason: `push too small: bodies ${fx(body / atr)}× ATR (needs ${d.pushMinBodyAtr})` };
  let prevHigh = -Infinity, seen = 0;
  for (let k = s - 1; k >= 0 && seen < d.pushHighLookback && sameDay(c[k], p); k--, seen++) prevHigh = Math.max(prevHigh, c[k].high);
  if (seen === 0) return { ok: false, at: f, reason: 'push is the first candle of the day' };
  if (!(runHigh > prevHigh)) return { ok: false, at: f, reason: `push did not reach a new 30-min high (${fx(runHigh)} vs ${fx(prevHigh)})` };
  const start = c[s].open;
  if (F.close < start) return { ok: true, kind: 'wipeout', at: f, reason: `next candle closed ${fx(start - F.close)} pts below the push's start` };
  const range = F.high - F.low;
  const wick = F.high - Math.max(F.open, F.close);
  if (F.high > runHigh && F.close < F.open && F.close < p.close && range > 0 && wick >= d.rejectWickFrac * range) {
    return { ok: true, kind: 'rejection', at: f, reason: `next candle went ${fx(F.high - runHigh)} pts above the push and was rejected (wick ${Math.round((wick / range) * 100)}% of its range)` };
  }
  // say WHY neither failure shape matched
  if (!(F.high > runHigh)) return { ok: false, at: f, reason: `next candle neither closed below the push's start (${fx(F.close)} vs ${fx(start)}) nor went above its high` };
  if (!(F.close < F.open)) return { ok: false, at: f, reason: 'next candle went above the push but closed green' };
  if (!(F.close < p.close)) return { ok: false, at: f, reason: 'next candle went above the push but closed above the push\'s close' };
  return { ok: false, at: f, reason: `next candle's upper wick only ${range > 0 ? Math.round((wick / range) * 100) : 0}% of its range (needs ${d.rejectWickFrac * 100}%)` };
}

/** Opening drop whose third candle is k (first candle k-2). */
export function checkOpeningDrop(c: PC[], k: number, d = PATTERN_DRAFT): Check {
  const a = k - 2;
  if (a < 1 || k >= c.length) return { ok: false, at: k, reason: 'not enough candles' };
  const A = c[a], B = c[a + 1], C = c[k];
  if (!sameDay(A, C) || !sameDay(A, B)) return { ok: false, at: k, reason: 'spans two days' };
  const m = istMin(A.time);
  if (m > 9 * 60 + 20) return { ok: false, at: k, reason: 'first candle is not one of the first two of the day' };
  if (!(A.close < A.open)) return { ok: false, at: k, reason: 'first candle is not red' };
  const atr = atrBefore(c, a, d.atrLen);
  if (atr === null) return { ok: false, at: k, reason: 'not enough history for ATR' };
  if ((A.open - A.close) < d.openMinBodyAtr * atr) return { ok: false, at: k, reason: `red body ${fx((A.open - A.close) / atr)}× ATR (needs ${d.openMinBodyAtr})` };
  if (B.close > A.open) return { ok: false, at: k, reason: 'second candle closed back above the red candle\'s open' };
  if (!(C.close < C.open)) return { ok: false, at: k, reason: 'third candle is not red' };
  return { ok: true, kind: 'opening', at: k, reason: `red opening candle ${fx((A.open - A.close) / atr)}× ATR, no recovery, then red` };
}

/** Everything about one example whose pattern starts at candle index m. */
export function analyzeExample(c: PC[], m: number, d = PATTERN_DRAFT) {
  const end = m + 2;
  const atr = atrBefore(c, m, d.atrLen);
  const window = c.slice(Math.max(0, m - 3), Math.min(c.length, m + 12)).filter((x) => ssIstDay(x.time) === ssIstDay(c[m].time) || x.time < c[m].time);
  const tries: Check[] = [];
  if (end < c.length) {
    tries.push(checkFailedPush(c, m + 1, d));
    tries.push(checkFailedPush(c, m + 2, d));
    tries.push(checkOpeningDrop(c, m + 2, d));
  }
  for (const t of tries) if (t.at >= 0 && t.at < c.length) t.time = c[t.at].time;   // the candle that completes it
  const hit = tries.find((t) => t.ok) || null;
  // what happened after the 3rd candle closed (same day only)
  const after = (n: number) => {
    if (end >= c.length) return null;
    const base = c[end].close;
    let lo = Infinity, hi = -Infinity, last = base, k = end + 1, cnt = 0;
    for (; k < c.length && cnt < n && sameDay(c[k], c[end]); k++, cnt++) { lo = Math.min(lo, c[k].low); hi = Math.max(hi, c[k].high); last = c[k].close; }
    if (!cnt) return null;
    return { candles: cnt, maxFall: fx(base - lo), maxRise: fx(hi - base), net: fx(last - base) };
  };
  return {
    atr: atr === null ? null : fx(atr),
    pattern: c.slice(m, Math.min(c.length, end + 1)),
    window,
    markedTime: c[m].time,
    after30: after(6),
    after60: after(12),
    hit,
    tries,
  };
}
