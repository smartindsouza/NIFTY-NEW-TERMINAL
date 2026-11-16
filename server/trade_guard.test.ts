// Trade guard: pure rules + the endpoints against a fake Kite. Run: npx tsx server/trade_guard.test.ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import http from 'node:http';
import { verdict, splitChange, normaliseRules, GUARD_DEFAULTS, registerTradeGuard, guardEntryBlock, istDate, countEntries, __test } from './trade_guard';

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

// ── which of the day's orders count as entries ──
{
  const X = 'NIFTY26N1725300CE', Y = 'NIFTY26N1725300PE';
  let seq = 0;
  // an order that filled; `at` is minutes after 10:00, in the broker's own format
  const o = (side: 'BUY' | 'SELL', sym: string, qty = 65, extra: any = {}) => {
    const n = ++seq; const at = extra.at ?? n;
    return { order_id: extra.id ?? `O${n}`, transaction_type: side, tradingsymbol: sym, exchange: extra.exch ?? 'NFO', filled_quantity: extra.filled ?? qty,
      exchange_update_timestamp: `2026-11-16 10:${String(at).padStart(2, '0')}:00` };
  };
  assert.equal(countEntries([], []), 0);
  assert.equal(countEntries([o('BUY', X), o('SELL', X), o('BUY', X), o('SELL', X)], []), 2, 'two round trips on the long side: two entries, the exits are not');
  assert.equal(countEntries([o('BUY', X), o('BUY', X), o('SELL', X, 130)], []), 2, 'adding to a trade is an entry, as it always was');
  assert.equal(countEntries([o('BUY', X), o('SELL', X, 30), o('SELL', X, 35)], []), 1, 'an exit in two parts is still an exit');
  // the short side — what the old "count the buys" rule got wrong
  assert.equal(countEntries([o('SELL', X)], []), 1, 'a sell from flat opens a short: an entry the moment it is opened');
  assert.equal(countEntries([o('SELL', X), o('BUY', X)], []), 1, 'and buying it back is the exit, not a second entry');
  assert.equal(countEntries([o('SELL', X), o('SELL', Y), o('SELL', X)], []), 3, 'shorts opened side by side all count (the old rule counted none of them)');
  assert.equal(countEntries([o('BUY', X), o('SELL', X, 130)], []), 2, 'a sell bigger than the long turns it over: the exit and a new short in one order');
  assert.equal(countEntries([o('SELL', X), o('BUY', X, 130), o('SELL', X)], []), 2, 'and the other way round; the last sell only closes');
  // what was carried in overnight
  assert.equal(countEntries([o('SELL', X)], [{ tradingsymbol: X, overnight_quantity: 65, quantity: 0 }]), 0, 'selling a long held from yesterday is an exit');
  assert.equal(countEntries([o('BUY', X)], [{ tradingsymbol: X, overnight_quantity: -65, quantity: 0 }]), 0, 'covering a short held from yesterday is an exit (the old rule called it an entry)');
  assert.equal(countEntries([o('SELL', X), o('BUY', X)], [{ tradingsymbol: X, overnight_quantity: 65, quantity: 65 }]), 1, 'out of yesterday\'s long, then a new one');
  assert.equal(countEntries([o('SELL', X)], [{ tradingsymbol: X, product: 'NRML', overnight_quantity: 30 }, { tradingsymbol: X.toLowerCase(), product: 'MIS', overnight_quantity: 35 }]), 0, 'both products of one contract are one position');
  assert.equal(countEntries([o('SELL', X)], null), 1, 'positions unreadable: the day is taken to have started flat');
  // the Telegram auto-trader's orders move the position but are never counted
  assert.equal(countEntries([o('BUY', X, 65, { id: 'TG1' }), o('SELL', X, 65, { id: 'TG2' }), o('BUY', X)], [], new Set(['TG1', 'TG2'])), 1, 'its exit is not read as a short of his');
  assert.equal(countEntries([o('BUY', X, 65, { id: 'TG1' }), o('SELL', X)], [], new Set(['TG1'])), 0, 'closing the auto-trade by hand is an exit');
  // what never counts
  assert.equal(countEntries([o('BUY', X, 65, { filled: 0 }), o('BUY', 'INFY', 10, { exch: 'NSE' }), o('SELL', 'SENSEX26N1984000CE', 20, { exch: 'BFO' })], []), 1, 'unfilled and equity orders do not; BFO does');
  // by the time they FILLED, not the time they were placed
  const resting = [o('SELL', X, 130, { at: 30 }), o('BUY', X, 65, { at: 5 }), o('BUY', X, 65, { at: 7 })];
  assert.equal(countEntries(resting, []), 2, 'a resting sell that filled last closes the two buys before it');
  assert.equal(countEntries(resting.map(({ exchange_update_timestamp, ...r }) => r), []), 1, 'with no times the order book\'s own order is used');
  assert.equal(countEntries([{ ...o('BUY', X), exchange_update_timestamp: new Date('2026-11-16T10:05:00+05:30') }, { ...o('SELL', X), exchange_update_timestamp: new Date('2026-11-16T10:09:00+05:30') }], []), 1, 'times given as Date objects (the broker library converts them)');
}

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
// Polls that arrive together on a cold cache share ONE broker read (six polls used
// to cost six orders reads and six positions reads); an entry check still makes
// its own read, even while a poll is in flight.
let nOrders = 0, nPos = 0;
const slow = <T,>(v: () => T) => new Promise<T>(r => setTimeout(() => r(v()), 60));
kc.getOrders = async () => { nOrders++; return slow(() => orders); };
kc.getPositions = async () => { nPos++; return slow(() => ({ net: positions })); };
__test.forgetCache();
const six = await Promise.all(Array.from({ length: 6 }, () => call('GET', '/api/guard/status')));
assert.equal(nOrders, 1, 'six polls together, one orders read'); assert.equal(nPos, 1, 'and one positions read');
assert.ok(six.every((x: any) => x.success && x.entriesToday === 1 && x.dayPnl === -7000), 'every poll gets the same answer');
await call('GET', '/api/guard/status');
assert.equal(nOrders, 1, 'a poll inside 5 s is answered from the cache');
__test.forgetCache(); nOrders = 0; nPos = 0;
await Promise.all([call('GET', '/api/guard/status'), guardEntryBlock({ ignoreTime: true })]);
assert.equal(nOrders, 2, 'an entry check never rides on a poll already in flight'); assert.equal(nPos, 2);
// Kite logged out: count/loss rules skipped, never a block from a broker hiccup
kc.access_token = null;
assert.equal(await guardEntryBlock({ ignoreTime: true }), null);
srv.close();
console.log('trade_guard: all checks passed');
