// PATTERN LAB — Martin's hand-picked 3-candle examples that came before strong
// NIFTY falls (5-min), the rules drawn from them, and the 2-year test.
//
// Process (agreed 13-14 Oct 2026):
//   1. Exact candles for each example (no reading prices off screenshots).
//   2. Rules drawn from what the examples share — DRAFT 2, approved by Martin on
//      14 Oct 2026 after seeing the exact candles. FROZEN from here: the test
//      below judges these rules exactly as written.
//   3. The test runs on data from BEFORE the period the examples were picked from
//      (they are all Sep-Oct 2026), so the examples cannot grade themselves.
// Everything here is pure (no I/O) so it is tested directly.

import { ssIstDay } from './swapSweep';
import { backtestEntries, ssStats, type SsEntry } from './swapSweep';

export type PC = { time: number; open: number; high: number; low: number; close: number };

export const PATTERN_DRAFT = {
  version: 'draft 2 · approved 14 Oct 2026',
  atrLen: 14,             // ATR = average true range of the 14 candles before the green candle
  withinCandles: 2,       // the red close must come within 2 candles of the green one
  nearTopAtr: 0.5,        // version B: green's high within 0.5 x ATR of the 30-min high
  topLookback: 6,         // 30 minutes = the 6 candles before the green one (same day)
  openMinBodyAtr: 1.0,    // opening drop: red body at least 1 x ATR
  text: [
    'Failed green (A): a green candle, then within the next 2 candles a red candle closes BELOW that green candle\'s open. Signal at that red candle\'s close.',
    'Failed green near the top (B): the same, but only when the green candle\'s high is within half an average candle (0.5 × ATR) of the highest point of the previous 30 minutes.',
    'Opening drop: one of the first two candles of the day is red with a body of at least 1 × ATR; the next candle does not close back above that red candle\'s open; the one after closes red.',
  ],
} as const;

export type RuleKind = 'failed_green' | 'opening';
export const RULE_LABEL: Record<string, string> = {
  failed_green: 'Failed green',
  opening: 'Opening drop',
};

const sameDay = (a: PC, b: PC) => ssIstDay(a.time) === ssIstDay(b.time);
const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);
const fx = (x: number) => (Math.round(x * 100) / 100);

/** Average true range of up to `len` candles BEFORE index i (never includes i). */
export function atrBefore(c: PC[], i: number, len: number = PATTERN_DRAFT.atrLen): number | null {
  const from = Math.max(1, i - len);
  let sum = 0, n = 0;
  for (let k = from; k < i; k++) {
    const pc = c[k - 1].close;
    sum += Math.max(c[k].high - c[k].low, Math.abs(c[k].high - pc), Math.abs(c[k].low - pc));
    n++;
  }
  return n >= 5 ? sum / n : null;
}

export type Check = { ok: boolean; kind?: RuleKind; at: number; reason: string; time?: number; nearTop?: boolean; green?: number; stop?: number };

/**
 * Failed green whose signal would be candle r (a red candle). The green candle is
 * the most recent green among the 2 candles before r (same day). Fires only on the
 * FIRST candle that closes below the green's open, so one green gives one signal.
 */
