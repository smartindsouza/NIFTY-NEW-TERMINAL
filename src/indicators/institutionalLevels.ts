// INSTITUTIONAL LEVELS — a port of Martin's TradingView indicator
// "TCI Key Institutional Levels v2.0" (Pine v6), 25 Oct 2026. That script is a
// renamed variant of LuxAlgo's Smart Money Concepts (CC BY-NC-SA 4.0): BOS is
// called "Breaker", CHoCH "Trap", strong/weak highs "Supply Zone" /
// "Institutional Selling" and so on. Ported for Martin's own, non-commercial use.
//
// PURE: candles + the script's inputs in, drawables out. Every input of the
// TradingView settings panel exists here with the same default (IL_DEFAULTS), and
// the bar loop runs in the script's own order:
//   candle colour (bias at the START of the bar) → updateTrailing / Strong-Weak /
//   Premium-Discount → purge FVGs → pivots (swing, internal, equal H/L)
//   → structure (internal, then swing) → mitigate OBs → detect FVGs
//   → (last bar) order-block boxes and daily/weekly/monthly levels.
//
// Kept exactly as Pine runs it, because these decide WHICH bars are pivots and breaks:
//  • pivot test: high[len] >= ta.highest(high, len + 1)[1] (and not also a low);
//  • ta.crossover(close, level) compares with the level as it stood when the
//    previous bar was evaluated — a pivot that moves the level on this bar does not
//    count as a cross from below; a call site that does not run on a bar (its block
//    switched off) never updates;
//  • the "Supply Zone"/"Demand Zone" extremes only ever widen, and their start time
//    moves to each new swing pivot;
//  • order blocks come from the volatility-filtered high/low arrays (a bar of
//    ≥ 2 × ATR(200), or 2 × cumulative mean range, has its high and low swapped),
//    indexof() = first occurrence;
//  • "Present" keeps only the newest drawing of each kind, as the script deletes the
//    previous one; "Historical" keeps 500 lines / 500 labels / 500 boxes, as Pine does.

export interface IlCandle { time: number; open: number; high: number; low: number; close: number }

export type IlFilter = 'All' | 'Breaker' | 'Trap';
export type IlSize = 'tiny' | 'small' | 'normal';
export type IlLineStyle = 0 | 1 | 2;                    // solid | dashed | dotted
export interface IlFill { color: string; opacity: number }   // opacity 0-100
export interface IlSettings {
  mode: 'Historical' | 'Present'; style: 'Colored' | 'Monochrome'; colorCandles: boolean;
  showInternal: boolean; intBullFilt: IlFilter; intBullColor: string; intBearFilt: IlFilter; intBearColor: string;
  intConfl: boolean; intLblSz: IlSize;
  showSwing: boolean; swBullFilt: IlFilter; swBullColor: string; swBearFilt: IlFilter; swBearColor: string;
  swLblSz: IlSize; showSwPts: boolean; swLength: number; showStrWeak: boolean;
  showIntOB: boolean; intOBCnt: number; showSwOB: boolean; swOBCnt: number;
  obFilt: 'Atr' | 'Cumulative Mean Range'; obMit: 'Close' | 'High/Low';
  intBullOB: IlFill; intBearOB: IlFill; swBullOB: IlFill; swBearOB: IlFill;
  showEqHL: boolean; eqLen: number; eqThresh: number; eqLblSz: IlSize;
  showFVG: boolean; fvgAuto: boolean; fvgTF: string; fvgBull: IlFill; fvgBear: IlFill; fvgExtend: number;
  showDaily: boolean; dailyStyle: IlLineStyle; dailyColor: string;
  showWeekly: boolean; weeklyStyle: IlLineStyle; weeklyColor: string;
  showMonthly: boolean; monthlyStyle: IlLineStyle; monthlyColor: string;
  showZones: boolean; premColor: string; equilColor: string; discColor: string;
}

