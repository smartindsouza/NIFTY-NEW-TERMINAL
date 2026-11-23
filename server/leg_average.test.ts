// Open-leg average tests. Pure, no network.   npx tsx server/leg_average.test.ts
import assert from 'node:assert/strict';
import { currentLeg, needsLegAverage } from './leg_average';
let n = 0; const ok = (name: string, f: () => void) => { f(); n++; console.log('ok', name); };
const S = 'NIFTY26O2723000CE';
const f = (t: string, side: 'BUY' | 'SELL', q: number, px: number, sym = S) => ({ tradingsymbol: sym, transaction_type: side, quantity: q, average_price: px, fill_timestamp: `2026-10-30 ${t}` });

ok('Martin\'s case: buy 150, sell 140, buy again 145 → entry 145 (Zerodha blends it to 155)', () => {
  const fills = [f('10:00:00', 'BUY', 65, 150), f('10:20:00', 'SELL', 65, 140), f('11:05:00', 'BUY', 65, 145)];
  assert.deepEqual(currentLeg(fills, S), { qty: 65, avg: 145 });
  // what the blended figure would have been: (buy_value − sell_value) / qty
  const blended = (150 * 65 + 145 * 65 - 140 * 65) / 65;
  assert.equal(blended, 155);
  // the automatic −10% SL from each: the blended one sits 5.5 above the real entry's 130.5
  assert.equal(+(155 * 0.9).toFixed(2), 139.5); assert.equal(+(145 * 0.9).toFixed(2), 130.5);
});
ok('profitable first trade: buy 150, sell 170, buy 160 → 160', () => {
  assert.deepEqual(currentLeg([f('10:00:00', 'BUY', 65, 150), f('10:10:00', 'SELL', 65, 170), f('10:30:00', 'BUY', 65, 160)], S), { qty: 65, avg: 160 });
});
ok('adding to the open trade averages it; a partial exit does not change it', () => {
  const fills = [f('10:00:00', 'BUY', 65, 150), f('10:01:00', 'BUY', 65, 160), f('10:02:00', 'SELL', 65, 170)];
  assert.deepEqual(currentLeg(fills, S), { qty: 65, avg: 155 });
});
ok('fills out of order are sorted by time; other contracts ignored', () => {
  const fills = [f('11:05:00', 'BUY', 65, 145), f('10:20:00', 'SELL', 65, 140), f('10:00:00', 'BUY', 65, 150), f('10:30:00', 'BUY', 75, 99, 'OTHER')];
  assert.deepEqual(currentLeg(fills, S), { qty: 65, avg: 145 });
});
ok('three trades in a day: only the last one counts', () => {
  const fills = [f('09:20:00', 'BUY', 65, 100), f('09:30:00', 'SELL', 65, 90), f('10:00:00', 'BUY', 130, 120), f('10:30:00', 'SELL', 130, 130), f('11:00:00', 'BUY', 65, 111.5)];
  assert.deepEqual(currentLeg(fills, S), { qty: 65, avg: 111.5 });
});
ok('a short leg works the same way', () => {
  assert.deepEqual(currentLeg([f('10:00:00', 'SELL', 65, 200), f('10:10:00', 'BUY', 65, 190), f('10:20:00', 'SELL', 65, 210)], S), { qty: -65, avg: 210 });
});
ok('only re-entered positions need it; a single trade or an overnight carry does not', () => {
  assert.equal(needsLegAverage({ quantity: 65, day_buy_quantity: 130, day_sell_quantity: 65, overnight_quantity: 0 }), true);
  assert.equal(needsLegAverage({ quantity: 65, day_buy_quantity: 65, day_sell_quantity: 0, overnight_quantity: 0 }), false);
  assert.equal(needsLegAverage({ quantity: 65, day_buy_quantity: 65, day_sell_quantity: 65, overnight_quantity: 65 }), false);
  assert.equal(needsLegAverage({ quantity: 0, day_buy_quantity: 65, day_sell_quantity: 65 }), false);
});
console.log(`\n${n} passed`);

