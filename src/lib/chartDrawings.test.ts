// The shapes behind the chart's drawings. Run: npx tsx src/lib/chartDrawings.test.ts
import assert from 'node:assert/strict';
import { timeToIndex, indexToTime, distToSegment, hitDrawing, anchorsOf, moveAnchor, slideDrawing, textSizePx, fibPrice, parseDrawings, FIB_LEVELS, positionOutcome, positionTexts, type Drawing, type PosBar } from './chartDrawings';

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

// ===== POSITIONS =====
// A long from 09:20 (D1+300) to 09:35 (D1+1200): entry 100, target 110, stop 95, 65 units.
const long: Drawing = { id: 7, type: 'long', token: '256265', a: { t: D1 + 300, p: 100 }, b: { t: D1 + 1200, p: 100 },
  color: '#94a3b8', width: 1, target: 110, stop: 95, qty: 65 };
const short: Drawing = { ...long, type: 'short', target: 90, stop: 105 };

// stored and read back, with its own fields; one without a target or stop is not a position
assert.deepEqual(parseDrawings(JSON.stringify([long, { ...long, target: undefined }, short])).map((d) => d.type), ['long', 'short']);

// six handles: target, entry and stop at either side
assert.deepEqual(anchorsOf(long).map((x) => [x.key, x.t, x.p]),
  [['ta', D1 + 300, 110], ['tb', D1 + 1200, 110], ['ea', D1 + 300, 100], ['eb', D1 + 1200, 100], ['sa', D1 + 300, 95], ['sb', D1 + 1200, 95]]);

// moving them: each its own price and its own side's time
m = moveAnchor(long, 'tb', { t: D1 + 1500, p: 112.5 });
assert.deepEqual([m.a, m.b, m.target, m.stop], [{ t: D1 + 300, p: 100 }, { t: D1 + 1500, p: 100 }, 112.5, 95]);
m = moveAnchor(long, 'sa', { t: D1, p: 97 });
assert.deepEqual([m.a.t, m.b.t, m.target, m.stop], [D1, D1 + 1200, 110, 97]);
m = moveAnchor(long, 'ea', { t: D1 + 300, p: 104 });
assert.deepEqual([m.a.p, m.b.p, m.target, m.stop], [104, 104, 110, 95], 'the entry moves alone, the box keeps both ends');
// none may cross: a target dragged below the entry stops a tick above it, and so on
assert.equal(moveAnchor(long, 'ta', { t: D1 + 300, p: 80 }).target, 100.05);
assert.equal(moveAnchor(long, 'sb', { t: D1 + 1200, p: 130 }).stop, 99.95);
assert.equal(moveAnchor(long, 'ea', { t: D1 + 300, p: 200 }).a.p, 109.95);
assert.equal(moveAnchor(long, 'ea', { t: D1 + 300, p: 0 }).a.p, 95.05);
assert.equal(moveAnchor(short, 'ta', { t: D1 + 300, p: 101 }).target, 99.95, 'a short\'s target stays below its entry');
assert.equal(moveAnchor(short, 'sa', { t: D1 + 300, p: 90 }).stop, 100.05, 'and its stop above');
assert.deepEqual([long.a.p, long.target, long.stop], [100, 110, 95], 'the original is not touched');

// sliding takes the target and the stop along
m = slideDrawing({ ...long, a: { t: D1 + 600, p: 100 }, b: { t: D1 + 1200, p: 100 } }, times, STEP, 1, 2.5);
assert.deepEqual([m.a, m.b, m.target, m.stop], [{ t: D1 + 900, p: 102.5 }, { t: times[5], p: 102.5 }, 112.5, 97.5]);

// taps: inside the box, on its tags, and with Quick Trade on only its lines and tags
const pg = { ax: 100, ay: 50, bx: 300, by: 200, ys: [120], boxes: [{ x: 120, y: 20, w: 160, h: 18 }] };
assert.equal(hitDrawing('long', pg, 200, 160, 10), true, 'inside');
assert.equal(hitDrawing('long', pg, 200, 30, 10), true, 'on the target tag above it');
assert.equal(hitDrawing('long', pg, 350, 160, 10), false, 'beside it');
assert.equal(hitDrawing('long', pg, 200, 160, 10, false), false, 'the middle of the stop zone, Quick Trade on');
assert.equal(hitDrawing('long', pg, 200, 122, 10, false), true, 'its entry line, Quick Trade on');
assert.equal(hitDrawing('long', pg, 200, 197, 10, false), true, 'its stop line, Quick Trade on');
assert.equal(hitDrawing('short', pg, 200, 25, 10, false), true, 'a tag, Quick Trade on');

