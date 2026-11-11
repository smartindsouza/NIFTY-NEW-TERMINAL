// Trade guard: pure rules + the endpoints against a fake Kite. Run: npx tsx server/trade_guard.test.ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import http from 'node:http';
import { verdict, splitChange, normaliseRules, GUARD_DEFAULTS, registerTradeGuard, guardEntryBlock, istDate } from './trade_guard';

const at = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(2026, 10, 11, h, m) - 5.5 * 3600e3; };
const R = GUARD_DEFAULTS;

// ── verdict ──
assert.match(verdict(R, at('09:20'), 0, 0)!, /before 10:00/);
assert.equal(verdict(R, at('10:00'), 0, 0), null);
assert.equal(verdict(R, at('10:05'), 3, -2999), null);
assert.match(verdict(R, at('10:05'), 4, 0)!, /4 trades a day/);
assert.match(verdict(R, at('11:00'), 1, -3000)!, /loss limit/);
assert.equal(verdict({ ...R, enabled: false }, at('09:16'), 99, -99999), null);
assert.equal(verdict(R, at('09:20'), 0, 0, true), null, 'ignoreTime lets My Order be armed early');
assert.equal(verdict(R, at('10:30'), null, null), null, 'unreadable Kite never blocks on count/loss');

// ── normalise ──
assert.equal(normaliseRules({ startTime: '8:00' }).startTime, '09:15');
assert.equal(normaliseRules({ maxTrades: 0 }).maxTrades, 4);
assert.equal(normaliseRules({ maxLoss: 'x' }).maxLoss, 3000);

// ── tighten now, loosen later ──
let sc = splitChange(R, { ...R, maxTrades: 3, maxLoss: 5000 });
assert.equal(sc.now.maxTrades, 3); assert.equal(sc.now.maxLoss, 3000); assert.deepEqual(sc.later, { maxLoss: 5000 });
sc = splitChange(R, { ...R, enabled: false, startTime: '09:30' });
assert.equal(sc.now.enabled, true); assert.equal(sc.now.startTime, '10:00'); assert.deepEqual(sc.later, { enabled: false, startTime: '09:30' });
sc = splitChange(R, { ...R, startTime: '10:30' });
assert.equal(sc.now.startTime, '10:30'); assert.deepEqual(sc.later, {});

// ── endpoints with a fake Kite ──
const db = new Database(':memory:');
db.exec(`CREATE TABLE signal_calls (id INTEGER PRIMARY KEY, source TEXT); CREATE TABLE signal_trades (id INTEGER PRIMARY KEY, call_id INTEGER, day TEXT, order_id TEXT);`);
const today = istDate(Date.now());
db.prepare("INSERT INTO signal_calls (id, source) VALUES (1, 'telegram'), (2, 'manual')").run();
db.prepare('INSERT INTO signal_trades (call_id, day, order_id) VALUES (1, ?, ?), (2, ?, ?)').run(today, 'TG1', today, 'MY1');
let orders: any[] = [], positions: any[] = [];
const kc: any = { access_token: 'x', getOrders: async () => orders, getPositions: async () => ({ net: positions }) };
const app = express();
registerTradeGuard(app, express, { db, getKiteClient: () => kc });
const srv = http.createServer(app).listen(0);
const port = (srv.address() as any).port;
const call = async (method: string, p: string, body?: any) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const buy = (id: string, exch = 'NFO', filled = 65) => ({ order_id: id, transaction_type: 'BUY', exchange: exch, filled_quantity: filled });
orders = [buy('A'), buy('B'), buy('TG1'), buy('MY1'), { order_id: 'S', transaction_type: 'SELL', exchange: 'NFO', filled_quantity: 65 }, buy('R', 'NFO', 0), buy('EQ', 'NSE')];
positions = [{ buy_value: 10000, sell_value: 9000, quantity: 0, last_price: 0 }, { buy_value: 5000, sell_value: 0, quantity: 65, last_price: 70 }];
let s = await call('GET', '/api/guard/status');
assert.equal(s.entriesToday, 3, 'A, B and the My Order count; Telegram, SELL, unfilled and equity do not');
assert.equal(s.dayPnl, -1000 + (4550 - 5000));
// tightening applies at once, relaxing waits
s = await call('POST', '/api/guard/settings', { ...R, maxTrades: 3, maxLoss: 6000 });
assert.equal(s.rules.maxTrades, 3); assert.equal(s.rules.maxLoss, 3000); assert.deepEqual(s.pending, { maxLoss: 6000 });
const nowH = new Date(Date.now() + 5.5 * 3600e3).getUTCHours() * 60 + new Date(Date.now() + 5.5 * 3600e3).getUTCMinutes();
const g1 = await guardEntryBlock();
if (nowH >= 600) assert.match(g1!, /3 trades a day/); else assert.match(g1!, /before 10:00/);
assert.match((await guardEntryBlock({ ignoreTime: true }))!, /3 trades a day/);
// the pending relaxation is promoted on a later day
const row: any = db.prepare("SELECT value FROM trade_guard WHERE key='rules'").get();
const j = JSON.parse(row.value); j.pendingFrom = today; db.prepare("UPDATE trade_guard SET value=? WHERE key='rules'").run(JSON.stringify(j));
s = await call('GET', '/api/guard/status');
assert.equal(s.rules.maxLoss, 6000); assert.equal(s.pending, null);
// loss limit
positions = [{ buy_value: 20000, sell_value: 13000, quantity: 0, last_price: 0 }];
orders = [buy('A')];
assert.match((await guardEntryBlock({ ignoreTime: true }))!, /loss limit ₹6,000/);
// Kite logged out: count/loss rules skipped, never a block from a broker hiccup
kc.access_token = null;
assert.equal(await guardEntryBlock({ ignoreTime: true }), null);
srv.close();
console.log('trade_guard: all checks passed');
