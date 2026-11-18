// Hand-made drawings on the chart: trend line, rectangle, Fibonacci retracement,
// text, and the long and short position. (A horizontal line is the chart's existing
// price line, which is older than this file.)
//
// This file is the part with no chart in it — the shapes, where a moment in time
// sits among the candles, and whether a tap landed on a shape — so that it can be
// tested without a browser. The drawing and the handles are in AdvancedChart.tsx.
//
// A point is a TIME and a PRICE, not a pixel and not a candle number: the same
// drawing has to sit in the same place on the 5-minute and the 15-minute chart,
// after more history has loaded on the left, and tomorrow.

export type DrawPoint = { t: number; p: number };            // unix seconds, price
export type DrawingType = 'trend' | 'rect' | 'fib' | 'text' | 'long' | 'short';
export type Drawing = {
  id: number;
  type: DrawingType;
  token: string;                                             // the instrument it was drawn on
  a: DrawPoint;
  b: DrawPoint;                                              // for text: the same as a
  color: string;                                             // a position's: its entry line
  width: number;
  text?: string;
  // A LONG OR SHORT POSITION (18 Nov 2026; see POSITIONS below). `a` and `b` are
  // the entry price at the box's two sides, so the box spans a stretch of TIME as
  // TradingView's does; these are the rest of it.
  target?: number;
  stop?: number;
  qty?: number;                                              // units: "Lot Size" on its settings card
  tColor?: string;                                           // the target zone and its tag
  sColor?: string;                                           // the stop zone and its tag
  lColor?: string;                                           // the tags' text
};

export const DRAWINGS_KEY = 'chartDrawings';
export const DRAW_COLORS = ['#a855f7', '#facc15', '#e5e7eb', '#f43f5e', '#10b981', '#3b82f6', '#f97316', '#06b6d4'];
// 0 is the SECOND point and 1 the first, as on TradingView: draw from where the move
// began to where it ended and the levels read as how far price has come back.
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export const fibPrice = (d: Pick<Drawing, 'a' | 'b'>, level: number) => d.b.p + (d.a.p - d.b.p) * level;

export const isPositionType = (t: DrawingType | string | null | undefined): t is 'long' | 'short' => t === 'long' || t === 'short';

/** Is this a drawing we can draw? Anything read back from storage goes through here. */
export function isDrawing(v: any): v is Drawing {
  return !!v && typeof v === 'object' && Number.isFinite(v.id)
    && (v.type === 'trend' || v.type === 'rect' || v.type === 'fib' || v.type === 'text' || isPositionType(v.type))
    && typeof v.token === 'string'
    && !!v.a && Number.isFinite(v.a.t) && Number.isFinite(v.a.p)
    && !!v.b && Number.isFinite(v.b.t) && Number.isFinite(v.b.p)
    && typeof v.color === 'string' && Number.isFinite(v.width)
    && (!isPositionType(v.type) || (Number.isFinite(v.target) && Number.isFinite(v.stop)));
}

export function parseDrawings(raw: string | null | undefined): Drawing[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isDrawing) : [];
  } catch { return []; }
}

/** Where a moment sits among the candles, as a (fractional) candle number.
 *  `times` are the candles' own times, ascending. Between two candles it is the
 *  fraction of the way from one to the next; before the first or after the last it
 *  carries on at one candle per `stepSec` — so a line can end in the empty space to
 *  the right of the last candle and stay there as candles arrive. */
export function timeToIndex(times: number[], t: number, stepSec: number): number | null {
  const n = times.length;
  if (!n || !Number.isFinite(t) || !(stepSec > 0)) return null;
  if (t <= times[0]) return (t - times[0]) / stepSec;
  if (t >= times[n - 1]) return (n - 1) + (t - times[n - 1]) / stepSec;
  let lo = 0, hi = n - 1;                                     // times[lo] <= t < times[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  const span = times[hi] - times[lo];
  return lo + (span > 0 ? (t - times[lo]) / span : 0);
}