// THE TRADE ON THE CANDLES. Five-minute candles from 09:15.
const bar = (i: number, low: number, high: number, close: number): PosBar => ({ time: D1 + i * STEP, low, high, close });
const quiet = [bar(0, 96, 99, 98), bar(1, 98, 101, 100), bar(2, 99, 102, 101), bar(3, 100, 104, 103), bar(4, 102, 106, 105)];
// filled on 09:20 (the first candle in the box that reaches 100), and still open on 09:35 at 105
let o = positionOutcome(long, quiet, STEP);
assert.deepEqual([o.filled, o.closed, o.fillIndex, o.exitIndex, o.exitPrice, o.pnl], [true, false, 1, 4, 105, 325]);
assert.equal(positionTexts(long, o).pnl, 'Open P&L: 325.00 | Qty: 65');
// the 09:30 candle reaches the target: closed there, for the full profit
const toTarget = [...quiet.slice(0, 3), bar(3, 101, 110.5, 109), bar(4, 90, 95, 92)];
o = positionOutcome(long, toTarget, STEP);
assert.deepEqual([o.closed, o.exitIndex, o.exitPrice, o.pnl], [true, 3, 110, 650]);
assert.equal(positionTexts(long, o).pnl, 'Closed P&L: 650.00 | Qty: 65');
// a candle reaching both is taken as the stop
const both = [...quiet.slice(0, 3), bar(3, 94, 111, 100), bar(4, 100, 101, 100)];
o = positionOutcome(long, both, STEP);
assert.deepEqual([o.closed, o.exitPrice, o.pnl], [true, 95, -325]);
// candles before the box do not count: 09:15 reached 95, but the box starts at 09:20
o = positionOutcome(long, [bar(0, 90, 101, 100), ...quiet.slice(1)], STEP);
assert.equal(o.closed, false);
// nor after it: 09:40 is past its right side
o = positionOutcome(long, [...quiet, bar(5, 80, 90, 85)], STEP);
assert.deepEqual([o.closed, o.exitIndex], [false, 4]);
// never reaching the entry: not filled, no P&L
const above = quiet.map((b) => ({ ...b, low: b.low + 10, high: b.high + 10, close: b.close + 10 }));
o = positionOutcome(long, above, STEP);
assert.deepEqual([o.filled, o.pnl, o.fillIndex], [false, 0, -1]);
assert.equal(positionTexts(long, o).pnl, 'Open P&L: 0.00 | Qty: 65');
// a box drawn in the empty space right of the last candle has nothing to play out yet
o = positionOutcome({ ...long, a: { t: D1 + 3000, p: 100 }, b: { t: D1 + 4000, p: 100 } }, quiet, STEP);
assert.equal(o.filled, false);
// a box with its sides given the other way round is the same box
o = positionOutcome({ ...long, a: long.b, b: long.a }, toTarget, STEP);
assert.deepEqual([o.closed, o.exitPrice], [true, 110]);
// a short: profit when price falls to its target
o = positionOutcome(short, [bar(1, 99, 101, 100), bar(2, 89, 100, 90)], STEP);
assert.deepEqual([o.closed, o.exitPrice, o.pnl], [true, 90, 650]);
o = positionOutcome(short, [bar(1, 99, 101, 100), bar(2, 100, 106, 104)], STEP);
assert.deepEqual([o.closed, o.exitPrice, o.pnl], [true, 105, -325]);

// the tags, as TradingView writes them: points, signed percent of the entry, money at qty
const tx = positionTexts(long, null);
assert.equal(tx.target, 'Target: 10.00 (10.00%), Profit: 650.00');
assert.equal(tx.stop, 'Stop: 5.00 (-5.00%), Loss: 325.00');
assert.equal(tx.rr, 'R/R: 2.00');
const sx = positionTexts(short, null);
assert.equal(sx.target, 'Target: 10.00 (-10.00%), Profit: 650.00');
assert.equal(sx.stop, 'Stop: 5.00 (5.00%), Loss: 325.00');
// his picture: entry 25214.22, target 25232.90, stop 25204.96, 65 units
const his = positionTexts({ ...long, a: { t: 0, p: 25214.22 }, b: { t: 1, p: 25214.22 }, target: 25232.9, stop: 25204.96 }, null);
assert.equal(his.target, 'Target: 18.68 (0.07%), Profit: 1214.20');
assert.equal(his.stop, 'Stop: 9.26 (-0.04%), Loss: 601.90');
assert.equal(his.rr, 'R/R: 2.02');

console.log('chartDrawings: all checks passed');
