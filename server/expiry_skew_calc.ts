// EXPIRY SKEW — the calculation (14 Nov 2026, Martin). Pure: numbers in, numbers out.
// No network, no database, no clock. server/expiry_skew.ts feeds it and acts on it.
//
// WHAT THIS IS. Martin asked for his own indicator after every chart-pattern rule
// in this project failed its test. This is the one reading that survived: it was
// fitted on NIFTY Nov 2022 – Nov 2026, frozen, and then run once on Nov 2020 –
// Nov 2022, which it had never seen (144 trades, +₹1,70,930 per lot, t 2.70; the
// write-up is the project doc "option-strategy-search-nov-2026"). It is still a
// candidate, not a proven edge — which is exactly why it runs in Practice only.
//
// WHY EVERY LINE HERE MIRRORS THE RESEARCH CODE. A forward test only means
// something if the live number is the SAME number the backtest traded on. So this
// file is a port of the Python that produced the result (of.py chain_feats +
// standardise, fs.py trades, au4.py for the implied volatility), including its
// quirks, and server/expiry_skew.test.ts checks it against that Python's own
// output on real option files. Do not "improve" a formula here: a better formula
// is a different rule, and a different rule has no test behind it.
//
// THE READING, every 5 minutes, nearest weekly expiry (bar b closes at minute
// m = (b + 1) * 5 after 09:15; decisions on bars 8…62 = 10:00 AM … 2:30 PM):
//   skew        IV of the put 200 below ATM minus IV of the call 200 above ATM
//   oi_imb30    (put OI added − call OI added over 30 min) / (put OI + call OI)
//   oi_imb_day  the same since the 09:25–09:30 bar
//   vol_imb30   (call volume − put volume) / total, last 30 min
// the last three over strikes ATM−5 … ATM+5. Each is scored against its own mean
// and spread over the PREVIOUS 60 trading days (every bar of those days, never
// today), clipped to ±4. flow = mean of the three scores; signal = (skew score +
// flow) / 2. First bar of the day with |signal| ≥ 1.5 is the trade.

export const MINUTES = 375;                 // 09:15 … 15:29, one slot a minute
export const BUCKETS = 75;                  // 5-minute buckets
export const FIRST_BAR = 8, LAST_BAR = 62;  // decisions at 10:00 AM … 2:30 PM
export const STEP = 50, SPAN = 5, SKEW_DIST = 200;
export const THRESHOLD = 1.5, ITM_POINTS = 200, EXIT_MINUTE = 360;   // 3:15 PM
export const WINDOW_DAYS = 60, MIN_DAYS = 20, CLIP = 4;
export const FEATS = ['skew', 'oi_imb30', 'oi_imb_day', 'vol_imb30'] as const;
export type Feat = typeof FEATS[number];

// ---------------------------------------------------------------- small maths
/** Python's round(): halves go to the EVEN integer. The research picked the ATM
 *  strike with round(spot / 50) * 50, so at an exact x.5 (spot 25,225.00) Python
 *  and Math.round disagree by a whole strike — and a strike apart is a different
 *  pair of skew options. Rare, but it must not be a coin toss between the two. */