// The script's own defaults — what the TradingView panel shows on "Defaults".
export const IL_DEFAULTS: IlSettings = {
  mode: 'Historical', style: 'Colored', colorCandles: false,
  showInternal: true, intBullFilt: 'All', intBullColor: '#089981', intBearFilt: 'All', intBearColor: '#F23645',
  intConfl: false, intLblSz: 'tiny',
  showSwing: true, swBullFilt: 'All', swBullColor: '#089981', swBearFilt: 'All', swBearColor: '#F23645',
  swLblSz: 'small', showSwPts: false, swLength: 50, showStrWeak: true,
  showIntOB: true, intOBCnt: 5, showSwOB: false, swOBCnt: 5,
  obFilt: 'Atr', obMit: 'High/Low',
  intBullOB: { color: '#3179f5', opacity: 20 }, intBearOB: { color: '#f77c80', opacity: 20 },
  swBullOB: { color: '#1848cc', opacity: 20 }, swBearOB: { color: '#b22833', opacity: 20 },
  showEqHL: true, eqLen: 3, eqThresh: 0.1, eqLblSz: 'tiny',
  showFVG: false, fvgAuto: true, fvgTF: 'Chart', fvgBull: { color: '#00ff68', opacity: 30 }, fvgBear: { color: '#ff0008', opacity: 30 }, fvgExtend: 1,
  showDaily: false, dailyStyle: 0, dailyColor: '#2157f3',
  showWeekly: false, weeklyStyle: 0, weeklyColor: '#2157f3',
  showMonthly: false, monthlyStyle: 0, monthlyColor: '#2157f3',
  showZones: false, premColor: '#F23645', equilColor: '#878b94', discColor: '#089981',
};