export function checkFailedGreen(c: PC[], r: number, d = PATTERN_DRAFT): Check {
  if (r < 1 || r >= c.length) return { ok: false, at: r, reason: 'not enough candles' };
  const R = c[r];
  if (!(R.close < R.open)) return { ok: false, at: r, reason: 'this candle is not red' };
  let g = -1;
  for (let k = r - 1; k >= Math.max(0, r - d.withinCandles); k--) {
    if (!sameDay(c[k], R)) break;
    if (c[k].close > c[k].open) { g = k; break; }
  }
  if (g < 0) return { ok: false, at: r, reason: `no green candle in the ${d.withinCandles} candles before it` };
  const G = c[g];
  if (!(R.close < G.open)) return { ok: false, at: r, reason: `closed at ${fx(R.close)}, not below the green candle's open ${fx(G.open)}` };
  for (let k = g + 1; k < r; k++) if (c[k].close < G.open) return { ok: false, at: r, reason: 'an earlier candle already closed below the green\'s open' };
  // version B: near the top of the last 30 minutes
  const atr = atrBefore(c, g, d.atrLen);
  let prevHigh = -Infinity, seen = 0;
  for (let k = g - 1; k >= 0 && seen < d.topLookback && sameDay(c[k], G); k--, seen++) prevHigh = Math.max(prevHigh, c[k].high);
  const nearTop = atr !== null && seen > 0 && G.high >= prevHigh - d.nearTopAtr * atr;
  let stop = -Infinity; for (let k = g; k <= r; k++) stop = Math.max(stop, c[k].high);
  return {
    ok: true, kind: 'failed_green', at: r, green: g, nearTop, stop,
    reason: `red closed ${fx(G.open - R.close)} pts below the green's open; ${nearTop ? 'near the 30-min top (B ✓)' : seen === 0 ? 'green was the first candle of the day (B ✗)' : `${fx(prevHigh - G.high)} pts below the 30-min top (B ✗)`}`,
  };
}

/** Opening drop whose third candle is k (first candle k-2). */
export function checkOpeningDrop(c: PC[], k: number, d = PATTERN_DRAFT): Check {
  const a = k - 2;
  if (a < 1 || k >= c.length) return { ok: false, at: k, reason: 'not enough candles' };
  const A = c[a], B = c[a + 1], C = c[k];
  if (!sameDay(A, C) || !sameDay(A, B)) return { ok: false, at: k, reason: 'spans two days' };
  if (istMin(A.time) > 9 * 60 + 20) return { ok: false, at: k, reason: 'first candle is not one of the first two of the day' };
  if (!(A.close < A.open)) return { ok: false, at: k, reason: 'first candle is not red' };
  const atr = atrBefore(c, a, d.atrLen);
  if (atr === null) return { ok: false, at: k, reason: 'not enough history for ATR' };
  if ((A.open - A.close) < d.openMinBodyAtr * atr) return { ok: false, at: k, reason: `red body ${fx((A.open - A.close) / atr)}× ATR (needs ${d.openMinBodyAtr})` };
  if (B.close > A.open) return { ok: false, at: k, reason: 'second candle closed back above the red candle\'s open' };
  if (!(C.close < C.open)) return { ok: false, at: k, reason: 'third candle is not red' };
  return { ok: true, kind: 'opening', at: k, stop: Math.max(A.high, B.high, C.high), reason: `red opening candle ${fx((A.open - A.close) / atr)}× ATR, no recovery, then red` };
}

/** Move after candle index e closes, over the next n candles of the same day. */
function moveAfter(c: PC[], e: number, n: number) {
  if (e < 0 || e >= c.length) return null;
  const base = c[e].close;
  let lo = Infinity, hi = -Infinity, last = base, cnt = 0;
  for (let k = e + 1; k < c.length && cnt < n && sameDay(c[k], c[e]); k++, cnt++) { lo = Math.min(lo, c[k].low); hi = Math.max(hi, c[k].high); last = c[k].close; }
  if (!cnt) return null;
  return { candles: cnt, maxFall: fx(base - lo), maxRise: fx(hi - base), net: fx(last - base) };
}

/** Everything about one example whose pattern starts at candle index m. */
export function analyzeExample(c: PC[], m: number, d = PATTERN_DRAFT) {
  const atr = atrBefore(c, m, d.atrLen);
  const window = c.slice(Math.max(0, m - 3), Math.min(c.length, m + 12)).filter((x) => ssIstDay(x.time) === ssIstDay(c[m].time) || x.time < c[m].time);
  const tries: Check[] = [];
  for (let r = m + 1; r <= m + 3; r++) if (r < c.length) tries.push(checkFailedGreen(c, r, d));
  if (m + 2 < c.length) tries.push(checkOpeningDrop(c, m + 2, d));
  for (const t of tries) if (t.at >= 0 && t.at < c.length) t.time = c[t.at].time;
  const hit = tries.find((t) => t.ok && t.kind === 'opening') || tries.find((t) => t.ok) || null;
  const from = hit ? hit.at : m + 2;
  return {
    atr: atr === null ? null : fx(atr),
    pattern: c.slice(m, Math.min(c.length, m + 3)),
    window,
    markedTime: c[m].time,
    after30: moveAfter(c, from, 6),
    after60: moveAfter(c, from, 12),
    hit,
    tries,
  };
}

