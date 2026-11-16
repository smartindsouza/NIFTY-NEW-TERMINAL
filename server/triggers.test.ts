// Armed orders and the trade guard. Run: npx tsx server/triggers.test.ts
//
// What is being proved: an armed order that OPENS a position is checked against
// the guard when it is armed (count and loss rules only) and again when its
// level is reached (every rule); one that CLOSES a position is never checked;
// and a guard that is absent or broken leaves armed orders working as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';

// kite_service opens its session database the moment it is imported, in
// KITE_DATA_DIR — so the folder has to exist before triggers.ts is loaded.
process.env.KITE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triggers-test-'));
const T = await import('./triggers');
const G = await import('./trade_guard');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SYM = 'NIFTY26N1725200CE', TOK = 9000208;

// ── which orders open a position ──
assert.equal(G.isOpeningOrder('BUY', 0), true, 'a buy with nothing held opens');
assert.equal(G.isOpeningOrder('BUY', 65), true, 'a buy on top of a long adds to it');
assert.equal(G.isOpeningOrder('BUY', -65), false, 'a buy against a short buys it back');
assert.equal(G.isOpeningOrder('BUY', null), true, 'positions unknown: a buy is taken as an entry');
assert.equal(G.isOpeningOrder('SELL', 65), false, 'a sell against a long is an exit');
assert.equal(G.isOpeningOrder('SELL', 0), true, 'a sell with nothing held opens a short');
assert.equal(G.isOpeningOrder('SELL', -65), true, 'a sell on top of a short adds to it');
assert.equal(G.isOpeningOrder('SELL', null), false, 'positions unknown: a sell is never stopped');
assert.equal(G.heldQty(null, SYM), null);
assert.equal(G.heldQty([], SYM), 0);
assert.equal(G.heldQty([{ tradingsymbol: SYM, quantity: 65 }, { tradingsymbol: SYM.toLowerCase(), quantity: 65 }, { tradingsymbol: 'OTHER', quantity: -130 }], SYM), 130, 'both products of one contract are added');

// ── which way the price must go ──
assert.equal(T.directionFor(150, 140), 'UP'); assert.equal(T.directionFor(130, 140), 'DOWN');
assert.equal(T.directionFor(140, 140), 'UP', 'a level at the price is reached at once, and is called a rise');
assert.equal(T.isHit('UP', 140, 140), true); assert.equal(T.isHit('UP', 140, 139.95), false); assert.equal(T.isHit('DOWN', 140, 140), true); assert.equal(T.isHit('DOWN', 140, 140.05), false);

// ── the app: armed orders + the guard, against a stand-in broker ──
const db = new Database(':memory:');
let orders: any[] = [], positions: any[] = [], positionsDown = false;
const kc: any = {
  access_token: 'x',
  getOrders: async () => orders,
  getPositions: async () => { if (positionsDown) throw new Error('positions down'); return { net: positions }; },
};
const app = express();
T.registerTriggers(app, db);
G.registerTradeGuard(app, express, { db, getKiteClient: () => kc });
const srv = http.createServer(app).listen(0);
const port = (srv.address() as any).port;
const call = async (method: string, p: string, body?: any) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() as any };
};
const arm = (o: any = {}) => call('POST', '/api/triggers', { tradingsymbol: SYM, instrument_token: TOK, exchange: 'NFO', side: 'BUY', product: 'NRML', quantity: 65, lot_size: 65, trigger_price: 150, current_price: 140, ...o });
const row = (id: string): any => db.prepare('SELECT * FROM pending_triggers WHERE id = ?').get(id);
const armedCount = () => (db.prepare("SELECT COUNT(*) n FROM pending_triggers WHERE status = 'ARMED'").get() as any).n;

// the order goes to this stand-in for /api/orders, and the market is "open"
const placed: any[] = [];
T.__test.place = async (r: any) => { placed.push({ side: r.side, qty: r.quantity, sym: r.tradingsymbol }); return { ok: true, orderId: `ORD${placed.length}` }; };
T.__test.marketOpen = true;

// ── 1. no guard handed over: exactly the old behaviour ──
T.setTriggerGuard(null);
let a = await arm();
assert.equal(a.status, 200); assert.equal(a.body.ok, true); assert.equal(a.body.direction, 'UP');
T.onTickForTriggers(TOK, 149.95); await sleep(40);
assert.equal(row(a.body.id).status, 'ARMED', 'below the level: nothing happens');
T.onTickForTriggers(TOK, 150.05); T.onTickForTriggers(TOK, 150.4); await sleep(60);
assert.equal(row(a.body.id).status, 'FIRED'); assert.equal(row(a.body.id).order_id, 'ORD1');
assert.equal(placed.length, 1, 'two ticks past the level, one order');

