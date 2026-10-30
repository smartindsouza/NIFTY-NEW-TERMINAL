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
ok('wall: SL above entry refused before TP1, allowed at the entry and after TP1', () => {
  assert.match(W({ sl: 146 })!, /SL can't be above the entry \(145\)/);
  assert.equal(W({ sl: 145 }), null);
  assert.equal(W({ sl: 160, tp1Hit: true }), null);
});
ok('wall: target below entry refused before TP1', () => assert.match(W({ tp: 140 })!, /Target can't be below/));
ok('wall: a switched-off leg is not checked', () => { assert.equal(W({ sl: 150, slOn: false }), null); assert.equal(W({ tp: 140, tpOn: false }), null); });
ok('wall: mirrored for a short', () => {
  assert.match(entryWallError({ long: false, entry: 200, sl: 195, tp: 160, slOn: true, tpOn: true, tp1Hit: false })!, /below the entry/);
  assert.equal(entryWallError({ long: false, entry: 200, sl: 220, tp: 160, slOn: true, tpOn: true, tp1Hit: false }), null);
});
console.log(`${n} passed (with wall)`);