// ---------------------------------------------------------------------------
// THE 2-YEAR TEST (rules above, frozen). Judged ONLY on days before `testTo`
// (the examples are all from Sep-Oct 2026, so they cannot grade themselves).
//
// For every signal, and for every ordinary candle as the "random" comparison:
//   * fall-first: within the next 12 candles (60 min, same day), does price drop
//     1 x ATR below the close BEFORE it rises 1 x ATR above it?
//   * the move over the next 60 minutes, in ATR units.
//   * a plain short trade: sell at the signal close, stop above the pattern's
//     high, target 2R, out by the day's close, 2 points cost.
// PASS BAR (fixed before any result): a rule passes only if its fall-first rate
// beats the random rate by more than its luck range AND the trade's average R is
// above zero by more than its luck range, with at least 60 signals.
// ---------------------------------------------------------------------------
export const PATTERN_TEST = { testTo: 20260901, horizon: 12, rr: 2, costPts: 2, minN: 60, fromMin: 9 * 60 + 15, toMin: 15 * 60 } as const;

type Sig = { idx: number; stop: number };

export function fallFirst(c: PC[], e: number, atr: number, horizon: number): boolean | null {
  const base = c[e].close;
  for (let k = e + 1, n = 0; k < c.length && n < horizon && sameDay(c[k], c[e]); k++, n++) {
    const down = c[k].low <= base - atr, up = c[k].high >= base + atr;
    if (down && up) return false;               // both inside one candle: order unknown, counted against
    if (down) return true;
    if (up) return false;
  }
  return null;                                   // neither within the horizon
}