// ---- entry wall (server/entry_wall.ts) ----
const { entryWallError } = await import('./entry_wall');
const W = (x: any) => entryWallError({ long: true, entry: 145, sl: 130, tp: 174, slOn: true, tpOn: true, tp1Hit: false, ...x });
ok('wall: default -10%/+20% passes', () => assert.equal(W({}), null));
ok('wall: SL above entry needs the live price beyond it; allowed at the entry and after TP1', () => {
  assert.match(W({ sl: 146 })!, /until the live price is known/);
  assert.equal(W({ sl: 150, ltp: 158 }), null);                       // in profit: lock some of it
  assert.match(W({ sl: 158, ltp: 158 })!, /must stay below the current price \(158\)/);
  assert.match(W({ sl: 150, ltp: 140 })!, /must stay below the current price/);
  assert.equal(W({ sl: 145 }), null);
  assert.equal(W({ sl: 160, tp1Hit: true }), null);
});
ok('wall: target below entry refused before TP1', () => assert.match(W({ tp: 140 })!, /Target can't be below/));
ok('wall: a switched-off leg is not checked', () => { assert.equal(W({ sl: 150, slOn: false }), null); assert.equal(W({ tp: 140, tpOn: false }), null); });
ok('wall: mirrored for a short', () => {
  assert.match(entryWallError({ long: false, entry: 200, sl: 195, tp: 160, slOn: true, tpOn: true, tp1Hit: false })!, /below the entry/);
  assert.equal(entryWallError({ long: false, entry: 200, sl: 195, tp: 160, slOn: true, tpOn: true, tp1Hit: false, ltp: 185 }), null);
  assert.match(entryWallError({ long: false, entry: 200, sl: 195, tp: 160, slOn: true, tpOn: true, tp1Hit: false, ltp: 196 })!, /must stay above the current price/);
  assert.equal(entryWallError({ long: false, entry: 200, sl: 220, tp: 160, slOn: true, tpOn: true, tp1Hit: false }), null);
});
console.log(`${n} passed (with wall)`);

// ---- each finished trade's own exit and P&L (23 Nov 2026) ----
const { closedLegs, legForRow, fillMs } = await import('./leg_average');
const F = (sym: string, side: string, q: number, px: number, at: string, id = '') => ({ tradingsymbol: sym, transaction_type: side, quantity: q, average_price: px, fill_timestamp: `2026-11-23 ${at}`, trade_id: id || at });
// his morning, exactly: one CE trade, then the same PE traded twice
const DAY = [
  F('NIFTY26NOV25650CE', 'BUY', 65, 124.95, '09:28:54'), F('NIFTY26NOV25650CE', 'SELL', 65, 125.0, '09:29:07'),
  F('NIFTY26NOV25750PE', 'BUY', 65, 163.9, '09:31:59'), F('NIFTY26NOV25750PE', 'SELL', 65, 210.85, '09:35:28'),
  F('NIFTY26NOV25750PE', 'BUY', 65, 174.0, '09:41:13'), F('NIFTY26NOV25750PE', 'SELL', 65, 161.75, '09:42:31'),
];
ok('legs: the PE traded twice is two trades, +3051.75 and -796.25, not one blended +2255.50', () => {
  const l = closedLegs(DAY as any, 'NIFTY26NOV25750PE');
  assert.equal(l.length, 2);
  assert.deepEqual([l[0].entry, l[0].exit, l[0].pnl], [163.9, 210.85, 3051.75]);
  assert.deepEqual([l[1].entry, l[1].exit, l[1].pnl], [174, 161.75, -796.25]);
  assert.equal(l[0].pnl + l[1].pnl, 2255.5);                          // what Zerodha shows for the contract
  assert.equal(closedLegs(DAY as any, 'NIFTY26NOV25650CE')[0].pnl, 3.25);
});
ok('legs: a row finds ITS trade by entry time, and by price when it has no time', () => {
  const l = closedLegs(DAY as any, 'NIFTY26NOV25750PE');
  const t2 = fillMs(DAY[4] as any);
  assert.equal(new Date(t2).toISOString(), '2026-11-23T04:11:13.000Z');  // 09:41:13 IST
  assert.equal(legForRow(l, { side: 'BUY', qty: 65, entry_price: 174, entry_time: t2 + 4000 })!.pnl, -796.25);
  assert.equal(legForRow(l, { side: 'BUY', qty: 65, entry_price: 164.2, entry_time: null })!.pnl, 3051.75);
  assert.equal(legForRow(l, { side: 'BUY', qty: 130, entry_price: 174, entry_time: t2 }), null);          // not the same quantity
  assert.equal(legForRow(l, { side: 'SELL', qty: 65, entry_price: 174, entry_time: t2 }), null);          // not the same side
  assert.equal(legForRow(l, { side: 'BUY', qty: 65, entry_price: 120, entry_time: t2 - 3600000 }), null); // nothing like it
});
ok('legs: exit in two parts, adding, a trade still open, a short, and a reversal', () => {
  const two = closedLegs([F('X', 'BUY', 130, 100, '10:00:00'), F('X', 'SELL', 65, 110, '10:01:00'), F('X', 'SELL', 65, 120, '10:02:00')] as any, 'X');
  assert.deepEqual([two.length, two[0].qty, two[0].entry, two[0].exit, two[0].pnl], [1, 130, 100, 115, 1950]);
  const add = closedLegs([F('X', 'BUY', 65, 100, '10:00:00'), F('X', 'BUY', 65, 110, '10:01:00'), F('X', 'SELL', 130, 108, '10:02:00')] as any, 'X');
  assert.deepEqual([add[0].qty, add[0].entry, add[0].pnl], [130, 105, 390]);
  assert.equal(closedLegs([F('X', 'BUY', 65, 100, '10:00:00')] as any, 'X').length, 0);
  const open2 = closedLegs([F('X', 'BUY', 65, 100, '10:00:00'), F('X', 'SELL', 65, 90, '10:01:00'), F('X', 'BUY', 65, 95, '10:02:00')] as any, 'X');
  assert.deepEqual([open2.length, open2[0].pnl], [1, -650]);
  const sh = closedLegs([F('X', 'SELL', 65, 100, '10:00:00'), F('X', 'BUY', 65, 90, '10:01:00')] as any, 'X');
  assert.deepEqual([sh[0].side, sh[0].pnl], ['SELL', 650]);
  const rev = closedLegs([F('X', 'BUY', 65, 100, '10:00:00'), F('X', 'SELL', 130, 110, '10:01:00'), F('X', 'BUY', 65, 105, '10:02:00')] as any, 'X');
  assert.deepEqual(rev.map((r: any) => [r.side, r.qty, r.pnl]), [['BUY', 65, 650], ['SELL', 65, 325]]);
});
console.log(`${n} passed (with finished trades)`);
