// Hand-made drawings on the chart: trend line, rectangle, Fibonacci retracement and
// text. (A horizontal line is the chart's existing price line, and the long / short
// position is the existing risk:reward box; both are older than this file.)
//
// This file is the part with no chart in it — the shapes, where a moment in time
// sits among the candles, and whether a tap landed on a shape — so that it can be
// tested without a browser. The drawing and the handles are in AdvancedChart.tsx.
//
// A point is a TIME and a PRICE, not a pixel and not a candle number: the same
// drawing has to sit in the same place on the 5-minute and the 15-minute chart,
// after more history has loaded on the left, and tomorrow.

export type DrawPoint = { t: number; p: number };            // unix seconds, price
export type DrawingType = 'trend' | 'rect' | 'fib' | 'text';
export type Drawing = {
  id: number;
  type: DrawingType;
  token: string;                                             // the instrument it was drawn on
  a: DrawPoint;
  b: DrawPoint;                                              // for text: the same as a
  color: string;
  width: number;
  text?: string;
};

export const DRAWINGS_KEY = 'chartDrawings';
export const DRAW_COLORS = ['#a855f7', '#facc15', '#e5e7eb', '#f43f5e', '#10b981', '#3b82f6', '#f97316', '#06b6d4'];
// 0 is the SECOND point and 1 the first, as on TradingView: draw from where the move
// began to where it ended and the levels read as how far price has come back.
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export const fibPrice = (d: Pick<Drawing, 'a' | 'b'>, level: number) => d.b.p + (d.a.p - d.b.p) * level;

/** Is this a drawing we can draw? Anything read back from storage goes through here. */
export function isDrawing(v: any): v is Drawing {
  return !!v && typeof v === 'object' && Number.isFinite(v.id)
    && (v.type === 'trend' || v.type === 'rect' || v.type === 'fib' || v.type === 'text')
    && typeof v.token === 'string'
    && !!v.a && Number.isFinite(v.a.t) && Number.isFinite(v.a.p)
    && !!v.b && Number.isFinite(v.b.t) && Number.isFinite(v.b.p)
    && typeof v.color === 'string' && Number.isFinite(v.width);
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

// Where a drawing is on the screen right now. `ys` is a Fibonacci's levels as drawn.
export type DrawGeom = { ax: number; ay: number; bx: number; by: number; textW?: number; textH?: number; ys?: number[] };

/** Did a tap at (px, py) land on this drawing? `tol` is how many pixels of miss to
 *  forgive. A line is hit along its length and text inside its own box. A rectangle
 *  and a Fibonacci are hit anywhere inside when `fill` is true — a thin border is a
 *  poor target for a thumb — and only on their own lines when it is false, which is
 *  how the chart asks while Quick Trade is on: a tap in the middle of a zone must
 *  still reach the chart then. */
export function hitDrawing(type: DrawingType, g: DrawGeom, px: number, py: number, tol = 10, fill = true): boolean {
  if (type === 'trend') return distToSegment(px, py, g.ax, g.ay, g.bx, g.by) <= tol;
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
  return distToSegment(px, py, x0, y0, x1, y0) <= tol || distToSegment(px, py, x0, y1, x1, y1) <= tol
    || distToSegment(px, py, x0, y0, x0, y1) <= tol || distToSegment(px, py, x1, y0, x1, y1) <= tol;
}

/** The points of a drawing that can be taken hold of, and what moving one changes.
 *  A rectangle has four corners though it stores two: a corner between them takes
 *  its time from one and its price from the other. */
export type AnchorKey = 'a' | 'b' | 'ab' | 'ba';
export function anchorsOf(d: Drawing): { key: AnchorKey; t: number; p: number }[] {
  if (d.type === 'text') return [{ key: 'a', t: d.a.t, p: d.a.p }];
  const two = [{ key: 'a' as AnchorKey, t: d.a.t, p: d.a.p }, { key: 'b' as AnchorKey, t: d.b.t, p: d.b.p }];
  if (d.type !== 'rect') return two;
  return [...two, { key: 'ab', t: d.a.t, p: d.b.p }, { key: 'ba', t: d.b.t, p: d.a.p }];
}
export function moveAnchor(d: Drawing, key: AnchorKey, to: DrawPoint): Drawing {
  if (d.type === 'text') return { ...d, a: { ...to }, b: { ...to } };
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
  return { ...d, a: at(d.a), b: at(d.b) };
}

/** Text has no line to make thicker: its "thickness" 1-4 is its size. */
export const textSizePx = (width: number) => [11, 13, 16, 20][Math.max(1, Math.min(4, Math.round(width) || 2)) - 1];