// ── 2. the guard is asked twice, differently ──
const asked: any[] = []; let answer: string | null = null; let throws = false;
T.setTriggerGuard(async (o, opts) => { asked.push({ ...o, ignoreTime: !!opts?.ignoreTime }); if (throws) throw new Error('guard broke'); return answer; });
a = await arm();
assert.equal(a.body.ok, true);
assert.deepEqual(asked, [{ tradingsymbol: SYM, side: 'BUY', ignoreTime: true }], 'when arming: the start time is left out');
T.onTickForTriggers(TOK, 151); await sleep(60);
assert.deepEqual(asked[1], { tradingsymbol: SYM, side: 'BUY', ignoreTime: false }, 'when the level is reached: every rule');
assert.equal(row(a.body.id).status, 'FIRED'); assert.equal(placed.length, 2);

// ── 3. refused when arming: nothing is armed, and "arm anyway" does not get past it ──
answer = 'Your rule: 4 trades a day — already 4 today. Exits are not affected.';
let before = armedCount();
a = await arm();
assert.equal(a.status, 403); assert.equal(a.body.ok, false); assert.equal(a.body.guard, true); assert.equal(a.body.error, answer);
a = await arm({ force: true });
assert.equal(a.status, 403, 'force answers the margin warning, not the guard');
assert.equal(armedCount(), before, 'no row was armed');

// ── 4. allowed when armed, refused when the level is reached: no order, and it says why ──
answer = null; a = await arm();
answer = 'Your rule: no new trades before 10:00. Exits are not affected.';
T.onTickForTriggers(TOK, 150); await sleep(60);
let r = row(a.body.id);
assert.equal(r.status, 'FAILED'); assert.equal(r.error, `${answer} No order sent.`); assert.equal(r.order_id, null);
assert.equal(placed.length, 2, 'nothing was sent to the broker');
T.onTickForTriggers(TOK, 152); await sleep(40);
assert.equal(placed.length, 2, 'and it does not come back to life on the next tick');

// ── 5. a guard that breaks never stops an order ──
answer = null; throws = true;
a = await arm(); assert.equal(a.body.ok, true, 'arming goes ahead');
T.onTickForTriggers(TOK, 150); await sleep(60);
assert.equal(row(a.body.id).status, 'FIRED'); assert.equal(placed.length, 3);
throws = false;

// ── 6. outside market hours a touch is ignored and the order stays armed ──
a = await arm();
T.__test.marketOpen = false;
T.onTickForTriggers(TOK, 155); await sleep(40);
assert.equal(row(a.body.id).status, 'ARMED');
T.__test.marketOpen = true;
T.onTickForTriggers(TOK, 155); await sleep(60);
assert.equal(row(a.body.id).status, 'FIRED'); assert.equal(placed.length, 4);

