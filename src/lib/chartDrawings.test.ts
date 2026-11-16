// The shapes behind the chart's drawings. Run: npx tsx src/lib/chartDrawings.test.ts
import assert from 'node:assert/strict';
import { timeToIndex, indexToTime, distToSegment, hitDrawing, anchorsOf, moveAnchor, slideDrawing, textSizePx, fibPrice, parseDrawings, FIB_LEVELS, type Drawing } from './chartDrawings';

// Two sessions of 5-minute candles with the night between them: 09:15..09:35, then 09:15 next day.
const D1 = 1794800700, STEP = 300, NIGHT = 86400 - 4 * STEP;
const times = [D1, D1 + 300, D1 + 600, D1 + 900, D1 + 1200, D1 + 1200 + NIGHT, D1 + 1500 + NIGHT];

// on a candle, between two, across the night, before the first and after the last
assert.equal(timeToIndex(times, D1 + 600, STEP), 2);
assert.equal(timeToIndex(times, D1 + 750, STEP), 2.5);
assert.equal(timeToIndex(times, D1 + 1200 + NIGHT / 2, STEP), 4.5, 'half way through the night is half way between the two candles');
assert.equal(timeToIndex(times, D1 - 600, STEP), -2);
assert.equal(timeToIndex(times, times[6] + 900, STEP), 9, 'three candles into the empty space on the right');
assert.equal(timeToIndex([], D1, STEP), null);
assert.equal(timeToIndex(times, NaN, STEP), null);
assert.equal(timeToIndex(times, D1, 0), null);

// and back again, exactly, for every kind of place
for (const t of [D1, D1 + 750, D1 + 1200 + NIGHT / 2, D1 - 600, times[6] + 900, times[6]]) {
  const i = timeToIndex(times, t, STEP)!;
  assert.equal(indexToTime(times, i, STEP), t, `round trip of ${t}`);
}
assert.equal(indexToTime([], 1, STEP), null);

// THE POINT OF STORING TIME: the same moment on a 15-minute chart of the same session.
// 09:25 (D1+600) is the third 5-minute candle; on 15-minute candles it is 2/3 of the way through the first.
const t15 = [D1, D1 + 900];
assert.ok(Math.abs(timeToIndex(t15, D1 + 600, 900)! - 2 / 3) < 1e-9);

// distance to a segment: beside the middle, past an end, and a segment of no length
assert.equal(distToSegment(5, 3, 0, 0, 10, 0), 3);
assert.equal(distToSegment(14, 3, 0, 0, 10, 0), 5);
assert.equal(distToSegment(3, 4, 0, 0, 0, 0), 5);

// taps
const g = { ax: 100, ay: 100, bx: 200, by: 150 };
assert.equal(hitDrawing('trend', g, 150, 127, 10), true, 'on the line');
assert.equal(hitDrawing('trend', g, 150, 100, 10), false, 'inside the box the line spans, but 22px off the line');
assert.equal(hitDrawing('rect', g, 150, 110, 10), true, 'inside a rectangle counts');
assert.equal(hitDrawing('rect', g, 215, 110, 10), false);
assert.equal(hitDrawing('fib', { ax: 200, ay: 150, bx: 100, by: 100 }, 150, 110, 10), true, 'points given the other way round');
assert.equal(hitDrawing('text', { ax: 100, ay: 100, bx: 100, by: 100, textW: 80, textH: 16 }, 170, 104, 6), true);
assert.equal(hitDrawing('text', { ax: 100, ay: 100, bx: 100, by: 100, textW: 80, textH: 16 }, 195, 104, 6), false);
// with Quick Trade on the chart asks for the lines only: the middle of a zone lets the tap through
assert.equal(hitDrawing('rect', g, 150, 125, 10, false), false, 'the middle of a rectangle');
assert.equal(hitDrawing('rect', g, 150, 104, 10, false), true, 'its top edge');
assert.equal(hitDrawing('rect', g, 195, 125, 10, false), true, 'its right edge');
assert.equal(hitDrawing('rect', g, 150, 125, 10, true), true);
const fg = { ax: 100, ay: 100, bx: 200, by: 200 };          // levels at 200, 176.4, 161.8, 150, 138.2, 121.4, 100
assert.equal(hitDrawing('fib', fg, 150, 152, 6, false), true, 'on the 0.5 level');
assert.equal(hitDrawing('fib', fg, 150, 130, 6, false), false, 'between two levels');
assert.equal(hitDrawing('fib', { ...fg, ys: [200, 130] }, 150, 130, 6, false), true, 'levels as the chart drew them win over the straight-line guess');
assert.equal(hitDrawing('fib', fg, 150, 130, 6, true), true);
assert.equal(hitDrawing('trend', g, 150, 127, 10, false), true, 'a line is a line either way');

