// BREAKER BLOCKS & LIQUIDITY GRABS (5 Nov 2026, Martin — from the SMC explanations
// he sent). Pure: candles in, drawings out. Nothing looks ahead: a swing point is
// only used once `swingLen` candles to its right have closed, exactly as it could
// have been seen live.
//
// BEARISH BREAKER (his Fig. 3): an uptrend makes HH → HL → HH. The BULLISH order
// block is the last down-candle at that HL (the base the rally left from). When a
// candle later CLOSES below the HL, that order block has failed: it flips into a
// bearish breaker — a resistance zone. It stays on the chart until a candle closes
// back above it (invalidated). The first time price comes back up into it (high
// reaches the zone, close stays below its top) is marked as a retest — the entry
// the explanation describes.
// BULLISH BREAKER: the mirror — a downtrend LL → LH → LL, the bearish order block
// is the last up-candle at the LH; a close above the LH flips it into support.
//
// LIQUIDITY GRAB (his "Liquidity Grab Trading Strategy"): stops gather just beyond
// an obvious level — an untaken swing high/low, or the previous day's high/low. A
// grab is a candle whose wick goes through such a level but which CLOSES back on
// the near side. A close through the level is a real break instead, and the level
// is simply used up. Each level can be grabbed once.

export interface BlCandle { time: number; open: number; high: number; low: number; close: number }
export interface BlSettings {
  swingLen: number;            // candles each side that make a swing point
  showBull: boolean; showBear: boolean;
  showInvalidated: boolean;    // keep broken breakers on the chart, faded
  maxBreakers: number;         // most recent N of each direction
  showRetest: boolean;
  showGrabs: boolean;
  grabPrevDay: boolean;        // previous day's high/low as grab levels too
  maxGrabs: number;
}
export const BL_DEFAULTS: BlSettings = {
  swingLen: 5, showBull: true, showBear: true, showInvalidated: false, maxBreakers: 6,
  showRetest: true, showGrabs: true, grabPrevDay: true, maxGrabs: 30,
};
export function normaliseBlSettings(s: any): BlSettings {
  const o = { ...BL_DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  const int = (v: any, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  o.swingLen = int(o.swingLen, 2, 20, BL_DEFAULTS.swingLen);
  o.maxBreakers = int(o.maxBreakers, 1, 30, BL_DEFAULTS.maxBreakers);
  o.maxGrabs = int(o.maxGrabs, 1, 200, BL_DEFAULTS.maxGrabs);
  for (const k of ['showBull', 'showBear', 'showInvalidated', 'showRetest', 'showGrabs', 'grabPrevDay'] as const) o[k] = !!o[k];
  return o;
}

export interface Breaker {
  dir: 'bull' | 'bear';        // bull = support (from a failed bearish OB), bear = resistance
  top: number; bottom: number;
  obTime: number;              // the order-block candle
  breakTime: number;           // the candle that closed through the swing
  swingLevel: number;          // the HL (bear) / LH (bull) that was broken
  endTime: number | null;      // invalidated at this candle (closed through the zone)
  retestTime: number | null;   // first retest after the break
}
export interface Grab {
  dir: 'bull' | 'bear';        // bull = lows were grabbed (stops below taken, close back above)
  level: number; levelTime: number; kind: 'swing' | 'prev-day';
  time: number;                // the grab candle
  extreme: number;             // its wick
}
export interface BlResult { breakers: Breaker[]; grabs: Grab[] }

const IST = 5.5 * 3600;
const istDay = (t: number) => Math.floor((t + IST) / 86400);

export function computeBreakersAndGrabs(c: BlCandle[], S: BlSettings): BlResult {
  const n = c.length, L = S.swingLen;
  const breakers: Breaker[] = [], grabs: Grab[] = [];
  if (n < 2 * L + 3) return { breakers, grabs };

  type Sw = { i: number; p: number };
  const highs: Sw[] = [], lows: Sw[] = [];
  // armed candidates waiting for their break
  let armBear: { hl: Sw; ob: number } | null = null;     // HL with its bullish OB candle index
  let armBull: { lh: Sw; ob: number } | null = null;
  const live: Breaker[] = [];
  // liquidity levels still untaken
  type Lv = { p: number; t: number; kind: 'swing' | 'prev-day'; side: 'high' | 'low' };
  let levels: Lv[] = [];
  let dayHi = -Infinity, dayLo = Infinity, curDay = istDay(c[0].time);

  const isPivotHigh = (k: number) => {
    for (let j = k - L; j <= k + L; j++) { if (j === k) continue; if (j < k ? c[j].high >= c[k].high : c[j].high > c[k].high) return false; }
    return true;
  };
  const isPivotLow = (k: number) => {
    for (let j = k - L; j <= k + L; j++) { if (j === k) continue; if (j < k ? c[j].low <= c[k].low : c[j].low < c[k].low) return false; }
    return true;
  };
  // the order block: the last opposite-colour candle at the swing (searching back from it)
  const lastDown = (k: number) => { for (let j = k; j >= Math.max(0, k - L); j--) if (c[j].close < c[j].open) return j; return k; };
  const lastUp = (k: number) => { for (let j = k; j >= Math.max(0, k - L); j--) if (c[j].close > c[j].open) return j; return k; };

  for (let t = 0; t < n; t++) {
    const b = c[t];
    // ---- new day: yesterday's high/low become liquidity levels
    const d = istDay(b.time);
    if (d !== curDay) {
      if (S.grabPrevDay && Number.isFinite(dayHi)) {
        levels = levels.filter(x => x.kind !== 'prev-day');
        levels.push({ p: dayHi, t: b.time, kind: 'prev-day', side: 'high' }, { p: dayLo, t: b.time, kind: 'prev-day', side: 'low' });
      }
      curDay = d; dayHi = -Infinity; dayLo = Infinity;
    }

    // ---- 1) breakers already on the chart: invalidation and first retest
    for (const z of live) {
      if (z.endTime !== null) continue;
      if (z.dir === 'bear') {
        if (b.close > z.top) { z.endTime = b.time; continue; }
        if (z.retestTime === null && b.time > z.breakTime && b.high >= z.bottom && b.close <= z.top) z.retestTime = b.time;
      } else {
        if (b.close < z.bottom) { z.endTime = b.time; continue; }
        if (z.retestTime === null && b.time > z.breakTime && b.low <= z.top && b.close >= z.bottom) z.retestTime = b.time;
      }
    }

    // ---- 2) the break that turns an armed order block into a breaker
    if (armBear && b.close < armBear.hl.p) {
      const o = c[armBear.ob];
      live.push({ dir: 'bear', top: o.high, bottom: o.low, obTime: o.time, breakTime: b.time, swingLevel: armBear.hl.p, endTime: null, retestTime: null });
      armBear = null;
    }
    if (armBull && b.close > armBull.lh.p) {
      const o = c[armBull.ob];
      live.push({ dir: 'bull', top: o.high, bottom: o.low, obTime: o.time, breakTime: b.time, swingLevel: armBull.lh.p, endTime: null, retestTime: null });
      armBull = null;
    }

    // ---- 3) liquidity grabs on this candle (levels known BEFORE it)
    if (S.showGrabs) {
      const keep: Lv[] = [];
      for (const lv of levels) {
        if (lv.side === 'high') {
          if (b.high > lv.p && b.close < lv.p) { grabs.push({ dir: 'bear', level: lv.p, levelTime: lv.t, kind: lv.kind, time: b.time, extreme: b.high }); continue; }
          if (b.close > lv.p) continue;                     // broken for real — used up
        } else {
          if (b.low < lv.p && b.close > lv.p) { grabs.push({ dir: 'bull', level: lv.p, levelTime: lv.t, kind: lv.kind, time: b.time, extreme: b.low }); continue; }
          if (b.close < lv.p) continue;
        }
        keep.push(lv);
      }
      levels = keep;
    }

    // ---- 4) swing point confirmed now (its candle is L bars back)
    const k = t - L;
    if (k >= L) {
      if (isPivotHigh(k)) {
        const prev = highs[highs.length - 1];
        const sw = { i: k, p: c[k].high };
        highs.push(sw);
        if (S.showGrabs) levels.push({ p: sw.p, t: c[k].time, kind: 'swing', side: 'high' });
        // bearish setup: a higher high after a higher low → that HL is armed
        const hl = lows[lows.length - 1], hlPrev = lows[lows.length - 2];
        if (prev && sw.p > prev.p && hl && hl.i > prev.i && hl.i < k && (!hlPrev || hl.p > hlPrev.p))
          armBear = { hl, ob: lastDown(hl.i) };
      }
      if (isPivotLow(k)) {
        const prev = lows[lows.length - 1];
        const sw = { i: k, p: c[k].low };
        lows.push(sw);
        if (S.showGrabs) levels.push({ p: sw.p, t: c[k].time, kind: 'swing', side: 'low' });
        // bullish setup: a lower low after a lower high → that LH is armed
        const lh = highs[highs.length - 1], lhPrev = highs[highs.length - 2];
        if (prev && sw.p < prev.p && lh && lh.i > prev.i && lh.i < k && (!lhPrev || lh.p < lhPrev.p))
          armBull = { lh, ob: lastUp(lh.i) };
      }
    }
    // keep the level list short (oldest swing levels drop off)
    if (levels.length > 40) levels = levels.slice(-40);

    dayHi = Math.max(dayHi, b.high); dayLo = Math.min(dayLo, b.low);
  }

  for (const dir of ['bull', 'bear'] as const) {
    if (dir === 'bull' ? !S.showBull : !S.showBear) continue;
    const mine = live.filter(z => z.dir === dir && (S.showInvalidated || z.endTime === null));
    breakers.push(...mine.slice(-S.maxBreakers));
  }
  return { breakers, grabs: grabs.slice(-S.maxGrabs) };
}
