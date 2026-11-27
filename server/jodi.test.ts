// Jodi: the rules, and the engine against a stand-in broker. Run: npx tsx server/jodi.test.ts
//
// What is being proved: both options are bought together and only when the two
// prices added are at or below the combined premium; a leg under half its price
// is sold and the other runs; the combined SL, the target, 3:20 PM and his own
// Exit each sell what is held, once; and whatever goes wrong while buying, he is
// never left holding one side without being told.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';

process.env.KITE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jodi-test-'));
const J = await import('./jodi');
const G = await import('./trade_guard');

let n = 0;
const ok = async (name: string, fn: () => any) => { try { await fn(); n++; } catch (e: any) { console.log('FAIL', name, '\n  ', e?.message || e); process.exitCode = 1; } };

// ── the pure rules ──
await ok('contract names', () => {
  assert.deepEqual(J.parseOption('SENSEX26N2684100CE'), { root: 'SENSEX', expiry: '26N26', strike: 84100, type: 'CE' });
  assert.deepEqual(J.parseOption('NIFTY26NOV25750PE'), { root: 'NIFTY', expiry: '26NOV', strike: 25750, type: 'PE' });
  assert.equal(J.parseOption('NIFTY 50'), null);
});
const CE = { tradingsymbol: 'SENSEX26N2684100CE', exchange: 'BFO', instrument_token: 111, lot_size: 20 };
const PE = { tradingsymbol: 'SENSEX26N2684000PE', exchange: 'BFO', instrument_token: 222, lot_size: 20 };
const ASK = { ce: CE, pe: PE, lots: 1, ceEntry: 114, peEntry: 110, combined: 224, sl: 100, target: 305 };
await ok('what may be saved', () => {
  assert.equal(J.validateJodi(ASK), null, 'his own example');
  assert.match(J.validateJodi({ ...ASK, ce: PE })!, /Call/);
  assert.match(J.validateJodi({ ...ASK, pe: CE })!, /Put/);
  assert.match(J.validateJodi({ ...ASK, pe: { ...PE, tradingsymbol: 'NIFTY26N2684000PE' } })!, /same index/);
  assert.match(J.validateJodi({ ...ASK, pe: { ...PE, tradingsymbol: 'SENSEX26D0384000PE' } })!, /same expiry/);
  assert.match(J.validateJodi({ ...ASK, lots: 0 })!, /Lots/); assert.match(J.validateJodi({ ...ASK, lots: 1.5 })!, /Lots/);
  assert.match(J.validateJodi({ ...ASK, sl: 224 })!, /SL must be below/); assert.match(J.validateJodi({ ...ASK, target: 224 })!, /target must be above/);
  assert.match(J.validateJodi({ ...ASK, ceEntry: 0 })!, /entry price/);
  assert.equal(J.validateJodi({ ...ASK, ceEntry: 118, peEntry: 106 }), null, 'the two prices need not be the same');
});
const AT = (h: number, m: number) => h * 60 + m;
const pend = { status: 'PENDING', combined: 224, sl: 100, target: 305, ce_held: 0, pe_held: 0, ce_buy: null, pe_buy: null, ce_sold: null, pe_sold: null };
const act = { ...pend, status: 'ACTIVE', ce_held: 1, pe_held: 1, ce_buy: 114, pe_buy: 110 };
await ok('when it is entered', () => {
  assert.equal(J.decide(pend, 116, 110, AT(10, 0)), null, '226 is above 224');
  assert.equal(J.decide(pend, 114, 110, AT(10, 0)), 'ENTER', 'exactly the combined premium');
  assert.equal(J.decide(pend, 118, 105, AT(10, 0)), 'ENTER', '223: the legs differ, the total is what counts');
  assert.equal(J.decide(pend, 0, 110, AT(10, 0)), null, 'one price missing: not judged');
  assert.equal(J.decide(pend, 100, 100, AT(9, 10)), null, 'before the open');
  assert.equal(J.decide(pend, 100, 100, AT(9, 15)), 'ENTER');
  assert.equal(J.decide(pend, 100, 100, AT(15, 20)), 'EXPIRE', 'never entered after 3:20 PM');
});
await ok('when it is exited, and the half-price cut', () => {
  assert.equal(J.decide(act, 120, 108, AT(10, 0)), null);
  assert.equal(J.decide(act, 250, 55, AT(10, 0)), 'EXIT_TARGET', '305 reached');
  assert.equal(J.decide(act, 60, 40, AT(10, 0)), 'EXIT_SL', '100 reached');
  assert.equal(J.decide(act, 56.9, 150, AT(10, 0)), 'CUT_CE', 'the call is under half of 114');
  assert.equal(J.decide(act, 57, 150, AT(10, 0)), null, 'exactly half is not under half');
  assert.equal(J.decide(act, 170, 54.9, AT(10, 0)), 'CUT_PE');
  assert.equal(J.decide(act, 120, 108, AT(15, 20)), 'EXIT_TIME');
  assert.equal(J.decide(act, 250, 55, AT(15, 20)), 'EXIT_TARGET', 'the target outranks the clock');
  // after the call was sold at 56: its 56 is banked, the put carries the rest
  const one = { ...act, ce_held: 0, ce_sold: 56 };
  assert.equal(J.combinedValue(one, 3, 150), 206, 'money from the sold leg + the live price of the other; the dead leg\'s price is ignored');
  assert.equal(J.decide(one, 3, 249, AT(10, 0)), 'EXIT_TARGET', '56 + 249 = 305');
  assert.equal(J.decide(one, 3, 248, AT(10, 0)), null);
  assert.equal(J.decide(one, 3, 44, AT(10, 0)), 'EXIT_SL', '56 + 44 = 100');
  assert.equal(J.decide(one, 3, 50, AT(10, 0)), null, 'the leg that is left is never cut at half: 50 is under half of 110 and it stays');
  assert.equal(J.decide(one, 0, 120, AT(10, 0)), null, 'no price needed for a leg already sold');
  assert.equal(J.jodiPnl({ ...one, qty: 20 }, 3, 249), (305 - 224) * 20);
  assert.equal(J.decide({ ...act, status: 'EXITING' }, 250, 55, AT(10, 0)), null);
});