// anchors: a rectangle has four corners though it stores two
const rect: Drawing = { id: 1, type: 'rect', token: '256265', a: { t: 100, p: 50 }, b: { t: 200, p: 80 }, color: '#a855f7', width: 1 };
assert.deepEqual(anchorsOf(rect).map((x) => [x.key, x.t, x.p]), [['a', 100, 50], ['b', 200, 80], ['ab', 100, 80], ['ba', 200, 50]]);
let m = moveAnchor(rect, 'ab', { t: 90, p: 95 });          // the corner at a's time and b's price
assert.deepEqual([m.a, m.b], [{ t: 90, p: 50 }, { t: 200, p: 95 }]);
m = moveAnchor(rect, 'ba', { t: 250, p: 40 });             // the corner at b's time and a's price
assert.deepEqual([m.a, m.b], [{ t: 100, p: 40 }, { t: 250, p: 80 }]);
m = moveAnchor(rect, 'b', { t: 10, p: 10 });
assert.deepEqual([m.a, m.b], [{ t: 100, p: 50 }, { t: 10, p: 10 }]);
assert.deepEqual(rect.a, { t: 100, p: 50 }, 'the original is not touched');
const trend: Drawing = { ...rect, type: 'trend' };
assert.equal(anchorsOf(trend).length, 2);
const text: Drawing = { ...rect, type: 'text', b: { ...rect.a }, text: 'hello' };
assert.equal(anchorsOf(text).length, 1);
m = moveAnchor(text, 'a', { t: 5, p: 6 });
assert.deepEqual([m.a, m.b], [{ t: 5, p: 6 }, { t: 5, p: 6 }], 'text keeps its two points together');

// sliding a drawing: by candles, not by seconds. Two candles to the right from 09:25 and
// 09:35 crosses the night, and the drawing is still two candles wide where it lands.
const onChart: Drawing = { ...rect, a: { t: D1 + 600, p: 50 }, b: { t: D1 + 1200, p: 80 } };
m = slideDrawing(onChart, times, STEP, 2, -5.05);
assert.deepEqual([m.a, m.b], [{ t: D1 + 1200, p: 44.95 }, { t: times[6], p: 74.95 }]);
assert.equal(timeToIndex(times, m.b.t, STEP)! - timeToIndex(times, m.a.t, STEP)!, 2, 'still two candles wide');
m = slideDrawing(onChart, times, STEP, -4, 0);              // off the left end: carries on at one candle a step
assert.deepEqual([m.a.t, m.b.t], [D1 - 600, D1]);
m = slideDrawing(onChart, [], STEP, 3, 1);                  // no candles to count by: the time stays, the price moves
assert.deepEqual([m.a, m.b], [{ t: D1 + 600, p: 51 }, { t: D1 + 1200, p: 81 }]);
assert.deepEqual(onChart.a, { t: D1 + 600, p: 50 }, 'the original is not touched');

// text sizes
assert.deepEqual([0, 1, 2, 3, 4, 9, NaN].map(textSizePx), [13, 11, 13, 16, 20, 20, 13]);

// Fibonacci: 0 at the second point, 1 at the first
const fib = { a: { t: 0, p: 100 }, b: { t: 1, p: 200 } };
assert.equal(fibPrice(fib, 0), 200); assert.equal(fibPrice(fib, 1), 100); assert.equal(fibPrice(fib, 0.5), 150);
assert.ok(Math.abs(fibPrice(fib, 0.618) - 138.2) < 1e-9);
assert.deepEqual(FIB_LEVELS, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);

// what comes back from storage: only what can be drawn
assert.deepEqual(parseDrawings(null), []);
assert.deepEqual(parseDrawings('not json'), []);
assert.deepEqual(parseDrawings('{"a":1}'), []);
const stored = JSON.stringify([rect, { ...rect, type: 'circle' }, { ...rect, a: { t: 'x', p: 1 } }, { id: 2 }, null, text]);
assert.deepEqual(parseDrawings(stored).map((d) => d.type), ['rect', 'text']);

console.log('chartDrawings: all checks passed');