/** The other way: the moment a (fractional) candle number stands for. */
export function indexToTime(times: number[], index: number, stepSec: number): number | null {
  const n = times.length;
  if (!n || !Number.isFinite(index) || !(stepSec > 0)) return null;
  if (index <= 0) return Math.round(times[0] + index * stepSec);
  if (index >= n - 1) return Math.round(times[n - 1] + (index - (n - 1)) * stepSec);
  const lo = Math.floor(index);
  return Math.round(times[lo] + (times[lo + 1] - times[lo]) * (index - lo));
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const k = len2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + k * dx), py - (y1 + k * dy));
}

// Where a drawing is on the screen right now. `ys` is a Fibonacci's levels as drawn
// (a position's entry line). A position's `ay` / `by` are its target and stop, and
// `boxes` the tags drawn round it, which are part of it for a tap.
export type DrawRect = { x: number; y: number; w: number; h: number };
export type DrawGeom = { ax: number; ay: number; bx: number; by: number; textW?: number; textH?: number; ys?: number[]; boxes?: DrawRect[] };

/** Did a tap at (px, py) land on this drawing? `tol` is how many pixels of miss to
 *  forgive. A line is hit along its length and text inside its own box. A rectangle
 *  and a Fibonacci are hit anywhere inside when `fill` is true — a thin border is a
 *  poor target for a thumb — and only on their own lines when it is false, which is
 *  how the chart asks while Quick Trade is on: a tap in the middle of a zone must
 *  still reach the chart then. */
export function hitDrawing(type: DrawingType, g: DrawGeom, px: number, py: number, tol = 10, fill = true): boolean {
  if (type === 'trend') return distToSegment(px, py, g.ax, g.ay, g.bx, g.by) <= tol;
  // A position's tags are solid boxes with words in them: a tap on one is a tap on it.
  if (isPositionType(type) && g.boxes && g.boxes.some((r) => px >= r.x - 2 && px <= r.x + r.w + 2 && py >= r.y - 2 && py <= r.y + r.h + 2)) return true;
  if (type === 'text') {
    const w = g.textW ?? 60, h = g.textH ?? 16;
    return px >= g.ax - tol && px <= g.ax + w + tol && py >= g.ay - h / 2 - tol && py <= g.ay + h / 2 + tol;
  }
  const x0 = Math.min(g.ax, g.bx), x1 = Math.max(g.ax, g.bx), y0 = Math.min(g.ay, g.by), y1 = Math.max(g.ay, g.by);
  if (fill) return px >= x0 - tol && px <= x1 + tol && py >= y0 - tol && py <= y1 + tol;
  if (type === 'fib') {
    const ys = g.ys && g.ys.length ? g.ys : FIB_LEVELS.map((l) => g.by + (g.ay - g.by) * l);
    return ys.some((y) => distToSegment(px, py, x0, y, x1, y) <= tol);
  }
  // A position, lines only: its outline, and the entry line across the middle.
  if (isPositionType(type) && g.ys && g.ys.some((y) => distToSegment(px, py, x0, y, x1, y) <= tol)) return true;
  return distToSegment(px, py, x0, y0, x1, y0) <= tol || distToSegment(px, py, x0, y1, x1, y1) <= tol
    || distToSegment(px, py, x0, y0, x0, y1) <= tol || distToSegment(px, py, x1, y0, x1, y1) <= tol;
}

/** The points of a drawing that can be taken hold of, and what moving one changes.
 *  A rectangle has four corners though it stores two: a corner between them takes
 *  its time from one and its price from the other. */