// ── 7. the real guard, wired the way server.ts wires it ──
// Rules written straight into the store with the earliest start time the guard
// accepts, so the count and loss rules can be read at (almost) any hour.
db.prepare("INSERT INTO trade_guard (key, value) VALUES ('rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(JSON.stringify({ active: { enabled: true, startTime: '09:15', maxTrades: 4, maxLoss: 3000 }, pending: null, pendingFrom: null }));
T.setTriggerGuard(G.guardOrderBlock);
const istMin = (() => { const d = new Date(Date.now() + 5.5 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
const afterStart = istMin >= 555;      // between midnight and 9:15 IST the time rule would speak first at the level
const buy = (id: string) => ({ order_id: id, transaction_type: 'BUY', exchange: 'NFO', filled_quantity: 65 });

// three trades today, flat: a fourth can be armed
orders = [buy('A'), buy('B'), buy('C')]; positions = [];
a = await arm();
assert.equal(a.body.ok, true, 'three of four used: arming is allowed');
// ...a fourth is taken elsewhere before the level comes
orders = [buy('A'), buy('B'), buy('C'), buy('D')];
T.onTickForTriggers(TOK, 150); await sleep(80);
r = row(a.body.id);
assert.equal(r.status, 'FAILED');
if (afterStart) assert.match(r.error, /4 trades a day — already 4 today.*No order sent\.$/);
else assert.match(r.error, /no new trades before 09:15.*No order sent\.$/);
assert.equal(placed.length, 4, 'the fifth entry of the day was not placed');

// four trades today: a new entry cannot be armed, long or short
a = await arm();
assert.equal(a.status, 403); assert.match(a.body.error, /4 trades a day/);
a = await arm({ side: 'SELL', trigger_price: 160 });
assert.equal(a.status, 403, 'a sell with nothing held would open a short: an entry too');

// ...but an exit can: a sell armed above a long he is holding
positions = [{ tradingsymbol: SYM, quantity: 65, buy_value: 9100, sell_value: 0, last_price: 140 }];
a = await arm({ side: 'SELL', trigger_price: 160 });
assert.equal(a.body.ok, true, 'a sell against a long held is an exit: never refused');
T.onTickForTriggers(TOK, 160); await sleep(80);
assert.equal(row(a.body.id).status, 'FIRED'); assert.deepEqual(placed[4], { side: 'SELL', qty: 65, sym: SYM });
// and a buy that covers a short he is holding
positions = [{ tradingsymbol: SYM, quantity: -65, buy_value: 0, sell_value: 9100, last_price: 140 }];
a = await arm({ side: 'BUY', trigger_price: 130 });
assert.equal(a.body.ok, true, 'a buy against a short held is an exit');
assert.equal(a.body.direction, 'DOWN');
T.onTickForTriggers(TOK, 129.9); await sleep(80);
assert.equal(row(a.body.id).status, 'FIRED'); assert.equal(placed.length, 6);

// the day's loss limit: no new entry, exits still go
orders = [buy('A')];
positions = [{ tradingsymbol: 'NIFTY26N1725300PE', quantity: 0, buy_value: 20000, sell_value: 16500, last_price: 0 }];
a = await arm();
assert.equal(a.status, 403); assert.match(a.body.error, /loss limit ₹3,000 reached/);
positions.push({ tradingsymbol: SYM, quantity: 65, buy_value: 9100, sell_value: 0, last_price: 140 });
a = await arm({ side: 'SELL', trigger_price: 160 });
assert.equal(a.body.ok, true, 'past the loss limit he can still arm his way out');
await call('DELETE', `/api/triggers/${a.body.id}`);

// positions cannot be read: a buy is still judged as an entry on the count; a sell is let through
positionsDown = true; orders = [buy('A'), buy('B'), buy('C'), buy('D')];
a = await arm();
assert.equal(a.status, 403, 'four fills are four fills, whatever the positions say');
a = await arm({ side: 'SELL', trigger_price: 160 });
assert.equal(a.body.ok, true, 'a sell is never stopped on a guess');
await call('DELETE', `/api/triggers/${a.body.id}`);
positionsDown = false;

// the guard switched off: nothing is checked
db.prepare("UPDATE trade_guard SET value = ? WHERE key = 'rules'")
  .run(JSON.stringify({ active: { enabled: false, startTime: '09:15', maxTrades: 4, maxLoss: 3000 }, pending: null, pendingFrom: null }));
positions = [];
a = await arm();
assert.equal(a.body.ok, true);
T.onTickForTriggers(TOK, 150); await sleep(80);
assert.equal(row(a.body.id).status, 'FIRED'); assert.equal(placed.length, 7);

// ── 8. a level on the INDEX: the option is traded, the index is watched ──
{
  const IDX = 256265;
  T.setTriggerGuard(null); positions = []; orders = [];
  const n0 = placed.length;
  const armAtSpot = (o: any = {}) => arm({ trigger_price: 25300, current_price: 25250, watch_token: IDX, watch_name: 'NIFTY 50', ...o });
  a = await armAtSpot();
  assert.equal(a.status, 200); assert.equal(a.body.ok, true); assert.equal(a.body.direction, 'UP', 'the direction is the index\'s: 25,300 from 25,250 is up');
  let w = row(a.body.id);
  assert.equal(w.watch_token, IDX); assert.equal(w.watch_name, 'NIFTY 50'); assert.equal(w.instrument_token, TOK); assert.equal(w.trigger_price, 25300); assert.equal(w.armed_at_price, 25250);
  assert.deepEqual(T.armedTriggerTokens().sort(), [IDX, TOK].sort(), 'both the contract and the index must be on the feed');
  // the option's own ticks say nothing about it, whatever the number
  T.onTickForTriggers(TOK, 150); T.onTickForTriggers(TOK, 30000); await sleep(40);
  assert.equal(row(a.body.id).status, 'ARMED', 'a tick of the option never fires a level set on the index');
  T.onTickForTriggers(IDX, 25299.95); await sleep(40);
  assert.equal(row(a.body.id).status, 'ARMED', 'the index below the level: nothing');
  T.onTickForTriggers(IDX, 25300); T.onTickForTriggers(IDX, 25304); await sleep(60);
  w = row(a.body.id);
  assert.equal(w.status, 'FIRED'); assert.equal(w.fired_price, 25300, 'what reached the level was the index');
  assert.equal(placed.length, n0 + 1, 'one order, on two index ticks past the level');
  assert.deepEqual(placed[n0], { side: 'BUY', qty: 65, sym: SYM }, 'and it is the OPTION that is bought');

  // from above: a level under the index fires on the way down
  a = await armAtSpot({ trigger_price: 25200, side: 'SELL' });
  assert.equal(a.body.direction, 'DOWN');
  T.onTickForTriggers(IDX, 25201); await sleep(40); assert.equal(row(a.body.id).status, 'ARMED');
  T.onTickForTriggers(IDX, 25199.5); await sleep(60); assert.equal(row(a.body.id).status, 'FIRED');
  assert.deepEqual(placed[n0 + 1], { side: 'SELL', qty: 65, sym: SYM });

  // and the other way about: an index tick never fires a level set in the option's premium
  a = await arm({ trigger_price: 150, current_price: 140 });
  T.onTickForTriggers(IDX, 25300); await sleep(40);
  assert.equal(row(a.body.id).status, 'ARMED', 'the index is far above 150; that is not the option reaching it');
  await call('DELETE', `/api/triggers/${a.body.id}`);
  assert.equal(row(a.body.id).status, 'CANCELLED');

  // a level on the index is cancelled, guarded and refused like any other
  a = await armAtSpot(); await call('DELETE', `/api/triggers/${a.body.id}`);
  T.onTickForTriggers(IDX, 25400); await sleep(40);
  assert.equal(row(a.body.id).status, 'CANCELLED'); assert.equal(placed.length, n0 + 2, 'cancelled: the level comes and nothing is sent');
  T.setTriggerGuard(async () => 'Your rule: 4 trades a day — already 4 today. Exits are not affected.');
  a = await armAtSpot(); assert.equal(a.status, 403, 'the trade guard applies to it'); assert.equal(a.body.guard, true);
  T.setTriggerGuard(null);
  a = await armAtSpot({ watch_token: TOK }); assert.equal(a.status, 400, 'watching the contract itself is not a level on the index');
  a = await armAtSpot({ watch_token: 'abc' }); assert.equal(a.status, 400);
  assert.deepEqual(T.armedTriggerTokens(), [], 'nothing left armed');
}

// ── 9. nothing is armed after the close ──
assert.equal(T.closedForArming(1, 9 * 60, false), false, 'five past nine on a Monday: before the open is allowed');
assert.equal(T.closedForArming(1, 15 * 60 + 40, false), false, 'the last minute of the session');
assert.equal(T.closedForArming(1, 15 * 60 + 41, false), true, 'a minute after it');
assert.equal(T.closedForArming(6, 11 * 60, false), true, 'Saturday'); assert.equal(T.closedForArming(0, 11 * 60, false), true, 'Sunday');
assert.equal(T.closedForArming(3, 11 * 60, true), true, 'a holiday');
{
  // the route itself, at whatever hour this test runs: refused exactly when the pure rule says so
  const { isNseHoliday } = await import('./calendar_service');
  const x = new Date(Date.now() + 5.5 * 3600e3);
  const day = x.toISOString().slice(0, 10);
  const closed = T.closedForArming(x.getUTCDay(), x.getUTCHours() * 60 + x.getUTCMinutes(), isNseHoliday(day));
  T.__test.marketOpen = null;
  a = await arm();
  if (closed) { assert.equal(a.status, 400); assert.equal(a.body.closed, true); assert.equal(a.body.error, 'Market closed'); }
  else { assert.equal(a.status, 200); await call('DELETE', `/api/triggers/${a.body.id}`); }
  T.__test.marketOpen = true;
  console.log(`  (arming with the real clock: ${closed ? 'refused, market closed' : 'accepted'})`);
}

srv.close();
console.log('triggers: all checks passed');
process.exit(0);
