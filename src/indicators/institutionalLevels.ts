// INSTITUTIONAL LEVELS — a port of Martin's TradingView indicator
// "TCI Key Institutional Levels v2.0" (Pine v6), 25 Oct 2026. That script is a
// renamed variant of LuxAlgo's Smart Money Concepts (CC BY-NC-SA 4.0): BOS is
// called "Breaker", CHoCH "Trap", strong/weak highs "Supply Zone" /
// "Institutional Selling" and so on. Ported for Martin's own, non-commercial use.
//
// PURE: candles in, drawables out. Bar by bar, in the script's own order:
//   updateTrailing → detectPivots(50 swing) → detectPivots(5 internal)
//   → detectPivots(3 equal H/L) → detectStructure(internal) → detectStructure(swing)
//   → mitigate internal order blocks.
// With the script's DEFAULT inputs, which is what is drawn: Historical mode,
// Colored, internal + swing structure (All), swing length 50, Strong/Weak lines,
// 5 internal order blocks (ATR filter, High/Low mitigation), equal highs/lows
// (3 bars, 0.1 x ATR). Off by default in the script and not ported: swing order
// blocks, swing point labels, FVGs, daily/weekly/monthly levels, premium/discount
// zones, candle colouring, alerts.
//
// Details kept exactly as the Pine runs them, because they decide WHICH bars are
// pivots and breaks:
//  • pivot test: high[len] >= ta.highest(high, len + 1)[1] (and not also a low);
//  • ta.crossover(close, level) compares with the level as it stood when the
//    previous bar was evaluated — a pivot that moves the level on this bar does
//    not count as a cross from below;
//  • the "Supply Zone"/"Demand Zone" extremes only ever widen (max/min of every
//    high/low on the chart), and their start time moves to each new swing pivot;
//  • order blocks come from the ATR-filtered high/low arrays (a bar ≥ 2 × ATR(200)
//    has its high and low swapped), indexof() = first occurrence;
//  • Pine keeps at most 500 lines / 500 labels; older ones are dropped here too.

export interface IlCandle { time: number; open: number; high: number; low: number; close: number }

export type IlTag = 'Breaker' | 'Trap';
export interface IlStructure { internal: boolean; dir: 'bull' | 'bear'; tag: IlTag; level: number; fromTime: number; toTime: number; labelTime: number }
export interface IlEqual { kind: 'high' | 'low'; fromTime: number; fromLevel: number; toTime: number; toLevel: number; labelTime: number }
export interface IlOrderBlock { dir: 'bull' | 'bear'; top: number; bottom: number; time: number }
export interface IlStrongWeak { hi: number; hiTime: number; hiLabel: string; lo: number; loTime: number; loLabel: string }
export interface IlResult { structures: IlStructure[]; equals: IlEqual[]; orderBlocks: IlOrderBlock[]; strongWeak: IlStrongWeak | null }

export const IL_COLORS = { bull: '#089981', bear: '#F23645', obBull: '#3179f5', obBear: '#f77c80' };

const BULL = 1, BEAR = -1;
const SWING_LEN = 50, INTERNAL_LEN = 5, EQ_LEN = 3, EQ_THRESH = 0.1, INT_OB_COUNT = 5, MAX_DRAWINGS = 500;

interface Pivot { level: number; prevLevel: number; used: boolean; t: number; idx: number }
const newPivot = (): Pivot => ({ level: NaN, prevLevel: NaN, used: false, t: NaN, idx: NaN });
const isNa = (x: number) => x === undefined || x === null || Number.isNaN(x);