// ── the engine, against a stand-in broker ──
const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY0 = Date.UTC(2026, 10, 27, 4, 30);            // Fri 27 Nov 2026, 10:00 AM IST
let clock = DAY0;
const px = new Map<number, number>([[111, 120], [222, 112]]);
type Order = { id: string; sym: string; side: string; qty: number; status: string; average_price: number; price: number; filled_quantity: number; quantity: number; status_message?: string };
let orders: Order[] = [], net: any[] = [], said: string[] = [], funds = 1e6;
let buyMode: Record<string, 'fill' | 'reject' | 'stuck'> = {}, exitFails = 0, exitCalls: string[] = [];
const tokOf = (sym: string) => (sym.endsWith('CE') ? 111 : 222);
const hold = (sym: string, q: number) => { const p = net.find((x) => x.tradingsymbol === sym); if (p) p.quantity += q; else net.push({ tradingsymbol: sym, quantity: q, exchange: 'BFO', product: 'NRML' }); };
const kc: any = {
  access_token: 'x',
  getPositions: async () => ({ net }),
  getLTP: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { last_price: px.get(tokOf(k)) }])),
  orderMargins: async (legs: any[]) => legs.map((l) => ({ total: l.price * l.quantity, charges: { total: 30 } })),
  getMargins: async () => ({ equity: { available: { live_balance: funds } } }),
  getOrderHistory: async (id: string) => { const o = orders.find((x) => x.id === id); return o ? [o] : []; },
  modifyOrder: async () => ({}),
  cancelOrder: async (_v: string, id: string) => { const o = orders.find((x) => x.id === id)!; if (o.status === 'OPEN') o.status = 'CANCELLED'; },
  getTrades: async () => [],
  getOrders: async () => orders.map((o) => ({ order_id: o.id, tradingsymbol: o.sym, transaction_type: o.side, exchange: 'BFO', filled_quantity: o.filled_quantity, quantity: o.quantity, order_timestamp: new Date(clock).toISOString() })),
};
const db = new Database(':memory:');
db.exec(`CREATE TABLE signal_trades (order_id TEXT, day TEXT, call_id INTEGER); CREATE TABLE signal_calls (id INTEGER, source TEXT);`);
const app = express();
J.registerJodi(app, express, {
  db, getKiteClient: () => kc,
  placeBuy: async (o) => {
    const mode = buyMode[o.tradingsymbol] || 'fill';
    if (mode === 'reject') return { ok: false, error: 'Insufficient funds' };
    const p = px.get(tokOf(o.tradingsymbol))!;
    const ord: Order = { id: `B${orders.length + 1}`, sym: o.tradingsymbol, side: 'BUY', qty: o.quantity, quantity: o.quantity, price: p, status: mode === 'fill' ? 'COMPLETE' : 'OPEN', average_price: mode === 'fill' ? p + 0.5 : 0, filled_quantity: mode === 'fill' ? o.quantity : 0 };
    orders.push(ord); if (mode === 'fill') hold(o.tradingsymbol, o.quantity);
    return { ok: true, orderId: ord.id };
  },
  exitPosition: async (sym, reason) => {
    exitCalls.push(`${sym}|${reason}`);
    if (exitFails > 0) { exitFails--; return { ok: false, error: 'broker said no' }; }
    const p = net.find((x) => x.tradingsymbol === sym && x.quantity !== 0);
    if (!p) return { ok: false, alreadyClosed: true, error: 'no open position' };
    const ord: Order = { id: `S${orders.length + 1}`, sym, side: 'SELL', qty: p.quantity, quantity: p.quantity, price: 0, status: 'COMPLETE', average_price: px.get(tokOf(sym))! - 0.5, filled_quantity: p.quantity };
    orders.push(ord); p.quantity = 0;
    return { ok: true, orderId: ord.id };
  },
  notify: (t) => { said.push(t); },
  liveTick: (tok) => ({ ltp: px.get(tok)!, at: clock }),
  resubscribe: () => {},
  now: () => clock,
  sleep: async () => {},
});
G.registerTradeGuard(app, express, { db, getKiteClient: () => kc });
G.setGuardExempt(J.jodiExempt);
const srv = http.createServer(app).listen(0);
const port = (srv.address() as any).port;
const call = async (method: string, p: string, body?: any) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() as any };
};
const row = (id: string): any => db.prepare('SELECT * FROM jodi_trades WHERE id = ?').get(id);
const fresh = () => { db.exec('DELETE FROM jodi_trades'); orders = []; net = []; said = []; funds = 1e6; buyMode = {}; exitFails = 0; exitCalls = []; clock = DAY0; px.set(111, 120); px.set(222, 112); J.__test.reset(); G.__test.forgetCache(); };
const save = async (o: any = {}) => { const r = await call('POST', '/api/jodi', { ...ASK, ...o }); await sleepReal(30); return r; };
const at = async (ce: number, pe: number) => { px.set(111, ce); px.set(222, pe); clock += 1000; await J.jodiSweep(); await sleepReal(10); };
const buys = () => orders.filter((o) => o.side === 'BUY'), sells = () => orders.filter((o) => o.side === 'SELL');

