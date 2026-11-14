// Futures feed recorder: what is kept, what is ignored.   npx tsx server/fut_recorder.test.ts
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
process.env.KITE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'futrec-'));     // calendar/ticker imports must not touch the working folder
const { __test } = await import('./fut_recorder');
let n = 0; const ok = (name: string) => { n++; console.log('ok', name); };

const FUT = 13579, at = (t: string) => Date.parse(`2026-11-16T${t}+05:30`);
let now = at('10:00:00');
Object.assign(__test.env, { now: () => now, token: () => FUT, kind: () => 'kite', tradingDay: (d: string) => d !== '2026-11-15' });
__test.openStore(':memory:');
const tick = (o: any = {}) => ({ instrument_token: FUT, last_price: 25266.6, last_traded_quantity: 65, volume_traded: 1234500, total_buy_quantity: 400000, total_sell_quantity: 380000, oi: 15000000,
  exchange_timestamp: new Date(now - 300), last_trade_time: new Date(now - 900), depth: { buy: [{ price: 25266.5, quantity: 130, orders: 2 }], sell: [{ price: 25267.5, quantity: 195, orders: 3 }] }, ...o });

__test.tap(tick()); __test.tap({ ...tick(), instrument_token: 256265 }); __test.tap(tick({ last_price: 25267.5, last_traded_quantity: 130, volume_traded: 1234630 }));
let r = __test.dayRows('2026-11-16');
assert.equal(r.rows.length, 2); assert.equal(r.token, FUT);
const row = Object.fromEntries(__test.COLS.map((c: string, i: number) => [c, r.rows[0][i]]));
assert.deepEqual([row.ltp, row.ltq, row.vol, row.bid, row.bid_q, row.ask, row.ask_q, row.tbq, row.tsq, row.oi], [2526660, 65, 1234500, 2526650, 130, 2526750, 195, 400000, 380000, 15000000]);
assert.equal(row.ts, now); assert.equal(row.ex_ts, Math.round((now - 300) / 1000)); assert.equal(row.ltt, Math.round((now - 900) / 1000));
ok('keeps price, last quantity, volume, best bid/ask and OI of the future only; prices ×100');

now = at('09:14:59'); __test.tap(tick()); now = at('15:40:00'); __test.tap(tick()); now = at('15:39:59'); __test.tap(tick());
assert.equal(__test.dayRows('2026-11-16').rows.length, 3); ok('records 09:15 – 15:40 only');

now = Date.parse('2026-11-15T11:00:00+05:30'); __test.tap(tick()); assert.equal(__test.dayRows('2026-11-15').rows.length, 0); ok('nothing on a non-trading day');
now = at('11:00:00'); __test.env.kind = () => 'dhan'; __test.tap(tick()); __test.env.kind = () => 'kite';
__test.env.token = () => null as any; __test.tap(tick()); __test.env.token = () => FUT;
assert.equal(__test.dayRows('2026-11-16').rows.length, 3); ok('nothing on Dhan\'s feed or before the contract is known');
__test.tap({ instrument_token: FUT, last_price: 25270 }); r = __test.dayRows('2026-11-16');
assert.equal(r.rows.length, 4); assert.equal(r.rows[3][__test.COLS.indexOf('bid')], null); ok('a tick without depth is still kept, with empty bid/ask');
console.log(`\n${n} passed`);