export function runPatternTest(cIn: PC[], t = PATTERN_TEST) {
  const c = [...cIn].sort((a, b) => a.time - b.time);
  const inTest = (i: number) => ssIstDay(c[i].time) < t.testTo;
  const inHours = (i: number) => { const m = istMin(c[i].time); return m >= t.fromMin && m <= t.toMin; };
  const sigA: Sig[] = [], sigB: Sig[] = [], sigO: Sig[] = [];
  for (let i = 1; i < c.length; i++) {
    if (!inTest(i)) continue;
    const g = checkFailedGreen(c, i);
    if (g.ok && inHours(i)) { sigA.push({ idx: i, stop: g.stop! }); if (g.nearTop) sigB.push({ idx: i, stop: g.stop! }); }
    const o = checkOpeningDrop(c, i);
    if (o.ok) sigO.push({ idx: i, stop: o.stop! });
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const measure = (sigs: Sig[]) => {
    let ff = 0, ffN = 0, net = 0, netN = 0;
    for (const s of sigs) {
      const atr = atrBefore(c, s.idx); if (!atr) continue;
      const f = fallFirst(c, s.idx, atr, t.horizon);
      if (f !== null) { ffN++; if (f) ff++; }
      const mv = moveAfter(c, s.idx, t.horizon); if (mv) { net += mv.net / atr; netN++; }
    }
    const p = ffN ? ff / ffN : 0;
    return { fallFirst: r2(p * 100), fallFirstLuck: ffN ? r2(196 * Math.sqrt(p * (1 - p) / ffN)) : 0, decided: ffN, net60Atr: netN ? r2(net / netN) : 0 };
  };
  // random comparison: every ordinary candle in the same hours
  const all: Sig[] = [];
  for (let i = 15; i < c.length; i++) if (inTest(i) && inHours(i)) all.push({ idx: i, stop: c[i].high });
  const trade = (sigs: Sig[]) => {
    const entries: SsEntry[] = sigs.map((s) => ({ idx: s.idx, time: c[s.idx].time, kind: 'bear', entry: c[s.idx].close, stop: s.stop }));
    const tr = backtestEntries(c, entries, { rr: t.rr, sessionExit: true, costPts: t.costPts });
    const st = ssStats(tr); const n = tr.length;
    const sd = n > 1 ? Math.sqrt(tr.reduce((a, x) => a + (x.r - st.avgR) ** 2, 0) / (n - 1)) : 0;
    return { trades: n, winRate: r2(st.winRate * 100), avgR: r2(st.avgR), luck: n > 1 ? r2(1.96 * sd / Math.sqrt(n)) : 0 };
  };
  const days = new Set<number>(); for (let i = 0; i < c.length; i++) if (inTest(i)) days.add(ssIstDay(c[i].time));
  const base = measure(all);
  const row = (key: string, label: string, sigs: Sig[]) => {
    const m = measure(sigs), tr = trade(sigs);
    const beatsRandom = m.fallFirst - m.fallFirstLuck > base.fallFirst;
    const pays = tr.avgR - tr.luck > 0;
    const verdict = sigs.length < t.minN ? 'TOO_FEW' : beatsRandom && pays ? 'PASS' : 'NO_EDGE';
    return { key, label, signals: sigs.length, perDay: days.size ? r2(sigs.length / days.size) : 0, ...m, trade: tr, beatsRandom, pays, verdict };
  };
  const dayList = [...days].sort((a, b) => a - b);
  const fmt = (d: number) => { const s = String(d); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
  return {
    config: t,
    period: { from: dayList.length ? fmt(dayList[0]) : null, to: dayList.length ? fmt(dayList[dayList.length - 1]) : null, days: dayList.length },
    random: { ...base, candles: all.length },
    rules: [
      row('A', 'Failed green (A)', sigA),
      row('B', 'Failed green near the top (B)', sigB),
      row('O', 'Opening drop', sigO),
    ],
  };
}

// ---------------------------------------------------------------------------
// OPENING DROP — FORWARD TEST (Martin, 16 Oct 2026). The rule above, unchanged,
// graded only on days from OPENING_FWD.liveFrom (08 and 12 Oct were among his
// examples, and the 2-year test ended 31 Aug, so only days after today count).
// Each signal is graded exactly as in the 2-year test: a plain short at the third
// candle's close, stop above the three candles, 2R target, out by the day's close,
// 2 points cost; plus whether NIFTY fell 1 x ATR before rising 1 x ATR within an
// hour. Logs only — nothing is ever traded.
// ---------------------------------------------------------------------------
export const OPENING_FWD = { frozenOn: '2026-10-16', liveFrom: 20261019, minSignals: 30 } as const;

export type OpeningGraded = { time: number; day: number; entry: number; stop: number; target: number; exit: number; outcome: string; r: number; fallFirst: boolean | null };

export function gradeOpeningDrops(cIn: PC[], fromDay: number = OPENING_FWD.liveFrom): OpeningGraded[] {
  const c = [...cIn].sort((a, b) => a.time - b.time);
  const out: OpeningGraded[] = [];
  for (let k = 2; k < c.length; k++) {
    if (ssIstDay(c[k].time) < fromDay) continue;
    const o = checkOpeningDrop(c, k);
    if (!o.ok) continue;
    const entries: SsEntry[] = [{ idx: k, time: c[k].time, kind: 'bear', entry: c[k].close, stop: o.stop! }];
    const tr = backtestEntries(c, entries, { rr: PATTERN_TEST.rr, sessionExit: true, costPts: PATTERN_TEST.costPts })[0];
    if (!tr) continue;
    const atr = atrBefore(c, k);
    out.push({ time: c[k].time, day: ssIstDay(c[k].time), entry: tr.entry, stop: tr.stop, target: tr.target, exit: tr.exit, outcome: tr.outcome, r: tr.r,
      fallFirst: atr ? fallFirst(c, k, atr, PATTERN_TEST.horizon) : null });
  }
  return out;
}