await ok('his example, start to finish: waits, buys both, cuts the call at half, sells the put at the target', async () => {
  fresh();
  const s = await save();
  assert.equal(s.status, 200); const id = s.body.id;
  assert.equal(row(id).status, 'PENDING'); assert.equal(buys().length, 0, '232 is above 224: nothing bought on saving');
  assert.deepEqual(J.jodiTokens().sort(), [111, 222]); assert.equal(J.jodiManages(CE.tradingsymbol), true);
  await at(116, 110); assert.equal(row(id).status, 'PENDING', '226');
  await at(114, 109.5);
  let r = row(id);
  assert.equal(r.status, 'ACTIVE'); assert.equal(buys().length, 2, 'one buy each, together');
  assert.deepEqual(buys().map((o) => o.qty), [20, 20]);
  assert.deepEqual([r.ce_buy, r.pe_buy, r.ce_held, r.pe_held], [114.5, 110, 1, 1], 'the prices they actually filled at');
  assert.match(said[said.length - 1], /Jodi entered/);
  await at(114, 109.5); await at(100, 125); assert.equal(buys().length, 2, 'never bought twice'); assert.equal(sells().length, 0);
  await at(57.2, 160); assert.equal(sells().length, 1, '57.2 is under half of 114.5');
  r = row(id);
  assert.deepEqual([r.status, r.ce_held, r.pe_held, r.ce_sold], ['ACTIVE', 0, 1, 56.7]); assert.equal(sells()[0].sym, CE.tradingsymbol);
  await at(20, 54); assert.equal(sells().length, 1, 'the put under half is NOT cut: it is the one left');
  await at(5, 247); assert.equal(row(id).status, 'ACTIVE', '56.7 + 247 = 303.7');
  await at(5, 249);
  r = row(id);
  assert.deepEqual([r.status, r.exit_reason, r.pe_held, r.pe_sold], ['DONE', 'TARGET', 0, 248.5]);
  assert.equal(r.pnl, Math.round((56.7 + 248.5 - 114.5 - 110) * 20 * 100) / 100);
  assert.equal(sells().length, 2); assert.equal(net.every((p) => p.quantity === 0), true, 'flat at the broker');
  assert.equal(J.jodiManages(CE.tradingsymbol), false); assert.deepEqual(J.jodiTokens(), []);
  await at(5, 400); assert.equal(sells().length, 2, 'nothing more once it is done');
  const g = await call('GET', '/api/jodi'); assert.equal(g.body.live, null); assert.equal(g.body.today[0].status, 'DONE');
});