export function computeInstitutionalLevels(candles: IlCandle[]): IlResult {
  const n = candles.length;
  const out: IlResult = { structures: [], equals: [], orderBlocks: [], strongWeak: null };
  if (n < 3) return out;
  const H = candles.map(c => c.high), L = candles.map(c => c.low), C = candles.map(c => c.close), T = candles.map(c => c.time);

  // ta.atr(200): RMA of true range, seeded with the SMA of the first 200 values.
  const atr: number[] = new Array(n).fill(NaN);
  {
    let sum = 0, prev = NaN;
    for (let i = 0; i < n; i++) {
      const tr = i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      if (i < 200) { sum += tr; if (i === 199) { prev = sum / 200; atr[i] = prev; } }
      else { prev = (prev * 199 + tr) / 200; atr[i] = prev; }
    }
  }
  const parsedHi: number[] = [], parsedLo: number[] = [];

  // highest(high, len+1)[1] / lowest — window of len+1 bars ending at i-1.
  const hiWin = (i: number, len: number) => { if (i - 1 - len < 0) return NaN; let m = -Infinity; for (let k = i - 1 - len; k <= i - 1; k++) m = Math.max(m, H[k]); return m; };
  const loWin = (i: number, len: number) => { if (i - 1 - len < 0) return NaN; let m = Infinity; for (let k = i - 1 - len; k <= i - 1; k++) m = Math.min(m, L[k]); return m; };

  const swHigh = newPivot(), swLow = newPivot(), intHigh = newPivot(), intLow = newPivot(), eqHi = newPivot(), eqLo = newPivot();
  const swTrend = { bias: 0 }, intTrend = { bias: 0 };
  const trailing = { hi: NaN, lo: NaN, hiTime: NaN, loTime: NaN };
  const intOBs: { hi: number; lo: number; t: number; bias: number }[] = [];
  // Drawing objects in creation order; Pine drops the oldest past 500.
  const drawings: ({ k: 's'; v: IlStructure } | { k: 'e'; v: IlEqual })[] = [];
  // per ta.crossover call site: the level it saw on the previous bar
  const prevLvl = { intBull: NaN, intBear: NaN, swBull: NaN, swBear: NaN };
  let sw: IlStrongWeak | null = null;

  for (let i = 0; i < n; i++) {
    const high = H[i], low = L[i], close = C[i], time = T[i];
    const base = atr[i];
    const hiVol = !isNa(base) && (high - low) >= 2 * base;
    parsedHi.push(hiVol ? low : high);
    parsedLo.push(hiVol ? high : low);

    // updateTrailing + drawStrongWeak (labels read the swing bias BEFORE this bar's structure)
    if (isNa(trailing.hi) || high > trailing.hi) { trailing.hi = high; trailing.hiTime = time; }
    if (isNa(trailing.lo) || low < trailing.lo) { trailing.lo = low; trailing.loTime = time; }
    sw = {
      hi: trailing.hi, hiTime: trailing.hiTime, hiLabel: swTrend.bias === BEAR ? 'Institutional Selling' : 'Supply Zone',
      lo: trailing.lo, loTime: trailing.loTime, loLabel: swTrend.bias === BULL ? 'Institutional Buying' : 'Demand Zone',
    };

    const detectPivots = (len: number, kind: 'swing' | 'internal' | 'eq') => {
      if (i < len) return;
      const hw = hiWin(i, len), lw = loWin(i, len);
      const newHigh = !isNa(hw) && H[i - len] >= hw;
      const newLow = !isNa(lw) && L[i - len] <= lw;
      const pivHigh = newHigh && !newLow, pivLow = newLow && !newHigh;
      if (pivLow) {
        const pp = kind === 'eq' ? eqLo : kind === 'internal' ? intLow : swLow;
        if (kind === 'eq' && !isNa(pp.level) && !isNa(base) && Math.abs(pp.level - L[i - len]) < EQ_THRESH * base) {
          drawings.push({ k: 'e', v: { kind: 'low', fromTime: pp.t, fromLevel: pp.level, toTime: T[i - len], toLevel: L[i - len],
            labelTime: T[Math.round(0.5 * (pp.idx + i - len))] } });
        }
        pp.prevLevel = pp.level; pp.level = L[i - len]; pp.used = false; pp.t = T[i - len]; pp.idx = i - len;
        if (kind === 'swing') { trailing.lo = isNa(trailing.lo) ? pp.level : Math.min(trailing.lo, pp.level); trailing.loTime = pp.t; }
      }
      if (pivHigh) {
        const pp = kind === 'eq' ? eqHi : kind === 'internal' ? intHigh : swHigh;
        if (kind === 'eq' && !isNa(pp.level) && !isNa(base) && Math.abs(pp.level - H[i - len]) < EQ_THRESH * base) {
          drawings.push({ k: 'e', v: { kind: 'high', fromTime: pp.t, fromLevel: pp.level, toTime: T[i - len], toLevel: H[i - len],
            labelTime: T[Math.round(0.5 * (pp.idx + i - len))] } });
        }
        pp.prevLevel = pp.level; pp.level = H[i - len]; pp.used = false; pp.t = T[i - len]; pp.idx = i - len;
        if (kind === 'swing') { trailing.hi = isNa(trailing.hi) ? pp.level : Math.max(trailing.hi, pp.level); trailing.hiTime = pp.t; }
      }
    };
    detectPivots(SWING_LEN, 'swing');
    detectPivots(INTERNAL_LEN, 'internal');
    detectPivots(EQ_LEN, 'eq');

    const storeOB = (pp: Pivot, bias: number) => {
      const s = pp.idx, e = i;
      if (!(e > s && s >= 0)) return;
      const src = bias === BEAR ? parsedHi : parsedLo;
      let rel = 0;
      for (let k = s + 1; k < e; k++) {
        if (bias === BEAR ? src[k] > src[s + rel] : src[k] < src[s + rel]) rel = k - s;   // strict: first occurrence wins
      }
      const fi = s + rel;
      if (intOBs.length >= 100) intOBs.pop();
      intOBs.unshift({ hi: parsedHi[fi], lo: parsedLo[fi], t: T[fi], bias });
    };

    const detectStructure = (internal: boolean) => {
      const hiPP = internal ? intHigh : swHigh, loPP = internal ? intLow : swLow, tr = internal ? intTrend : swTrend;
      // bullish
      const hiDiff = internal ? (!isNa(intHigh.level) && !isNa(swHigh.level) && intHigh.level !== swHigh.level) : true;
      let bullBreak = false;
      if (!isNa(hiPP.level)) {
        const key = internal ? 'intBull' : 'swBull';
        const prev = prevLvl[key];
        const cross = i > 0 && close > hiPP.level && !isNa(prev) && C[i - 1] <= prev;
        prevLvl[key] = hiPP.level;
        bullBreak = cross && !hiPP.used && hiDiff;
      } else prevLvl[internal ? 'intBull' : 'swBull'] = NaN;
      if (bullBreak) {
        const tag: IlTag = tr.bias === BEAR ? 'Trap' : 'Breaker';
        hiPP.used = true; tr.bias = BULL;
        drawings.push({ k: 's', v: { internal, dir: 'bull', tag, level: hiPP.level, fromTime: hiPP.t, toTime: time,
          labelTime: T[Math.round(0.5 * (hiPP.idx + i))] } });
        if (internal) storeOB(hiPP, BULL);
      }
      // bearish
      const loDiff = internal ? (!isNa(intLow.level) && !isNa(swLow.level) && intLow.level !== swLow.level) : true;
      let bearBreak = false;
      if (!isNa(loPP.level)) {
        const key = internal ? 'intBear' : 'swBear';
        const prev = prevLvl[key];
        const cross = i > 0 && close < loPP.level && !isNa(prev) && C[i - 1] >= prev;
        prevLvl[key] = loPP.level;
        bearBreak = cross && !loPP.used && loDiff;
      } else prevLvl[internal ? 'intBear' : 'swBear'] = NaN;
      if (bearBreak) {
        const tag: IlTag = tr.bias === BULL ? 'Trap' : 'Breaker';
        loPP.used = true; tr.bias = BEAR;
        drawings.push({ k: 's', v: { internal, dir: 'bear', tag, level: loPP.level, fromTime: loPP.t, toTime: time,
          labelTime: T[Math.round(0.5 * (loPP.idx + i))] } });
        if (internal) storeOB(loPP, BEAR);
      }
    };
    detectStructure(true);
    detectStructure(false);

    // mitigate internal order blocks (High/Low)
    for (let k = 0; k < intOBs.length;) {
      const ob = intOBs[k];
      if ((ob.bias === BEAR && high > ob.hi) || (ob.bias === BULL && low < ob.lo)) intOBs.splice(k, 1);
      else k++;
    }
  }

  const kept = drawings.slice(-MAX_DRAWINGS);
  for (const d of kept) { if (d.k === 's') out.structures.push(d.v); else out.equals.push(d.v); }
  out.orderBlocks = intOBs.slice(0, INT_OB_COUNT).map(ob => ({ dir: ob.bias === BULL ? 'bull' : 'bear', top: ob.hi, bottom: ob.lo, time: ob.t }));
  out.strongWeak = sw;
  return out;
}