/** Settings as saved, merged over the defaults and clamped to the script's ranges. */
export function normaliseIlSettings(raw: any): IlSettings {
  const s: IlSettings = { ...IL_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const int = (v: any, lo: number, hi: number, d: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  s.swLength = int(s.swLength, 10, 500, 50);
  s.intOBCnt = int(s.intOBCnt, 1, 20, 5);
  s.swOBCnt = int(s.swOBCnt, 1, 20, 5);
  s.eqLen = int(s.eqLen, 1, 100, 3);
  const th = Number(s.eqThresh); s.eqThresh = Number.isFinite(th) ? Math.min(0.5, Math.max(0, th)) : 0.1;
  s.fvgExtend = int(s.fvgExtend, 0, 500, 1);
  return s;
}

/** Colours after the Style input: Monochrome replaces them as the script does. */
export function ilColors(s: IlSettings) {
  const mono = s.style === 'Monochrome';
  const f = (fill: IlFill, monoHex: string): IlFill => mono ? { color: monoHex, opacity: fill.opacity } : fill;
  return {
    swBull: mono ? '#b2b5be' : s.swBullColor, swBear: mono ? '#5d606b' : s.swBearColor,
    intBull: mono ? '#b2b5be' : s.intBullColor, intBear: mono ? '#5d606b' : s.intBearColor,
    fvgBull: f(s.fvgBull, '#b2b5be'), fvgBear: f(s.fvgBear, '#5d606b'),
    prem: mono ? '#5d606b' : s.premColor, disc: mono ? '#b2b5be' : s.discColor, equil: s.equilColor,
    obIntBull: f(s.intBullOB, '#b2b5be'), obIntBear: f(s.intBearOB, '#5d606b'),
    obSwBull: f(s.swBullOB, '#b2b5be'), obSwBear: f(s.swBearOB, '#5d606b'),
  };
}
export const IL_FONT_PX: Record<IlSize, number> = { tiny: 9, small: 11, normal: 13 };

export type IlTag = 'Breaker' | 'Trap';
export interface IlStructure { internal: boolean; dir: 'bull' | 'bear'; tag: IlTag; level: number; fromTime: number; toTime: number; labelTime: number; line: boolean; label: boolean }
export interface IlEqual { kind: 'high' | 'low'; fromTime: number; fromLevel: number; toTime: number; toLevel: number; labelTime: number; line: boolean; label: boolean }
export interface IlSwingPoint { kind: 'high' | 'low'; time: number; level: number; text: 'HH' | 'LH' | 'HL' | 'LL' }
export interface IlOrderBlock { internal: boolean; dir: 'bull' | 'bear'; top: number; bottom: number; time: number }
// top/bottom are the script's own fields (for a bearish gap "top" is the LOWER
// edge, h0, and "bottom" the upper, l2) — they decide when a gap is filled: a
// bullish one when a low goes under its bottom, a bearish one when a high goes over
// its top. Draw with min/max.
export interface IlFvg { dir: 'bull' | 'bear'; top: number; bottom: number; mid: number; leftTime: number; rightTime: number }
export interface IlStrongWeak { hi: number; hiTime: number; hiLabel: string; lo: number; loTime: number; loLabel: string }
export interface IlMtf { tf: 'D' | 'W' | 'M'; hi: number; hiTime: number; lo: number; loTime: number }
export interface IlZones { hi: number; lo: number; fromTime: number; toTime: number }
export interface IlResult {
  structures: IlStructure[]; equals: IlEqual[]; swingPoints: IlSwingPoint[]; orderBlocks: IlOrderBlock[];
  fvgs: IlFvg[]; strongWeak: IlStrongWeak | null; mtf: IlMtf[]; zones: IlZones | null;
  candleBull: boolean[];        // per input candle, for Color Candles (trend at the start of the bar)
}

const BULL = 1, BEAR = -1, MAX_DRAWINGS = 500;
interface Pivot { level: number; prevLevel: number; used: boolean; t: number; idx: number }
const newPivot = (): Pivot => ({ level: NaN, prevLevel: NaN, used: false, t: NaN, idx: NaN });
const isNa = (x: number) => x === undefined || x === null || Number.isNaN(x);
const IST = 5.5 * 3600;

// Higher-timeframe buckets for the FVG "Timeframe" input. NSE intraday bars are
// anchored at the 09:15 session open, as TradingView builds them.
function tfBucket(tf: string, t: number): number {
  const ist = t + IST, day = Math.floor(ist / 86400), sec = ist - day * 86400;
  if (tf === '1D') return day;
  const m = parseInt(tf, 10);
  if (!(m > 0)) return t;
  return day * 10000 + Math.floor((sec - (9 * 3600 + 15 * 60)) / (m * 60));
}
const tfSeconds = (tf: string) => tf === '1D' ? 86400 : (parseInt(tf, 10) || 0) * 60;

export function computeInstitutionalLevels(candles: IlCandle[], rawSettings?: Partial<IlSettings>, chartTfSec = 300): IlResult {
  const S = normaliseIlSettings(rawSettings);
  const n = candles.length;
  const out: IlResult = { structures: [], equals: [], swingPoints: [], orderBlocks: [], fvgs: [], strongWeak: null, mtf: [], zones: null, candleBull: [] };
  if (n < 3) return out;
  const O = candles.map(c => c.open), H = candles.map(c => c.high), L = candles.map(c => c.low), C = candles.map(c => c.close), T = candles.map(c => c.time);

  // ta.atr(200): RMA of true range, seeded with the SMA of the first 200 values.
  // Cumulative mean range: ta.cum(ta.tr) / bar_index (ta.tr is na on the first bar).
  const vol: number[] = new Array(n).fill(NaN);
  const atr: number[] = new Array(n).fill(NaN);
  {
    let sum = 0, prev = NaN, cum = 0;
    for (let i = 0; i < n; i++) {
      const tr = i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      if (i < 200) { sum += tr; if (i === 199) { prev = sum / 200; atr[i] = prev; } }
      else { prev = (prev * 199 + tr) / 200; atr[i] = prev; }
      if (i > 0) cum += tr;
      vol[i] = S.obFilt === 'Atr' ? atr[i] : (i > 0 ? cum / i : NaN);
    }
  }
  const parsedHi: number[] = [], parsedLo: number[] = [];

  const hiWin = (i: number, len: number) => { if (i - 1 - len < 0) return NaN; let m = -Infinity; for (let k = i - 1 - len; k <= i - 1; k++) m = Math.max(m, H[k]); return m; };
  const loWin = (i: number, len: number) => { if (i - 1 - len < 0) return NaN; let m = Infinity; for (let k = i - 1 - len; k <= i - 1; k++) m = Math.min(m, L[k]); return m; };

  const swHigh = newPivot(), swLow = newPivot(), intHigh = newPivot(), intLow = newPivot(), eqHi = newPivot(), eqLo = newPivot();
  const swTrend = { bias: 0 }, intTrend = { bias: 0 };
  const trailing = { hi: NaN, lo: NaN, hiTime: NaN, loTime: NaN, lastTime: NaN };
  const intOBs: { hi: number; lo: number; t: number; bias: number }[] = [];
  const swOBs: { hi: number; lo: number; t: number; bias: number }[] = [];
  const fvgs: (IlFvg & { seq: number })[] = [];
  let fvgSeq = 0;

  // Drawings in creation order. Pine keeps separate 500-object pools for lines and
  // labels; "Present" deletes the previous object of the same call site.
  type Drawing = { site: string; seq: number } & ({ k: 's'; v: IlStructure } | { k: 'e'; v: IlEqual } | { k: 'p'; v: IlSwingPoint });
  const drawings: Drawing[] = [];
  let seq = 0;
  const present = S.mode === 'Present';
  const add = (d: Drawing) => {
    if (present) { const j = drawings.findIndex(x => x.site === d.site); if (j >= 0) drawings.splice(j, 1); }
    drawings.push(d);
  };

  const prevLvl: Record<string, number> = { intBull: NaN, intBear: NaN, swBull: NaN, swBear: NaN };
  let sw: IlStrongWeak | null = null;
  let zones: IlZones | null = null;
  let fvgCumAbs = 0;
  let prevBucket = NaN;
  // HTF candles built from the chart's (for the FVG timeframe input)
  const htf: { t: number; o: number; h: number; l: number; c: number }[] = [];
  const fvgTF = S.fvgTF && S.fvgTF !== 'Chart' && tfSeconds(S.fvgTF) > chartTfSec ? S.fvgTF : 'Chart';

  for (let i = 0; i < n; i++) {
    const open = O[i], high = H[i], low = L[i], close = C[i], time = T[i];
    const hiVol = !isNa(vol[i]) && (high - low) >= 2 * vol[i];
    parsedHi.push(hiVol ? low : high);
    parsedLo.push(hiVol ? high : low);
    out.candleBull.push(intTrend.bias === BULL);
    const bearMit = S.obMit === 'Close' ? close : high, bullMit = S.obMit === 'Close' ? close : low;

    if (S.showStrWeak || S.showZones) {
      if (isNa(trailing.hi) || high > trailing.hi) { trailing.hi = high; trailing.hiTime = time; }
      if (isNa(trailing.lo) || low < trailing.lo) { trailing.lo = low; trailing.loTime = time; }
      trailing.lastTime = time;
      if (S.showStrWeak) sw = {
        hi: trailing.hi, hiTime: trailing.hiTime, hiLabel: swTrend.bias === BEAR ? 'Institutional Selling' : 'Supply Zone',
        lo: trailing.lo, loTime: trailing.loTime, loLabel: swTrend.bias === BULL ? 'Institutional Buying' : 'Demand Zone',
      };
      if (S.showZones && !isNa(trailing.hi) && !isNa(trailing.lo)) zones = { hi: trailing.hi, lo: trailing.lo, fromTime: trailing.lastTime, toTime: time };
    }

    if (S.showFVG) {
      for (let k = 0; k < fvgs.length;) {
        const g = fvgs[k];
        if ((g.dir === 'bull' && low < g.bottom) || (g.dir === 'bear' && high > g.top)) fvgs.splice(k, 1); else k++;
      }
    }

    const base = atr[i];
    const detectPivots = (len: number, kind: 'swing' | 'internal' | 'eq') => {
      if (i < len) return;
      const hw = hiWin(i, len), lw = loWin(i, len);
      const newHigh = !isNa(hw) && H[i - len] >= hw;
      const newLow = !isNa(lw) && L[i - len] <= lw;
      const pivHigh = newHigh && !newLow, pivLow = newLow && !newHigh;
      if (pivLow) {
        const pp = kind === 'eq' ? eqLo : kind === 'internal' ? intLow : swLow;
        if (kind === 'eq' && !isNa(pp.level) && !isNa(base) && Math.abs(pp.level - L[i - len]) < S.eqThresh * base) {
          add({ site: 'eq-low', seq: seq++, k: 'e', v: { kind: 'low', fromTime: pp.t, fromLevel: pp.level, toTime: T[i - len], toLevel: L[i - len],
            labelTime: T[Math.round(0.5 * (pp.idx + i - len))], line: true, label: true } });
        }
        pp.prevLevel = pp.level; pp.level = L[i - len]; pp.used = false; pp.t = T[i - len]; pp.idx = i - len;
        if (kind === 'swing') {
          trailing.lo = isNa(trailing.lo) ? pp.level : Math.min(trailing.lo, pp.level); trailing.loTime = pp.t;
          if (S.showSwPts) add({ site: 'sp-low', seq: seq++, k: 'p', v: { kind: 'low', time: pp.t, level: pp.level, text: !isNa(pp.prevLevel) && pp.level < pp.prevLevel ? 'LL' : 'HL' } });
        }
      }
      if (pivHigh) {
        const pp = kind === 'eq' ? eqHi : kind === 'internal' ? intHigh : swHigh;
        if (kind === 'eq' && !isNa(pp.level) && !isNa(base) && Math.abs(pp.level - H[i - len]) < S.eqThresh * base) {
          add({ site: 'eq-high', seq: seq++, k: 'e', v: { kind: 'high', fromTime: pp.t, fromLevel: pp.level, toTime: T[i - len], toLevel: H[i - len],
            labelTime: T[Math.round(0.5 * (pp.idx + i - len))], line: true, label: true } });
        }
        pp.prevLevel = pp.level; pp.level = H[i - len]; pp.used = false; pp.t = T[i - len]; pp.idx = i - len;
        if (kind === 'swing') {
          trailing.hi = isNa(trailing.hi) ? pp.level : Math.max(trailing.hi, pp.level); trailing.hiTime = pp.t;
          if (S.showSwPts) add({ site: 'sp-high', seq: seq++, k: 'p', v: { kind: 'high', time: pp.t, level: pp.level, text: !isNa(pp.prevLevel) && pp.level > pp.prevLevel ? 'HH' : 'LH' } });
        }
      }
    };
    detectPivots(S.swLength, 'swing');
    detectPivots(5, 'internal');
    if (S.showEqHL) detectPivots(S.eqLen, 'eq');

    const storeOB = (pp: Pivot, internal: boolean, bias: number) => {
      if (!((internal && S.showIntOB) || (!internal && S.showSwOB))) return;
      const s = pp.idx, e = i;
      if (!(e > s && s >= 0)) return;
      const src = bias === BEAR ? parsedHi : parsedLo;
      let rel = 0;
      for (let k = s + 1; k < e; k++) if (bias === BEAR ? src[k] > src[s + rel] : src[k] < src[s + rel]) rel = k - s;
      const fi = s + rel;
      const lst = internal ? intOBs : swOBs;
      if (lst.length >= 100) lst.pop();
      lst.unshift({ hi: parsedHi[fi], lo: parsedLo[fi], t: T[fi], bias });
    };
    const passes = (filt: IlFilter, tag: IlTag) => filt === 'All' || filt === tag;

    const detectStructure = (internal: boolean) => {
      let candleUp = true, candleDn = true;
      if (S.intConfl && internal) {
        const uw = high - Math.max(close, open), lw = Math.min(close, open) - low;
        candleUp = uw > lw; candleDn = uw < lw;
      }
      const hiPP = internal ? intHigh : swHigh, loPP = internal ? intLow : swLow, tr = internal ? intTrend : swTrend;
      // bullish
      const hiDiff = internal ? (!isNa(intHigh.level) && !isNa(swHigh.level) && intHigh.level !== swHigh.level) : true;
      const kb = internal ? 'intBull' : 'swBull';
      let bullBreak = false;
      if (!isNa(hiPP.level)) {
        const cross = i > 0 && close > hiPP.level && !isNa(prevLvl[kb]) && C[i - 1] <= prevLvl[kb];
        prevLvl[kb] = hiPP.level;
        bullBreak = cross && !hiPP.used && hiDiff && candleUp;
      } else prevLvl[kb] = NaN;
      if (bullBreak) {
        const tag: IlTag = tr.bias === BEAR ? 'Trap' : 'Breaker';
        hiPP.used = true; tr.bias = BULL;
        const show = internal ? S.showInternal && passes(S.intBullFilt, tag) : S.showSwing && passes(S.swBullFilt, tag);
        if (show) add({ site: internal ? 'int-bull' : 'sw-bull', seq: seq++, k: 's', v: { internal, dir: 'bull', tag, level: hiPP.level, fromTime: hiPP.t, toTime: time,
          labelTime: T[Math.round(0.5 * (hiPP.idx + i))], line: true, label: true } });
        storeOB(hiPP, internal, BULL);
      }
      // bearish
      const loDiff = internal ? (!isNa(intLow.level) && !isNa(swLow.level) && intLow.level !== swLow.level) : true;
      const kr = internal ? 'intBear' : 'swBear';
      let bearBreak = false;
      if (!isNa(loPP.level)) {
        const cross = i > 0 && close < loPP.level && !isNa(prevLvl[kr]) && C[i - 1] >= prevLvl[kr];
        prevLvl[kr] = loPP.level;
        bearBreak = cross && !loPP.used && loDiff && candleDn;
      } else prevLvl[kr] = NaN;
      if (bearBreak) {
        const tag: IlTag = tr.bias === BULL ? 'Trap' : 'Breaker';
        loPP.used = true; tr.bias = BEAR;
        const show = internal ? S.showInternal && passes(S.intBearFilt, tag) : S.showSwing && passes(S.swBearFilt, tag);
        if (show) add({ site: internal ? 'int-bear' : 'sw-bear', seq: seq++, k: 's', v: { internal, dir: 'bear', tag, level: loPP.level, fromTime: loPP.t, toTime: time,
          labelTime: T[Math.round(0.5 * (loPP.idx + i))], line: true, label: true } });
        storeOB(loPP, internal, BEAR);
      }
    };
    if (S.showInternal || S.showIntOB || S.colorCandles) detectStructure(true);
    if (S.showSwing || S.showSwOB || S.showStrWeak) detectStructure(false);

    const mitigate = (lst: { hi: number; lo: number; t: number; bias: number }[]) => {
      for (let k = 0; k < lst.length;) {
        const ob = lst[k];
        if ((ob.bias === BEAR && bearMit > ob.hi) || (ob.bias === BULL && bullMit < ob.lo)) lst.splice(k, 1); else k++;
      }
    };
    if (S.showIntOB) mitigate(intOBs);
    if (S.showSwOB) mitigate(swOBs);

    // FAIR VALUE GAPS: request.security(tf, [close[1], open[1], time[1], high, low,
    // time, high[2], low[2]], lookahead_on) — on the chart timeframe that is simply
    // the last three bars; on a higher one, the HTF bar this chart bar belongs to
    // (its final high/low once it is complete, as lookahead_on gives on history)
    // and the two before it. timeframe.change() is true on every chart bar for the
    // chart timeframe, else on the first chart bar of each HTF bar.
    if (S.showFVG) {
      let c1: number, o1: number, t1: number, h0: number, l0: number, t0: number, h2: number, l2: number, ntf: boolean;
      if (fvgTF === 'Chart') {
        ntf = true;
        c1 = i >= 1 ? C[i - 1] : NaN; o1 = i >= 1 ? O[i - 1] : NaN; t1 = i >= 1 ? T[i - 1] : NaN;
        h0 = high; l0 = low; t0 = time; h2 = i >= 2 ? H[i - 2] : NaN; l2 = i >= 2 ? L[i - 2] : NaN;
      } else {
        const b = tfBucket(fvgTF, time);
        ntf = b !== prevBucket; prevBucket = b;
        if (ntf) {
          // the whole HTF bar (lookahead): scan ahead over its chart bars
          let hh = high, ll = low, cc = close, k = i;
          while (k + 1 < n && tfBucket(fvgTF, T[k + 1]) === b) { k++; hh = Math.max(hh, H[k]); ll = Math.min(ll, L[k]); cc = C[k]; }
          htf.push({ t: time, o: open, h: hh, l: ll, c: cc });
        }
        const m = htf.length - 1;
        const cur = htf[m], p1 = htf[m - 1], p2 = htf[m - 2];
        c1 = p1 ? p1.c : NaN; o1 = p1 ? p1.o : NaN; t1 = p1 ? p1.t : NaN;
        h0 = cur.h; l0 = cur.l; t0 = cur.t; h2 = p2 ? p2.h : NaN; l2 = p2 ? p2.l : NaN;
      }
      const dp = (c1 - o1) / (o1 * 100);
      if (ntf && !isNa(dp)) fvgCumAbs += Math.abs(dp);
      const thr = S.fvgAuto ? (i > 0 ? fvgCumAbs / i * 2 : NaN) : 0;
      const span = i >= 1 ? time - T[i - 1] : 0;
      const bullG = ntf && !isNa(h2) && l0 > h2 && c1 > h2 && !isNa(thr) && dp > thr;
      const bearG = ntf && !isNa(l2) && h0 < l2 && c1 < l2 && !isNa(thr) && -dp > thr;
      if (bullG) fvgs.unshift({ dir: 'bull', top: l0, bottom: h2, mid: (l0 + h2) / 2, leftTime: t1, rightTime: t0 + S.fvgExtend * span, seq: fvgSeq++ });
      if (bearG) fvgs.unshift({ dir: 'bear', top: h0, bottom: l2, mid: (h0 + l2) / 2, leftTime: t1, rightTime: t0 + S.fvgExtend * span, seq: fvgSeq++ });
    }
  }

  // Pine pools: last 500 lines (structure + equal) and last 500 labels (+ swing points).
  const lineSeqs = drawings.filter(d => d.k !== 'p').map(d => d.seq).slice(-MAX_DRAWINGS);
  const labelSeqs = drawings.map(d => d.seq).slice(-MAX_DRAWINGS);
  const lineSet = new Set(lineSeqs), labelSet = new Set(labelSeqs);
  for (const d of drawings) {
    if (d.k === 's') { const v = { ...d.v, line: lineSet.has(d.seq), label: labelSet.has(d.seq) }; if (v.line || v.label) out.structures.push(v); }
    else if (d.k === 'e') { const v = { ...d.v, line: lineSet.has(d.seq), label: labelSet.has(d.seq) }; if (v.line || v.label) out.equals.push(v); }
    else if (labelSet.has(d.seq)) out.swingPoints.push(d.v);
  }
  if (S.showIntOB) for (const ob of intOBs.slice(0, S.intOBCnt)) out.orderBlocks.push({ internal: true, dir: ob.bias === BULL ? 'bull' : 'bear', top: ob.hi, bottom: ob.lo, time: ob.t });
  if (S.showSwOB) for (const ob of swOBs.slice(0, S.swOBCnt)) out.orderBlocks.push({ internal: false, dir: ob.bias === BULL ? 'bull' : 'bear', top: ob.hi, bottom: ob.lo, time: ob.t });
  // FVG boxes: 2 per gap, and the box pool also holds the order-block boxes
  const fvgCap = Math.max(0, Math.floor((MAX_DRAWINGS - (S.showIntOB ? S.intOBCnt : 0) - (S.showSwOB ? S.swOBCnt : 0) - (S.showZones ? 3 : 0)) / 2));
  out.fvgs = fvgs.slice(0, fvgCap).map(({ seq: _s, ...g }) => g);
  out.strongWeak = S.showStrWeak ? sw : null;
  out.zones = S.showZones ? zones : null;

  // DAILY / WEEKLY / MONTHLY: the previous period's high and low, each line from the
  // bar that made it. Skipped when the chart's timeframe is above that period.
  const last = n - 1;
  const periodKey = (tf: 'D' | 'W' | 'M', t: number) => {
    const d = new Date((t + IST) * 1000);
    if (tf === 'D') return Math.floor((t + IST) / 86400);
    if (tf === 'M') return d.getUTCFullYear() * 12 + d.getUTCMonth();
    const day = Math.floor((t + IST) / 86400);              // weeks start Monday
    return Math.floor((day - 4) / 7);                        // 1970-01-05 was a Monday → day 4
  };
  const periodSec = { D: 86400, W: 7 * 86400, M: 30 * 86400 } as const;   // the app's 1D / 1W / 1M
  for (const [tf, on] of [['D', S.showDaily], ['W', S.showWeekly], ['M', S.showMonthly]] as ['D' | 'W' | 'M', boolean][]) {
    if (!on || chartTfSec > periodSec[tf]) continue;
    if (chartTfSec >= periodSec[tf]) {                       // the chart IS this timeframe
      out.mtf.push({ tf, hi: H[last], hiTime: T[last], lo: L[last], loTime: T[last] });
      continue;
    }
    const curKey = periodKey(tf, T[last]);
    let j = last; while (j >= 0 && periodKey(tf, T[j]) === curKey) j--;
    if (j < 0) continue;
    const prevKey = periodKey(tf, T[j]);
    let hi = -Infinity, lo = Infinity, hiT = T[0], loT = T[0];
    let start = j; while (start - 1 >= 0 && periodKey(tf, T[start - 1]) === prevKey) start--;
    for (let k = start; k <= j; k++) {
      if (H[k] > hi) { hi = H[k]; hiT = T[k]; }
      if (L[k] < lo) { lo = L[k]; loT = T[k]; }
    }
    out.mtf.push({ tf, hi, hiTime: hiT, lo, loTime: loT });
  }
  return out;
}