export type AnchorKey = 'a' | 'b' | 'ab' | 'ba' | 'ta' | 'tb' | 'ea' | 'eb' | 'sa' | 'sb';
export function anchorsOf(d: Drawing): { key: AnchorKey; t: number; p: number }[] {
  if (d.type === 'text') return [{ key: 'a', t: d.a.t, p: d.a.p }];
  if (isPositionType(d.type)) {
    // A position has six: the target, the entry and the stop, at either side of
    // the box. Each moves its own price, and the side it is on.
    const t = Number(d.target), e = d.a.p, s = Number(d.stop);
    return [
      { key: 'ta', t: d.a.t, p: t }, { key: 'tb', t: d.b.t, p: t },
      { key: 'ea', t: d.a.t, p: e }, { key: 'eb', t: d.b.t, p: e },
      { key: 'sa', t: d.a.t, p: s }, { key: 'sb', t: d.b.t, p: s },
    ];
  }
  const two = [{ key: 'a' as AnchorKey, t: d.a.t, p: d.a.p }, { key: 'b' as AnchorKey, t: d.b.t, p: d.b.p }];
  if (d.type !== 'rect') return two;
  return [...two, { key: 'ab', t: d.a.t, p: d.b.p }, { key: 'ba', t: d.b.t, p: d.a.p }];
}
const r2 = (x: number) => Math.round(x * 100) / 100;
export function moveAnchor(d: Drawing, key: AnchorKey, to: DrawPoint, tick = 0.05): Drawing {
  if (d.type === 'text') return { ...d, a: { ...to }, b: { ...to } };
  if (isPositionType(d.type)) {
    // The target and the stop keep to their own side of the entry, a tick clear
    // of it, and the entry stays between them: a stop on the far side of the
    // entry is not a stop, and a risk of nothing would make the ratio infinite.
    const long = d.type === 'long';
    let e = d.a.p, tg = Number(d.target), st = Number(d.stop);
    const what = key[0], side = key[1];
    if (what === 't') tg = long ? Math.max(to.p, e + tick) : Math.min(to.p, e - tick);
    else if (what === 's') st = long ? Math.min(to.p, e - tick) : Math.max(to.p, e + tick);
    else if (what === 'e') {
      const lo = long ? st + tick : tg + tick, hi = long ? tg - tick : st - tick;
      if (lo <= hi) e = Math.min(hi, Math.max(lo, to.p));
    }
    const ta = side === 'a' ? to.t : d.a.t, tb = side === 'b' ? to.t : d.b.t;
    return { ...d, a: { t: ta, p: r2(e) }, b: { t: tb, p: r2(e) }, target: r2(tg), stop: r2(st) };
  }
  if (key === 'a') return { ...d, a: { ...to } };
  if (key === 'b') return { ...d, b: { ...to } };
  if (key === 'ab') return { ...d, a: { t: to.t, p: d.a.p }, b: { t: d.b.t, p: to.p } };
  return { ...d, a: { t: d.a.t, p: to.p }, b: { t: to.t, p: d.b.p } };
}
/** Slide a whole drawing sideways by whole CANDLES and up or down by price. Candles
 *  and not seconds: time on the chart is not even — the night is one step wide — so
 *  a line moved "ninety minutes" across a session break would change its shape. Each
 *  end moves the same number of candles and the drawing looks the same where it lands. */
export function slideDrawing(d: Drawing, times: number[], stepSec: number, dCandles: number, dp: number): Drawing {
  const at = (pt: DrawPoint): DrawPoint => {
    const i = timeToIndex(times, pt.t, stepSec);
    const t = i === null ? null : indexToTime(times, i + dCandles, stepSec);
    return { t: t === null ? pt.t : t, p: Math.round((pt.p + dp) * 100) / 100 };
  };
  const out: Drawing = { ...d, a: at(d.a), b: at(d.b) };
  // A position's target and stop go with it.
  if (isPositionType(d.type)) { out.target = r2(Number(d.target) + dp); out.stop = r2(Number(d.stop) + dp); }
  return out;
}

/** Text has no line to make thicker: its "thickness" 1-4 is its size. */
export const textSizePx = (width: number) => [11, 13, 16, 20][Math.max(1, Math.min(4, Math.round(width) || 2)) - 1];