await ok('the combined SL sells both, once', async () => {
  fresh();
  const id = (await save()).body.id; await at(112, 110);
  assert.equal(row(id).status, 'ACTIVE');
  await at(58, 42);
  const r = row(id);
  assert.deepEqual([r.status, r.exit_reason, r.ce_held, r.pe_held], ['DONE', 'SL', 0, 0]); assert.equal(sells().length, 2);
  assert.ok(r.pnl < 0); assert.match(said[said.length - 1], /SL hit/);
});

await ok('ticks and the timer at once still buy only once', async () => {
  fresh();
  const id = (await save()).body.id; px.set(111, 112); px.set(222, 110); clock += 1000;
  await Promise.all([J.jodiSweep(), J.jodiSweep(), (async () => { J.jodiOnTick(111, 112); J.jodiOnTick(222, 110); })()]); await sleepReal(30);
  assert.equal(row(id).status, 'ACTIVE'); assert.equal(buys().length, 2);
});

await ok('one buy refused: the other is sold again, and he is told he holds nothing', async () => {
  fresh(); buyMode[PE.tradingsymbol] = 'reject';
  const id = (await save()).body.id; await at(112, 110);
  const r = row(id);
  assert.equal(r.status, 'FAILED'); assert.match(r.detail, /sold again/); assert.match(r.detail, /hold nothing/);
  assert.equal(buys().length, 1); assert.equal(sells().length, 1); assert.equal(net.every((p) => p.quantity === 0), true);
  assert.match(said[said.length - 1], /Jodi not entered/);
  await at(100, 100); assert.equal(buys().length, 1, 'a failed Jodi is not tried again');
});

await ok('one buy that never fills is cancelled, and the other is sold again', async () => {
  fresh(); buyMode[CE.tradingsymbol] = 'stuck';
  const id = (await save()).body.id; await at(112, 110);
  assert.equal(row(id).status, 'FAILED'); assert.equal(orders.find((o) => o.sym === CE.tradingsymbol)!.status, 'CANCELLED');
  assert.equal(net.every((p) => p.quantity === 0), true); assert.match(row(id).detail, /did not fill/);
});

await ok('one side bought and it cannot be sold again: he is told, in capitals, what he holds', async () => {
  fresh(); buyMode[PE.tradingsymbol] = 'reject'; exitFails = 1;
  const id = (await save()).body.id; await at(112, 110);
  assert.equal(row(id).status, 'FAILED'); assert.match(row(id).detail, /YOU ARE HOLDING SENSEX 84100 CE/);
});

