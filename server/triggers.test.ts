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

// ── 10. on the candle's close (18 Nov 2026) ──
// the pure rules
assert.equal(T.wantsUp('BUY', SYM, false), true, 'option chart: a buy wants the premium up');
assert.equal(T.wantsUp('SELL', SYM, false), false, 'option chart: a sell wants it down');
assert.equal(T.wantsUp('BUY', 'NIFTY26N1725200CE', true), true, 'spot chart: a CALL wants the index up');
assert.equal(T.wantsUp('BUY', 'NIFTY26N1725200PE', true), false, 'spot chart: a PUT wants it down');
assert.equal(T.wantsUp('SELL', 'NIFTY26N1725200PE', true), true); assert.equal(T.wantsUp('SELL', 'NIFTY26N1725200CE', true), false);
assert.equal(T.candleConfirms(true, 150, { o: 148, c: 151 }), true, 'green, closed above');
assert.equal(T.candleConfirms(true, 150, { o: 152, c: 151 }), false, 'above the level but red');
assert.equal(T.candleConfirms(true, 150, { o: 148, c: 150 }), false, 'a close on the level is not above it');
assert.equal(T.candleConfirms(true, 150, { o: 148, c: 149.5 }), false, 'green but closed back under — the wick');
assert.equal(T.candleConfirms(false, 150, { o: 152, c: 149 }), true, 'red, closed below');
assert.equal(T.candleConfirms(false, 150, { o: 148, c: 149 }), false, 'below but green');
assert.equal(T.candleConfirms(false, 150, { o: 152, c: 150 }), false);
assert.equal(T.cleanTf('15'), 15); assert.equal(T.cleanTf(1), 1); assert.equal(T.cleanTf('D'), 60); assert.equal(T.cleanTf('120'), 60); assert.equal(T.cleanTf('7'), 5); assert.equal(T.cleanTf(undefined), 5);
{
  const at = (h: number, m: number, sec = 0) => Date.UTC(2026, 10, 18, h, m, sec) - 5.5 * 3600e3;   // IST clock time on 18 Nov
  assert.equal(T.bucketOf(at(9, 15), 15), T.bucketOf(at(9, 29, 59), 15), '9:15 to 9:30 is one 15m candle');
  assert.equal(T.bucketOf(at(9, 30), 15), T.bucketOf(at(9, 15), 15) + 1);
  assert.equal(T.bucketOf(at(10, 14, 59), 60), T.bucketOf(at(9, 15), 60), 'the hour candle runs 9:15 to 10:15');
  assert.equal(T.bucketStartMs(T.bucketOf(at(11, 7, 30), 5), 5), at(11, 5));

  let clock = at(11, 0, 0);
  T.__test.now = () => clock;
  let opens: any = null; T.__test.candle = async () => opens;
  const tick = async (h: number, m: number, sec: number, px: number, tok = TOK) => { clock = at(h, m, sec); await T.closeEndedBars(); T.onTickForTriggers(tok, px); await sleep(15); };
  const end = async (h: number, m: number) => { clock = at(h, m, 0); await T.closeEndedBars(); await sleep(40); };
  const row = async (id: string) => (await call('GET', '/api/triggers')).body.rows.find((r: any) => r.id === id);
  const n0 = placed.length;

  // a) the wick: reached, closed back under — no order; the next candle closes green above — order
  a = await arm({ confirm: 'CLOSE', confirm_tf: 5 }); assert.equal(a.status, 200); assert.equal(a.body.confirm, 'CLOSE'); assert.equal(a.body.confirm_tf, 5);
  let id = a.body.id;
  await tick(11, 0, 1, 141); await tick(11, 2, 0, 152);
  assert.equal(placed.length, n0, 'the touch alone places nothing'); assert.equal((await row(id)).touched, 1); assert.equal((await row(id)).status, 'ARMED');
  await tick(11, 4, 50, 149); await end(11, 5);
  assert.equal(placed.length, n0, 'a candle that closed back under the level places nothing'); assert.equal((await row(id)).status, 'ARMED');
  await tick(11, 5, 1, 149); await tick(11, 9, 58, 151.5); await end(11, 10);
  assert.equal(placed.length, n0 + 1, 'green close above: placed, by the clock, with no further tick'); assert.equal((await row(id)).status, 'FIRED'); assert.equal((await row(id)).fired_price, 151.5);

  // b) above the level but red: no; and a tick in the next candle closes the last one too
  a = await arm({ confirm: 'CLOSE', confirm_tf: 5 }); id = a.body.id;
  await tick(11, 10, 1, 153); await tick(11, 14, 0, 151);
  await tick(11, 15, 1, 151); assert.equal(placed.length, n0 + 1, 'closed above but red (153 -> 151)');
  await tick(11, 19, 0, 152); await tick(11, 20, 1, 152); await sleep(40);
  assert.equal(placed.length, n0 + 2, 'the next one, green above, closed by the first tick of the candle after');

  // c) a buy below the price (a dip): green candles above the level do nothing until the level has been reached
  a = await arm({ confirm: 'CLOSE', confirm_tf: 5, trigger_price: 130, current_price: 140 }); id = a.body.id; assert.equal(a.body.direction, 'DOWN');
  await tick(11, 25, 1, 140); await tick(11, 29, 0, 142); await end(11, 30);
  assert.equal(placed.length, n0 + 2, 'never reached: a green close above it is not an entry');
  await tick(11, 30, 1, 142); await tick(11, 32, 0, 129); await tick(11, 34, 0, 128); await end(11, 35);
  assert.equal(placed.length, n0 + 2, 'reached, closed red below'); assert.equal((await row(id)).touched, 1);
  await tick(11, 35, 1, 128); await tick(11, 39, 0, 131); await end(11, 40);
  assert.equal(placed.length, n0 + 3, 'then a green close back above');

  // d) vice versa: a sell waits for a red close below
  a = await arm({ confirm: 'CLOSE', confirm_tf: 5, side: 'SELL', trigger_price: 120, current_price: 131 }); id = a.body.id;
  await tick(11, 40, 1, 131); await tick(11, 43, 0, 119); await tick(11, 44, 0, 121); await end(11, 45);
  assert.equal(placed.length, n0 + 3, 'dipped under and closed back above');
  await tick(11, 45, 1, 121); await tick(11, 49, 0, 119); await end(11, 50);
  assert.equal(placed.length, n0 + 4); assert.equal(placed[placed.length - 1].side, 'SELL');

  // e) on the index: a PUT waits for a red close below the level, a CALL for a green close above
  const IDX2 = 256265, PUT = 'NIFTY26N1725200PE';
  a = await arm({ confirm: 'CLOSE', confirm_tf: 15, tradingsymbol: PUT, trigger_price: 25200, current_price: 25250, watch_token: IDX2, watch_name: 'NIFTY 50' }); id = a.body.id;
  await tick(12, 0, 1, 25250, IDX2); await tick(12, 5, 0, 25190, IDX2); await tick(12, 14, 0, 25210, IDX2); await end(12, 15);
  assert.equal(placed.length, n0 + 4, 'index dipped under and closed back above: no PUT');
  await tick(12, 15, 1, 25210, IDX2); await tick(12, 20, 0, 25150, TOK); assert.equal(placed.length, n0 + 4, "the option's own price is not what is watched");
  await tick(12, 29, 0, 25180, IDX2); await end(12, 30);
  assert.equal(placed.length, n0 + 5, 'red 15m close below'); assert.equal(placed[placed.length - 1].sym, PUT);

  // f) joined late, open not readable: not judged. Readable: judged on the broker's open.
  a = await arm({ confirm: 'CLOSE', confirm_tf: 5 }); id = a.body.id;
  opens = null;
  await tick(12, 32, 0, 149); await tick(12, 34, 0, 152); await end(12, 35);
  assert.equal(placed.length, n0 + 5, 'the open of a candle joined at 12:32 is unknown: nothing placed');
  opens = { o: 153, h: 153.5, l: 148 };
  await tick(12, 37, 0, 150.5); await tick(12, 39, 0, 152); await end(12, 40);
  assert.equal(placed.length, n0 + 5, 'the broker says it opened at 153: 152 is a red close');
  opens = { o: 149, h: 152, l: 148.5 };
  await tick(12, 42, 0, 150.5); await tick(12, 44, 0, 152); await end(12, 45);
  assert.equal(placed.length, n0 + 6, 'opened at 149 by the broker, closed 152: green above');

  // g) the switch off (or an older bundle that says nothing): the touch, as before
  a = await arm({ confirm: 'TOUCH' }); await tick(12, 46, 0, 150); assert.equal(placed.length, n0 + 7, 'TOUCH places on the tick');
  a = await arm(); assert.equal(a.body.confirm, 'TOUCH'); await tick(12, 47, 0, 150); assert.equal(placed.length, n0 + 8);

  // h) cancelled while waiting: its candle closing does nothing
  a = await arm({ confirm: 'CLOSE', confirm_tf: 5 }); id = a.body.id;
  await tick(12, 50, 1, 149); await tick(12, 52, 0, 152); await call('DELETE', `/api/triggers/${id}`); await end(12, 55);
  assert.equal(placed.length, n0 + 8); assert.equal((await row(id)).status, 'CANCELLED');
  T.__test.now = null; T.__test.candle = null;
  assert.deepEqual(T.armedTriggerTokens(), [], 'nothing left armed');
}

srv.close();
console.log('triggers: all checks passed');
process.exit(0);