// ===== POSITIONS (18 Nov 2026) =====
// Martin, with a picture of TradingView's long position: "Change the long and
// short position to this design ... with move, copy, delete and settings on
// chart". It was a full-width box measuring entry, stop and target, one per
// chart. Now it is a drawing like the others, spanning a stretch of time — and
// over that stretch it plays the trade out on the candles, as TradingView's does:
// filled when price first reaches the entry, closed when it first reaches the
// stop or the target, otherwise still open at the last candle in the box.

export const POS_COLORS = { target: '#10b981', stop: '#f43f5e', line: '#94a3b8', label: '#ffffff' };

export type PosBar = { time: number; high: number; low: number; close: number };
export type PositionOutcome = {
  filled: boolean;
  closed: boolean;
  fillIndex: number;                                         // into `bars`; -1 when not filled
  exitIndex: number;                                         // the candle it closed on, or the last one in the box
  exitPrice: number;                                         // the stop, the target, or that last candle's close
  pnl: number;                                               // in money: points × qty
};

/** How the trade in a position went on these candles (ascending by time). A
 *  candle `time` stands for the `stepSec` that start there, so the box's left side
 *  falling inside a candle counts that candle. One candle that reaches both the
 *  stop and the target cannot say which came first: the stop is assumed, the
 *  worse of the two, as TradingView assumes. */
export function positionOutcome(d: Drawing, bars: PosBar[], stepSec: number): PositionOutcome {
  const e = d.a.p, tg = Number(d.target), st = Number(d.stop), long = d.type === 'long';
  const qty = Number(d.qty) > 0 ? Number(d.qty) : 1;
  const none: PositionOutcome = { filled: false, closed: false, fillIndex: -1, exitIndex: -1, exitPrice: e, pnl: 0 };
  const n = bars.length;
  if (!n || !isPositionType(d.type) || !Number.isFinite(tg) || !Number.isFinite(st)) return none;
  const left = Math.min(d.a.t, d.b.t), right = Math.max(d.a.t, d.b.t);
  // the first candle that ends after the left side
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].time + stepSec > left) hi = mid; else lo = mid + 1; }
  const i0 = lo;
  // the last candle that starts at or before the right side
  lo = 0; hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].time <= right) lo = mid + 1; else hi = mid; }
  const i1 = lo - 1;
  if (i0 > i1) return none;
  let f = -1;
  for (let i = i0; i <= i1; i++) if (bars[i].low <= e && bars[i].high >= e) { f = i; break; }
  if (f < 0) return none;
  for (let i = f; i <= i1; i++) {
    const b = bars[i];
    const hitStop = long ? b.low <= st : b.high >= st;
    const hitTarget = long ? b.high >= tg : b.low <= tg;
    if (hitStop || hitTarget) {
      const px = hitStop ? st : tg;
      return { filled: true, closed: true, fillIndex: f, exitIndex: i, exitPrice: px, pnl: (long ? px - e : e - px) * qty };
    }
  }
  const last = bars[i1].close;
  return { filled: true, closed: false, fillIndex: f, exitIndex: i1, exitPrice: last, pnl: (long ? last - e : e - last) * qty };
}

/** The words on a position's tags, as TradingView writes them. */
export function positionTexts(d: Drawing, o: PositionOutcome | null) {
  const e = d.a.p, tg = Number(d.target), st = Number(d.stop);
  const qty = Number(d.qty) > 0 ? Number(d.qty) : 1;
  const reward = Math.abs(tg - e), risk = Math.abs(e - st);
  const pct = (p: number) => (e > 0 ? ((p - e) / e) * 100 : 0).toFixed(2);
  return {
    target: `Target: ${reward.toFixed(2)} (${pct(tg)}%), Profit: ${(reward * qty).toFixed(2)}`,
    stop: `Stop: ${risk.toFixed(2)} (${pct(st)}%), Loss: ${(risk * qty).toFixed(2)}`,
    pnl: `${o && o.closed ? 'Closed' : 'Open'} P&L: ${(o ? o.pnl : 0).toFixed(2)} | Qty: ${qty}`,
    rr: `R/R: ${(risk > 0 ? reward / risk : 0).toFixed(2)}`,
  };
}