await ok('both refused, not enough funds, a contract already held: no Jodi and nothing left over', async () => {
  fresh(); buyMode[CE.tradingsymbol] = 'reject'; buyMode[PE.tradingsymbol] = 'reject';
  let id = (await save()).body.id; await at(112, 110);
  assert.equal(row(id).status, 'FAILED'); assert.equal(orders.length, 0);
  fresh(); funds = 1000;
  id = (await save()).body.id; await at(112, 110);
  assert.equal(row(id).status, 'FAILED'); assert.match(row(id).detail, /not enough funds for both/); assert.equal(orders.length, 0);
  fresh(); hold(PE.tradingsymbol, 20);
  const s = await save(); assert.equal(s.status, 409); assert.match(s.body.error, /already hold SENSEX 84000 PE/);
  fresh(); id = (await save()).body.id; hold(CE.tradingsymbol, 20); await at(112, 110);
  assert.equal(row(id).status, 'FAILED', 'checked again at the moment of entry'); assert.equal(orders.length, 0);
});

await ok('his Exit button: cancels one that is waiting, sells one that is running', async () => {
  fresh();
  let id = (await save()).body.id;
  let x = await call('POST', `/api/jodi/${id}/exit`); assert.deepEqual([x.body.ok, x.body.cancelled], [true, true]);
  assert.equal(row(id).status, 'CANCELLED'); await at(100, 100); assert.equal(orders.length, 0, 'a cancelled Jodi buys nothing');
  fresh();
  id = (await save()).body.id; await at(112, 110); await at(130, 100);
  x = await call('POST', `/api/jodi/${id}/exit`);
  assert.equal(x.body.ok, true); assert.deepEqual([row(id).status, row(id).exit_reason], ['DONE', 'MANUAL']); assert.equal(sells().length, 2);
  x = await call('POST', `/api/jodi/${id}/exit`); assert.equal(x.body.ok, false, 'a second tap sells nothing more'); assert.equal(sells().length, 2);
  assert.equal((await call('POST', '/api/jodi/nope/exit')).status, 404);
});

await ok('3:20 PM: a running Jodi is sold, a waiting one cancelled, and none can be saved after', async () => {
  fresh();
  let id = (await save()).body.id; await at(112, 110);
  clock = DAY0 + (5 * 60 + 19) * 60000; await at(118, 108); assert.equal(row(id).status, 'ACTIVE', '3:19 PM');
  clock = DAY0 + (5 * 60 + 20) * 60000; await at(118, 108);
  assert.deepEqual([row(id).status, row(id).exit_reason], ['DONE', 'TIME']);
  fresh();
  id = (await save()).body.id; clock = DAY0 + (5 * 60 + 20) * 60000; await at(130, 120);
  assert.equal(row(id).status, 'CANCELLED'); assert.equal(orders.length, 0);
  const late = await save(); assert.equal(late.status, 400); assert.match(late.body.error, /Market closed/);
  clock = DAY0 + 86400000; assert.equal((await save()).status, 400, 'Saturday');
});

await ok('one Jodi at a time; a bad one is refused in words', async () => {
  fresh();
  await save(); const again = await save();
  assert.equal(again.status, 409); assert.match(again.body.error, /already waiting or running/);
  fresh(); const bad = await save({ sl: 300 }); assert.equal(bad.status, 400); assert.match(bad.body.error, /SL must be below/);
});

await ok('a leg he sells himself is counted as sold; both sold, the Jodi is closed', async () => {
  fresh();
  const id = (await save()).body.id; await at(112, 110);
  net.find((p) => p.tradingsymbol === CE.tradingsymbol)!.quantity = 0;          // sold from the position card
  px.set(111, 90); clock += 20000; await J.jodiReconcile();
  let r = row(id);
  assert.deepEqual([r.status, r.ce_held, r.ce_sold, r.pe_held], ['ACTIVE', 0, 90, 1]);
  await at(90, 215); assert.equal(row(id).status, 'DONE', '90 + 215 = 305: the target, on what is left'); assert.equal(sells().length, 1);
  fresh();
  const id2 = (await save()).body.id; await at(112, 110);
  for (const p of net) p.quantity = 0; clock += 20000; await J.jodiReconcile();
  r = row(id2); assert.deepEqual([r.status, r.exit_reason], ['DONE', 'CLOSED_BY_YOU']); assert.equal(exitCalls.length, 0, 'nothing sold by the Jodi');
});