export function pyRound(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
export const atmOf = (spot: number) => pyRound(spot / STEP) * STEP;

/** Complementary error function for z ≥ 0, accurate to about 1e-13 relative.
 *  WHY NOT server/options_math.ts normCDF: that is the usual 7-digit polynomial,
 *  fine for a delta on screen. Here the options are 200 points out with a few
 *  hours left — a put worth ₹2 sits about three standard deviations out, where a
 *  1e-7 error in the tail is a visible fraction of the price and the solved
 *  volatility drifts off the research's scipy value. Series below 3 (all terms
 *  positive, so nothing cancels), continued fraction above it. */
function erfc(z: number): number {
  if (z < 3) {
    let term = z, sum = z;
    for (let n = 1; n < 400; n++) { term *= (2 * z * z) / (2 * n + 1); sum += term; if (term < sum * 1e-17) break; }
    return 1 - (2 / Math.sqrt(Math.PI)) * Math.exp(-z * z) * sum;
  }
  let t = z;
  for (let k = 80; k >= 1; k--) t = z + (k / 2) / t;
  return Math.exp(-z * z) / (Math.sqrt(Math.PI) * t);
}
export function ndtr(x: number): number {
  return x >= 0 ? 1 - 0.5 * erfc(x / Math.SQRT2) : 0.5 * erfc(-x / Math.SQRT2);
}

/** Undiscounted Black price on a forward. The put comes from the call by parity,
 *  exactly as the research did it. */
export function black(F: number, K: number, T: number, v: number, call: boolean): number {
  const sd = v * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
  const c = F * ndtr(d1) - K * ndtr(d1 - sd);
  return call ? c : c - (F - K);
}
/** Implied volatility in PERCENT, or NaN. 60 halvings between 0.01% and 800%, the
 *  same bracket and count as the research, so both land on the same number. */
export function impliedVol(price: number, F: number, K: number, T: number, call: boolean): number {
  let lo = 1e-4, hi = 8.0;
  if (!(price === price) || !(F === F) || !(T > 0) || price <= black(F, K, T, lo, call) || price >= black(F, K, T, hi, call)) return NaN;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (black(F, K, T, mid, call) > price) hi = mid; else lo = mid; }
  return (lo + hi) / 2 * 100;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** THE VOLATILITY CONVENTION — the data vendor's own, on purpose. The rule was
 *  frozen on the vendor's IV field; reverse-engineering that field on 2020–22 gave
 *  it exactly (0.03 vol points): Black-Scholes on the INDEX SPOT with a 10%
 *  interest rate, time counted in calendar minutes from the START of the candle's
 *  minute to 3:30 PM on expiry day. Ten percent is not the real rate and 3:30 PM
 *  is no longer the real close (options run to 3:40 PM since Aug 2026) — neither
 *  matters, because the reading is only ever compared with its own 60-day past
 *  computed the same way. What does matter: with 0% the two-year test drops from
 *  t 2.7 to 2.1, and with a "pure" option-implied forward to 1.4. So the 10% is
 *  part of the rule. From Aug 2025 the vendor changed its own formula on expiry
 *  days, which is why the app computes this itself and never reads the vendor's
 *  field. */
export const IV_RATE = 0.10;
export function skewTime(day: string, expiry: string, m: number): number {
  return (daysBetween(day, expiry) * 1440 + (MINUTES - (m - 1))) / (365 * 1440);
}

// ---------------------------------------------------------------- one day of data
export interface StrikeSeries {
  o: Float64Array; c: Float64Array;        // per minute, NaN where the feed had no row
  vol5: Float64Array;                      // volume summed over each 5-minute bucket
  oi5: Float64Array;                       // OI at the last minute of the bucket that has one
}
export interface DayData {
  day: string; expiry: string;
  spotClose: Float64Array;                 // index close per minute
  ce: Map<number, StrikeSeries>; pe: Map<number, StrikeSeries>;
}

/** Collects one day's rows into the shape the research store had
 *  (build_store3.py): per strike, minute opens/closes, 5-minute volume, and the
 *  bucket's last OI. A repeated (strike, minute) keeps the FIRST row, as pandas
 *  drop_duplicates did. */
export class DayBuilder {
  private legs = { CE: new Map<number, { o: Float64Array; c: Float64Array; vol5: Float64Array; oi1: Float64Array; seen: Uint8Array }>(),
                   PE: new Map<number, { o: Float64Array; c: Float64Array; vol5: Float64Array; oi1: Float64Array; seen: Uint8Array }>() };
  spotClose = new Float64Array(MINUTES).fill(NaN);
  constructor(public day: string, public expiry: string) {}
  setSpot(m: number, close: number) { if (m >= 0 && m < MINUTES && !(this.spotClose[m] === this.spotClose[m])) this.spotClose[m] = close; }
  add(side: 'CE' | 'PE', strike: number, m: number, open: number, close: number, volume: number, oi: number) {
    if (!(m >= 0 && m < MINUTES)) return;
    let s = this.legs[side].get(strike);
    if (!s) { s = { o: new Float64Array(MINUTES).fill(NaN), c: new Float64Array(MINUTES).fill(NaN), vol5: new Float64Array(BUCKETS), oi1: new Float64Array(MINUTES).fill(NaN), seen: new Uint8Array(MINUTES) }; this.legs[side].set(strike, s); }
    if (s.seen[m]) return;
    s.seen[m] = 1; s.o[m] = open; s.c[m] = close; s.oi1[m] = oi;
    if (volume === volume) s.vol5[Math.floor(m / 5)] += volume;
  }
  get rows() { let n = 0; for (const side of ['CE', 'PE'] as const) for (const s of this.legs[side].values()) for (let m = 0; m < MINUTES; m++) n += s.seen[m]; return n; }
  finish(): DayData {
    const out: DayData = { day: this.day, expiry: this.expiry, spotClose: this.spotClose, ce: new Map(), pe: new Map() };
    for (const side of ['CE', 'PE'] as const) {
      for (const [k, s] of this.legs[side]) {
        const oi5 = new Float64Array(BUCKETS).fill(NaN);
        for (let b = 0; b < BUCKETS; b++) for (let q = 0; q < 5; q++) { const v = s.oi1[b * 5 + q]; if (v === v) oi5[b] = v; }
        (side === 'CE' ? out.ce : out.pe).set(k, { o: s.o, c: s.c, vol5: s.vol5, oi5 });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- the reading
export interface Reading { b: number; spot: number; atm: number; skew: number; oi_imb30: number; oi_imb_day: number; vol_imb30: number }

/** One bar's four raw readings. Uses minutes up to m − 1 and buckets up to b only,
 *  so it is safe to call on a day that already holds later candles.
 *
 *  A QUIRK KEPT ON PURPOSE. A total needs at least 8 of the 11 strikes to have a
 *  value, and each total is taken over whichever strikes have one AT THAT TIME.
 *  The vendor's feed carries only ATM ± 10 strikes each minute, so after a move of
 *  more than 250 points a far strike has no 09:30 value and the "added since the
 *  open" figure compares slightly different sets of strikes. That is how the
 *  tested numbers were built, so the live feed is trimmed to the same window
 *  (kiteToDay) rather than "fixed" here. */
export function readingAt(d: DayData, b: number): Reading {
  const m = (b + 1) * 5, spot = d.spotClose[m - 1];
  const nan: Reading = { b, spot: NaN, atm: NaN, skew: NaN, oi_imb30: NaN, oi_imb_day: NaN, vol_imb30: NaN };
  if (!(spot > 0) || b < 6 || b >= BUCKETS) return nan;
  const K = atmOf(spot);
  const strikes: number[] = []; for (let j = -SPAN; j <= SPAN; j++) strikes.push(K + STEP * j);
  const tot = (leg: Map<number, StrikeSeries>, bar: number, col: 'vol5' | 'oi5') => {
    let n = 0, sum = 0;
    for (const k of strikes) { const s = leg.get(k); if (!s) continue; const v = s[col][bar]; if (v === v) { n++; sum += v; } }
    return n >= 8 ? sum : NaN;
  };
  const oc = tot(d.ce, b, 'oi5'), op = tot(d.pe, b, 'oi5'), oc0 = tot(d.ce, b - 6, 'oi5'), op0 = tot(d.pe, b - 6, 'oi5');
  const oc1 = tot(d.ce, 2, 'oi5'), op1 = tot(d.pe, 2, 'oi5');
  let vc = 0, vp = 0;
  for (let q = b - 5; q <= b; q++) { const a = tot(d.ce, q, 'vol5'), p = tot(d.pe, q, 'vol5'); if (a === a) vc += a; if (p === p) vp += p; }
  const ok = oc === oc && op === op && oc0 === oc0 && op0 === op0 && Math.min(oc, op, oc0, op0) > 0;
  const T = skewTime(d.day, d.expiry, m), F = spot * Math.exp(IV_RATE * T);
  const px = (leg: Map<number, StrikeSeries>, k: number) => { const s = leg.get(k); return s ? s.c[m - 1] : NaN; };
  const ivP = impliedVol(px(d.pe, K - SKEW_DIST), F, K - SKEW_DIST, T, false);
  const ivC = impliedVol(px(d.ce, K + SKEW_DIST), F, K + SKEW_DIST, T, true);
  return {
    b, spot, atm: K,
    skew: ivP - ivC,
    oi_imb30: ok ? ((op - op0) - (oc - oc0)) / (op + oc) : NaN,
    oi_imb_day: ok && oc1 === oc1 && op1 === op1 ? ((op - op1) - (oc - oc1)) / (op + oc) : NaN,
    vol_imb30: vc + vp > 0 ? (vc - vp) / (vc + vp) : NaN,
  };
}
export function readingsForDay(d: DayData): Reading[] {
  const out: Reading[] = []; for (let b = FIRST_BAR; b <= LAST_BAR; b++) out.push(readingAt(d, b)); return out;
}

// ---------------------------------------------------------------- scoring against the past
export interface DayAgg { day: string; n: number[]; s: number[]; q: number[] }   // per FEATS: count, sum, sum of squares
export function aggOf(day: string, rows: { [k in Feat]: number | null }[]): DayAgg {
  const n = FEATS.map(() => 0), s = FEATS.map(() => 0), q = FEATS.map(() => 0);
  for (const r of rows) FEATS.forEach((f, i) => { const v = r[f]; if (v !== null && v === v) { n[i]++; s[i] += v; q[i] += v * v; } });
  return { day, n, s, q };
}
export interface Ref { days: number; from: string; to: string; mu: number[]; sd: number[] }
/** Mean and spread of each reading over the 60 trading days BEFORE `day` (every
 *  bar of those days pooled), or null with fewer than 20 days. `history` may hold
 *  any days; only days strictly before `day` are used. Population spread, floored
 *  at 1e-6, as in the research. */
export function refStats(history: DayAgg[], day: string): Ref | null {
  const past = history.filter(h => h.day < day).sort((a, b) => a.day < b.day ? -1 : 1).slice(-WINDOW_DAYS);
  if (past.length < MIN_DAYS) return null;
  const mu: number[] = [], sd: number[] = [];
  FEATS.forEach((_, i) => {
    let n = 0, s = 0, q = 0; for (const h of past) { n += h.n[i]; s += h.s[i]; q += h.q[i]; }
    const m = n > 0 ? s / n : NaN; mu.push(m); sd.push(n > 0 ? Math.sqrt(Math.max(q / n - m * m, 1e-12)) : NaN);
  });
  return { days: past.length, from: past[0].day, to: past[past.length - 1].day, mu, sd };
}
export interface Score { z_skew: number; z_oi_imb30: number; z_oi_imb_day: number; z_vol_imb30: number; flow: number; comp: number }
export function scoreOf(r: { [k in Feat]: number | null }, ref: Ref | null): Score {
  const z = FEATS.map((f, i) => { const v = r[f]; return ref && v !== null && v === v ? Math.max(-CLIP, Math.min(CLIP, (v - ref.mu[i]) / ref.sd[i])) : NaN; });
  const flow = (z[1] + z[2] + z[3]) / 3;                 // NaN if any of the three is missing, as skipna=False did
  return { z_skew: z[0], z_oi_imb30: z[1], z_oi_imb_day: z[2], z_vol_imb30: z[3], flow, comp: (z[0] + flow) / 2 };
}
/** +1 = call side, −1 = put side, 0 = no signal. */
export const signalSide = (comp: number): 1 | -1 | 0 => comp === comp && Math.abs(comp) >= THRESHOLD ? (comp > 0 ? 1 : -1) : 0;

// ---------------------------------------------------------------- the practice trade's arithmetic
/** Today's charges for one buy and one sell of an option (same figures as the
 *  backtest: ₹20 an order, STT 0.15% of the sell, exchange 0.03553%, SEBI ₹10 a
 *  crore, stamp 0.003% of the buy, GST 18% on brokerage + exchange + SEBI). */
export function charges(buyVal: number, sellVal: number): number {
  const brokerage = 40, stt = 0.0015 * sellVal, txn = 0.0003553 * (buyVal + sellVal), sebi = (buyVal + sellVal) * 10 / 1e7;
  return brokerage + stt + txn + sebi + 0.00003 * buyVal + 0.18 * (brokerage + txn + sebi);
}
/** WHY ONE POINT A SIDE. The option is 200 points in the money, where the spread
 *  is wider than at the money. The headline backtest figure used 0.25; the figures
 *  Martin was given, and the ones this record is compared with, use 1 point each
 *  way — so the live record is charged the same. */
export const SLIP_POINTS = 1;
export function practicePnl(entryPx: number, exitPx: number, lot: number) {
  const e = entryPx + SLIP_POINTS, x = exitPx - SLIP_POINTS, fee = charges(e * lot, x * lot);
  return { pts: +(x - e).toFixed(2), fee: +fee.toFixed(2), pnl: +((x - e) * lot - fee).toFixed(2) };
}

// ---------------------------------------------------------------- expiry calendar for PAST days
/** The weekly expiry a past trading day belonged to: Tuesday (the rule since
 *  2 Sep 2025), moved back to the previous trading day when Tuesday is a holiday
 *  — 9 Nov 2026 was a Monday expiry because of the 10th. Today's expiry is read
 *  from Zerodha's contract list instead; this is only for rebuilding history,
 *  where the contracts have already expired and left that list. */
export function weeklyExpiryFor(day: string, isTradingDay: (d: string) => boolean): string {
  const add = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  let d = day;
  for (let guard = 0; guard < 21; guard++) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    const tue = add(d, (2 - wd + 7) % 7);                        // this week's Tuesday on or after d
    let e = tue; while (!isTradingDay(e) && e > add(tue, -6)) e = add(e, -1);
    if (e >= day) return e;
    d = add(tue, 1);                                             // that week's expiry was before `day`: next week
  }
  return day;
}

// ---------------------------------------------------------------- feed adapters
const IST_S = 19800;
export const istDayOfSec = (ts: number) => new Date((ts + IST_S) * 1000).toISOString().slice(0, 10);
export const minuteOfSec = (ts: number) => Math.floor(((ts + IST_S) % 86400) / 60) - 555;   // minutes after 09:15

export interface DhanLeg { timestamp: number[]; open: number[]; close: number[]; volume: number[]; oi: number[]; strike: number[]; spot: number[] }
/** Dhan's expired-option feed ("rolling" rows: offset ATM−10 … ATM+10, whichever
 *  strike sits there each minute) → day builders. One response spans two days. */
export function addDhanLeg(days: Map<string, DayBuilder>, side: 'CE' | 'PE', leg: DhanLeg, expiryOf: (day: string) => string, onlyDays?: Set<string>) {
  const n = leg?.timestamp?.length || 0;
  for (let i = 0; i < n; i++) {
    const ts = Number(leg.timestamp[i]), day = istDayOfSec(ts), m = minuteOfSec(ts);
    if (m < 0 || m >= MINUTES || (onlyDays && !onlyDays.has(day))) continue;
    let b = days.get(day); if (!b) { b = new DayBuilder(day, expiryOf(day)); days.set(day, b); }
    b.add(side, Number(leg.strike[i]), m, Number(leg.open[i]), Number(leg.close[i]), Number(leg.volume[i]), Number(leg.oi[i]));
    const sp = Number(leg.spot?.[i]); if (sp > 0) b.setSpot(m, sp);
  }
}

export interface MinuteCandle { t: number; open: number; close: number; volume?: number; oi?: number }   // t = epoch ms of the minute's start
/** Zerodha minute candles for TODAY → the same shape as a vendor day.
 *
 *  Two things are done so that a day built here equals the same day built later
 *  from the vendor's file (which is what the tested numbers came from):
 *   1. A minute with no trade has no Zerodha candle; the vendor repeats the last
 *      price and OI with zero volume. So gaps are carried forward.
 *   2. The vendor only carries strikes within 10 of that minute's ATM (nearest 50
 *      to the index; an exact tie goes to the lower strike — measured on its
 *      files). A strike outside that window at a given minute is dropped for that
 *      minute here too. See the quirk note on readingAt. */
export function kiteToDay(day: string, expiry: string, index: MinuteCandle[], legs: { side: 'CE' | 'PE'; strike: number; candles: MinuteCandle[] }[], uptoMinute = MINUTES - 1): DayData {
  const b = new DayBuilder(day, expiry);
  const atm = new Float64Array(MINUTES).fill(NaN);
  let lastIdx = NaN;
  const idx = new Float64Array(MINUTES).fill(NaN);
  for (const c of index) { const s = Math.floor(c.t / 1000); if (istDayOfSec(s) !== day) continue; const m = minuteOfSec(s); if (m >= 0 && m < MINUTES) idx[m] = c.close; }
  for (let m = 0; m <= uptoMinute && m < MINUTES; m++) {
    if (idx[m] === idx[m]) { b.setSpot(m, idx[m]); lastIdx = idx[m]; }
    if (lastIdx === lastIdx) atm[m] = Math.ceil(lastIdx / STEP - 0.5) * STEP;      // nearest 50, tie → lower
  }
  for (const leg of legs) {
    const o = new Float64Array(MINUTES).fill(NaN), c = new Float64Array(MINUTES).fill(NaN), v = new Float64Array(MINUTES), oi = new Float64Array(MINUTES).fill(NaN);
    for (const k of leg.candles) {
      const s = Math.floor(k.t / 1000); if (istDayOfSec(s) !== day) continue;
      const m = minuteOfSec(s); if (m < 0 || m >= MINUTES) continue;
      o[m] = k.open; c[m] = k.close; v[m] = Number(k.volume) || 0; oi[m] = k.oi === undefined || k.oi === null ? NaN : Number(k.oi);
    }
    let lc = NaN, loi = NaN;
    for (let m = 0; m <= uptoMinute && m < MINUTES; m++) {
      let om = o[m], cm = c[m], vm = v[m], oim = oi[m];
      if (cm === cm) { lc = cm; if (oim === oim) loi = oim; else oim = loi; }
      else if (lc === lc) { om = lc; cm = lc; vm = 0; oim = loi; }
      else continue;                                                              // nothing traded yet today
      if (!(atm[m] === atm[m]) || Math.abs(leg.strike - atm[m]) > 10 * STEP) continue;
      b.add(leg.side, leg.strike, m, om, cm, vm, oim);
    }
  }
  return b.finish();
}