await ok('an exit that fails is tried again, three times, then it stops and says so; his Exit tries once more', async () => {
  fresh();
  const id = (await save()).body.id; await at(112, 110); exitFails = 99;
  await at(58, 40); assert.equal(row(id).status, 'ACTIVE', 'back to being managed after the first failure'); assert.equal(row(id).attempts, 1);
  clock += 5000; await at(58, 40); clock += 5000; await at(58, 40);
  let r = row(id);
  assert.equal(r.status, 'ERROR'); assert.match(said[said.length - 1], /Exit it yourself now/);
  const g = await call('GET', '/api/jodi'); assert.equal(g.body.live?.id, id, 'still shown, with its Exit button');
  clock += 5000; const calls = exitCalls.length; await at(58, 40); assert.equal(exitCalls.length, calls, 'not hammered after it has stopped');
  exitFails = 0;
  const x = await call('POST', `/api/jodi/${id}/exit`); assert.equal(x.body.ok, true);
  r = row(id); assert.deepEqual([r.status, r.ce_held, r.pe_held], ['DONE', 0, 0]);
});

await ok('practice: the same rules, and not one order', async () => {
  fresh();
  const id = (await save({ practice: true })).body.id; await at(112, 110);
  assert.equal(row(id).status, 'ACTIVE'); assert.deepEqual([row(id).ce_buy, row(id).pe_buy], [112, 110]);
  assert.equal(J.jodiManages(CE.tradingsymbol), false, 'nothing real to keep the other stops off');
  await at(55, 170); assert.equal(row(id).ce_held, 0); await at(3, 260);
  assert.deepEqual([row(id).status, row(id).exit_reason], ['DONE', 'TARGET']);
  assert.equal(orders.length, 0); assert.equal(exitCalls.length, 0); assert.match(said.join('|'), /practice/);
});

await ok('the Trade Guard neither counts a Jodi nor adds its loss', async () => {
  fresh();
  const id = (await save()).body.id; await at(112, 110);
  const ex = J.jodiExempt(row(id).trade_date);
  assert.deepEqual([...ex.orderIds].sort(), ['B1', 'B2']); assert.deepEqual([...ex.symbols].sort(), [PE.tradingsymbol, CE.tradingsymbol].sort());
  // the broker's day: the Jodi's two buys, and one trade of his own that lost 500
  net.push({ tradingsymbol: 'NIFTY26N2725200CE', quantity: 0, buy_value: 6500, sell_value: 6000, exchange: 'NFO' });
  for (const p of net) if (p.tradingsymbol !== 'NIFTY26N2725200CE') { p.buy_value = 2250 * 2; p.sell_value = 0; p.last_price = 10; }   // the Jodi deep in loss
  orders.push({ id: 'M1', sym: 'NIFTY26N2725200CE', side: 'BUY', qty: 65, quantity: 65, price: 100, status: 'COMPLETE', average_price: 100, filled_quantity: 65 });
  // the guard goes by the real clock's day, whatever day this test pretends it is
  db.prepare('UPDATE jodi_trades SET trade_date = ?').run(G.istDate(Date.now()));
  G.__test.forgetCache();
  const st = (await call('GET', '/api/guard/status')).body;
  assert.equal(st.entriesToday, 1, 'his own trade only'); assert.equal(st.dayPnl, -500, 'his own loss only');
  G.setGuardExempt(null); G.__test.forgetCache();
  const st2 = (await call('GET', '/api/guard/status')).body;
  assert.equal(st2.entriesToday, 3); assert.ok(st2.dayPnl < -4000, 'without the exemption the Jodi would count');
  G.setGuardExempt(J.jodiExempt);
});

srv.close();
console.log(process.exitCode ? 'jodi: FAILED' : `jodi: all checks passed (${n})`);
process.exit(process.exitCode || 0);
