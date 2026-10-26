// End-to-end test of the SECOND ACCOUNT follower with two FAKE Zerodha accounts
// (Martin's and his wife's) and FAKE channel messages — no network.
// Pretends it is Monday 10:05 IST.   npx tsx server/family_trader.e2e.ts
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import express from 'express';

process.env.SIGNALS_PIN = '123456';
process.env.FAMILY_KITE_API_KEY = 'famkey'; process.env.FAMILY_KITE_API_SECRET = 'famsecret'; process.env.FAMILY_KITE_USER_ID = 'WF1234';
delete process.env.TELEGRAM_API_ID; delete process.env.TELEGRAM_BOT_TOKEN;
const { registerSignalTrader, signalOnTick, __test } = await import('./signal_trader');
const { registerFamilyTrader, familyOnTick, familyTokens, __ftest } = await import('./family_trader');

const dbFile = path.join(os.tmpdir(), `fam-e2e-${Date.now()}.db`);
const db = new Database(dbFile);
db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
db.exec('CREATE TABLE kite_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, access_token TEXT, token_date TEXT, kite_user_id TEXT)');
db.prepare('INSERT INTO kite_tokens (access_token, token_date, kite_user_id) VALUES (?,?,?)').run('martin-token', new Date().toISOString().slice(0, 10), 'MD9999');

const price = new Map<string, number>();
const SYM = 'NIFTY26O2722650CE', TOK = 111;
// one fake broker account
function account(name: string) {
  const a: any = { name, orders: [] as any[], positions: new Map<string, { q: number; product: string }[]>(), fillMode: 'fill', funds: 100000, ltpCalls: 0 };
  a.kc = {
    access_token: name + '-token',
    async getLTP(keys: string[]) { a.ltpCalls++; const o: any = {}; for (const k of keys) { const s = k.split(':')[1]; if (price.has(s)) o[k] = { last_price: price.get(s) }; } return o; },
    async orderMargins(o: any[]) { return [{ total: o[0].price * o[0].quantity, charges: { total: 30 } }]; },
    async getMargins() { return { equity: { available: { live_balance: a.funds } } }; },
    async placeOrder(_v: string, p: any) {
      if (a.fillMode === 'reject') throw new Error('Insufficient funds');
      const id = `${name}-${a.orders.length}`;
      const px = p.transaction_type === 'BUY' ? Math.min(p.price, price.get(p.tradingsymbol)!) : Math.max(p.price, price.get(p.tradingsymbol)!);
      const fills = a.fillMode === 'fill' || (a.fillMode === 'nofill-sell' && p.transaction_type === 'BUY');
      a.orders.push({ id, ...p, fillPx: px, state: fills ? 'COMPLETE' : 'OPEN', at: Date.now() });
      if (fills) {
        const list = a.positions.get(p.tradingsymbol) || [];
        let e = list.find((x: any) => x.product === p.product); if (!e) { e = { q: 0, product: p.product }; list.push(e); }
        e.q += p.transaction_type === 'BUY' ? p.quantity : -p.quantity; a.positions.set(p.tradingsymbol, list);
      }
      return { order_id: id };
    },
    async getOrderHistory(id: string) { const o = a.orders.find((x: any) => x.id === id); return [{ status: o.state, filled_quantity: o.state === 'COMPLETE' ? o.quantity : 0, average_price: o.state === 'COMPLETE' ? o.fillPx : 0 }]; },
    async cancelOrder(_v: string, id: string) { const o = a.orders.find((x: any) => x.id === id); if (o.state === 'OPEN') o.state = 'CANCELLED'; },
    async getPositions() { const net: any[] = []; for (const [s, l] of a.positions) for (const e of l) net.push({ tradingsymbol: s, quantity: e.q, product: e.product }); return { net }; },
  };
  return a;
}
const M = account('martin'), W = account('wife');

// Martin's engine with its usual fake exit engine
const rules = new Map<string, any>();
const app = express();
registerSignalTrader(app, {
  db, getKiteClient: () => M.kc, getLatestTick: () => undefined,
  findOption: async (u, strike, type) => (u === 'NIFTY' && strike === 22650 && type === 'CE')
    ? { tradingsymbol: SYM, instrument_token: TOK, exchange: 'NFO', lot_size: 65, expiry: '2026-10-27' } : null,
  refreshSubscriptions: () => { },
  armRule: (r) => { rules.set(r.tradingsymbol, { ...r, status: 'ACTIVE' }); },
  setRuleSl: (s, sl) => { const r = rules.get(s); if (r?.status === 'ACTIVE') r.sl = sl; },
  ruleStatus: (s) => rules.get(s)?.status ?? null,
  exitPosition: async (s) => { const l = M.positions.get(s) || []; for (const e of l) e.q = 0; const r = rules.get(s); if (r) r.status = 'CANCELLED'; return { ok: true }; },
  journalOpen: () => { }, kiteLoggedInToday: () => true, isTradingDay: () => true,
});
let sessUser = 'WF1234';
registerFamilyTrader(app, {
  db, getLatestTick: () => undefined, getMartinKite: () => M.kc, getMartinUserId: () => 'MD9999',
  findOption: async (u, strike, type) => (u === 'NIFTY' && strike === 22650 && type === 'CE')
    ? { tradingsymbol: SYM, instrument_token: TOK, exchange: 'NFO', lot_size: 65, expiry: '2026-10-27' } : null,
  refreshSubscriptions: () => { },
  makeKite: () => W.kc,
  generateSession: async (rt) => ({ access_token: 'wife-access-' + rt, user_id: sessUser, user_name: 'Wife' }),
});
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const get = async (p: string) => fetch(base + p, { redirect: 'manual' });
const post = async (p: string, b: any) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();

function tick(ltp: number) {
  __test.clearPriceCache(); __ftest.clearPriceCache(); price.set(SYM, ltp);
  signalOnTick(TOK, ltp); familyOnTick(TOK, ltp);
  const r = rules.get(SYM);
  if (r && r.status === 'ACTIVE' && ltp <= r.sl) { r.status = 'DONE'; for (const e of M.positions.get(SYM) || []) e.q = 0; }
}
__test.setClockOffset(Date.UTC(2026, 9, 26, 4, 35) - Date.now());
const now = () => Math.floor(Date.now() / 1000);
let msgId = 900;
const msg = (text: string, replyTo?: number) => ({ id: ++msgId, message: text, date: now(), replyTo: replyTo ? { replyToMsgId: replyTo } : undefined });
const CALL = '🟢 BUY NIFTY 22650 CE\n💰 Entry : ₹145 - ₹149\n📊 Intraday Trade';
const LEVELS = '🎯 TP 1: ₹164\n🎯 TP 2: ₹179\n🎯 TP 3: ₹199\n🛑 Stop Loss: ₹130\n⏳ Valid for: Intraday Only';
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));
const fam = () => db.prepare('SELECT * FROM family_trades ORDER BY id').all() as any[];
const sig = () => db.prepare('SELECT * FROM signal_trades ORDER BY id').all() as any[];
const events = () => (db.prepare('SELECT text FROM signal_events ORDER BY id').all() as any[]).map(e => e.text);
let n = 0; const ok = (name: string) => { n++; console.log('ok', name); };
async function sendCall() { price.set(SYM, 147); __test.clearPriceCache(); __ftest.clearPriceCache(); const a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle(900); }
function resetAccounts() { for (const A of [M, W]) { A.orders.length = 0; A.positions.clear(); A.fillMode = 'fill'; } rules.clear(); }
const kiteTokensBefore = JSON.stringify(db.prepare('SELECT * FROM kite_tokens').all());

__test.setSettings({ channelId: '42', channelTitle: 'VIP', mode: 'LIVE', maxTrades: 50 });   // caps tested separately
price.set(SYM, 147);

// 1) her mode OFF (the default): Martin trades exactly as before, nothing for her
await sendCall();
assert.equal(M.orders.length, 1); assert.equal(W.orders.length, 0); assert.equal(fam().length, 0);
ok('second account OFF (default): Martin bought, nothing recorded or ordered for her');
await __test.closeTrade(sig()[0].id, 'test'); resetAccounts();

// 2) login: wrong user refused, Martin's own id refused, her id accepted — kite_tokens untouched
let r = await get('/api/family/kite/login'); assert.equal(r.status, 302); assert.match(r.headers.get('location')!, /kite\.zerodha\.com\/connect\/login\?v=3&api_key=famkey/);
sessUser = 'XX0001'; r = await get('/api/family/kite/callback?status=success&request_token=a');
assert.match(r.headers.get('location')!, /family=wronguser/);
sessUser = 'MD9999'; r = await get('/api/family/kite/callback?status=success&request_token=b');
assert.match(r.headers.get('location')!, /family=wronguser/);
assert.equal((await (await get('/api/family/status')).json()).kite.loggedIn, false);
sessUser = 'WF1234'; r = await get('/api/family/kite/callback?status=success&request_token=c');
assert.match(r.headers.get('location')!, /family=ok/);
assert.equal((await (await get('/api/family/status')).json()).kite.loggedIn, true);
assert.equal(JSON.stringify(db.prepare('SELECT * FROM kite_tokens').all()), kiteTokensBefore);
ok('her login: only FAMILY_KITE_USER_ID accepted (Martin\'s id refused); Martin\'s kite_tokens unchanged');

// 3) settings need the PIN; OFF never does
let d = await post('/api/family/settings', { mode: 'LIVE', pin: '000000' }); assert.equal(d.ok, false);
d = await post('/api/family/settings', { mode: 'LIVE', pin: '123456', lots: 2, name: 'Wife', maxTrades: 10 }); assert.equal(d.ok, true);
ok('her settings: wrong PIN refused, right PIN accepted');

// 4) both LIVE: one order on EACH account, each on its own client, own quantity
await sendCall();
assert.equal(M.orders.length, 1, 'Martin: one order'); assert.equal(W.orders.length, 1, 'wife: one order');
assert.deepEqual({ q: M.orders[0].quantity, p: M.orders[0].price }, { q: 65, p: 151 });
assert.deepEqual({ q: W.orders[0].quantity, p: W.orders[0].price, prod: W.orders[0].product, tag: W.orders[0].tag }, { q: 130, p: 151, prod: 'MIS', tag: 'tgfamily' });
assert.equal(fam()[0].status, 'OPEN'); assert.equal(fam()[0].entry, 147); assert.equal(sig().at(-1).status, 'OPEN');
assert.ok(M.orders[0].at <= W.orders[0].at, 'Martin\'s order goes first');
console.log(`   Martin ordered at +0 ms, wife at +${W.orders[0].at - M.orders[0].at} ms`);
ok('both live: Martin 1 lot on his account, wife 2 lots on hers (LIMIT 151, MIS); Martin first');
assert.ok(familyTokens().includes(TOK)); ok('her contract stays on the live feed while she holds it');

// 5) her ladder: TP1 → SL to entry; back to entry → her exit sells HER qty on HER account only
tick(165);
assert.equal(JSON.parse(fam()[0].ladder).sl, 147);
assert.equal(rules.get(SYM).sl, 147, 'Martin\'s own ladder still moved his rule');
const mOrdersBefore = M.orders.length;
tick(147); await settle(600);
assert.equal(fam()[0].status, 'CLOSED'); assert.equal(fam()[0].exit_reason, 'SL 147 hit');
const sell = W.orders.find((o: any) => o.transaction_type === 'SELL');
assert.deepEqual({ q: sell.quantity, prod: sell.product }, { q: 130, prod: 'MIS' });
assert.equal(M.orders.length, mOrdersBefore, 'no order on Martin\'s account from her exit');
ok('her ladder: TP1 → SL to entry; SL hit → SELL 130 MIS on her account only');
resetAccounts();

// 6) her manual MIS lots in the same contract are not sold: only what the app bought
await __ftest.housekeeping();
W.positions.set(SYM, [{ q: 65, product: 'MIS' }]);          // she already holds 1 lot herself
await sendCall();
let f = fam().at(-1); assert.equal(f.status, 'OPEN');
d = await post('/api/family/exit', { id: f.id }); assert.equal(d.ok, true);
assert.equal(W.orders.find((o: any) => o.transaction_type === 'SELL').quantity, 130);
assert.equal(W.positions.get(SYM)![0].q, 65, 'her own lot is still there');
ok('exit sells only the app\'s 130 qty; her own 65 in the same contract is left alone');
await __test.closeTrade(sig().at(-1).id, 'test'); resetAccounts();

// 7) her exit not filling → retried, then alert; trade stays OPEN for another try
await sendCall();
f = fam().at(-1); W.fillMode = 'nofill-sell';
d = await post('/api/family/exit', { id: f.id });
assert.equal(d.ok, false); assert.equal(fam().at(-1).status, 'OPEN');
assert.equal(W.orders.filter((o: any) => o.transaction_type === 'SELL').length, 3);
assert.ok(events().some(e => /EXIT FAILED/.test(e)));
W.fillMode = 'fill'; d = await post('/api/family/exit', { id: f.id }); assert.equal(d.ok, true);
ok('her exit unfilled: 3 re-priced tries, alert, stays OPEN; next Exit works');
await __test.closeTrade(sig().at(-1).id, 'test'); resetAccounts();

// 8) Telegram buttons reach her trades; Martin's buttons still his
__test.setOwner('77');
await sendCall();
f = fam().at(-1); if (f.status !== 'OPEN') console.log('   DEBUG', f.status, f.reason, fam().map(x => x.status));
await __test.onBotUpdate({ callback_query: { id: 'q1', from: { id: 77 }, data: `fexit:${f.id}` } }); await settle(500);
assert.equal(fam().at(-1).status, 'CLOSED'); assert.equal(sig().at(-1).status, 'OPEN', 'Martin\'s trade untouched by her button');
ok('Telegram "Exit her trade" closes hers only');
await __test.onBotUpdate({ callback_query: { id: 'q2', from: { id: 77 }, data: `exit:${sig().at(-1).id}` } }); await settle(200);
assert.notEqual(sig().at(-1).status, 'OPEN');
ok('Martin\'s own Exit button still works');
resetAccounts();

// 9) Martin OFF, wife LIVE: she still takes the call; Martin places nothing
__test.setSettings({ mode: 'OFF' });
await sendCall();
assert.equal(M.orders.length, 0); assert.equal(W.orders.length, 1); assert.equal(fam().at(-1).status, 'OPEN');
ok('Martin OFF, wife LIVE: only her order');
await __ftest.closeTrade(fam().at(-1).id, 'test'); resetAccounts();
__test.setSettings({ mode: 'LIVE' });

// 10) her daily cap counts only her trades; skipped calls do not order
__ftest.setSettings({ maxTrades: fam().filter(x => x.entry != null).length });
await sendCall();
assert.equal(W.orders.length, 0); assert.equal(M.orders.length, 1); assert.match(fam().at(-1).reason, /already \d+ trades today/);
ok('her max trades a day: she skips, Martin still trades');
await __test.closeTrade(sig().at(-1).id, 'test'); resetAccounts();
__ftest.setSettings({ maxTrades: 10 });

// 11) her order rejected → FAILED + alert; Martin's trade unaffected
W.fillMode = 'reject';
await sendCall();
assert.equal(fam().at(-1).status, 'FAILED'); assert.equal(sig().at(-1).status, 'OPEN');
ok('her order rejected: hers FAILED with alert, Martin bought normally');
await __test.closeTrade(sig().at(-1).id, 'test'); resetAccounts();

// 12) not logged in → skipped with an alert, Martin unaffected
db.prepare('DELETE FROM family_tokens').run();
await sendCall();
assert.equal(W.orders.length, 0); assert.match(fam().at(-1).reason, /not logged in/); assert.equal(M.orders.length, 1);
ok('her Zerodha not logged in: her call skipped with an alert; Martin traded');
await __test.closeTrade(sig().at(-1).id, 'test'); resetAccounts();
sessUser = 'WF1234'; await get('/api/family/kite/callback?status=success&request_token=d');

// 13) practice: no orders on her account, P&L recorded
await post('/api/family/settings', { mode: 'PRACTICE', pin: '123456' });
await sendCall();
f = fam().at(-1); assert.equal(f.mode, 'PRACTICE'); assert.equal(f.status, 'OPEN'); assert.equal(W.orders.length, 0);
tick(129); await settle(100);
assert.equal(fam().at(-1).status, 'CLOSED'); assert.equal(fam().at(-1).pnl, (129 - 147) * 130);
ok('her practice mode: no orders on her account, SL exit and P&L recorded');
resetAccounts();

// 14) square-off at 15:15 closes hers
await post('/api/family/settings', { mode: 'LIVE', pin: '123456' });
await sendCall();
f = fam().at(-1); assert.equal(f.status, 'OPEN');
__test.setClockOffset(Date.UTC(2026, 9, 26, 9, 46) - Date.now());   // 15:16 IST
await __ftest.housekeeping(); await settle(600);
assert.equal(fam().at(-1).status, 'CLOSED'); assert.match(fam().at(-1).exit_reason, /square-off/);
ok('square-off 15:15 closes her open trade');
__test.setClockOffset(Date.UTC(2026, 9, 26, 4, 35) - Date.now());
await __test.closeTrade(sig().at(-1).id, 'test'); resetAccounts();

// 15) closed by hand in her Kite → noticed after two checks, no sell order sent
await sendCall();
f = fam().at(-1); W.positions.set(SYM, [{ q: 0, product: 'MIS' }]);
for (let i = 0; i < 2; i++) { (globalThis as any).__noop = 0; await new Promise(r => setTimeout(r, 15100)); await __ftest.housekeeping(); }
assert.equal(fam().at(-1).status, 'CLOSED'); assert.match(fam().at(-1).exit_reason, /outside the app/);
assert.equal(W.orders.filter((o: any) => o.transaction_type === 'SELL').length, 0);
ok('closed by hand in her Kite: recorded, no sell order sent');
await __test.closeTrade(sig().at(-1).id, 'test'); resetAccounts();

// 16) switching her OFF needs no PIN; then calls are ignored for her
d = await post('/api/family/settings', { mode: 'OFF' }); assert.equal(d.ok, true);
const before = fam().length;
await sendCall();
assert.equal(fam().length, before); assert.equal(W.orders.length, 0); assert.equal(M.orders.length, 1);
ok('her OFF needs no PIN; then nothing for her, Martin unchanged');

console.log(`\n${n} passed`);
server.close();
fs.rmSync(dbFile, { force: true });
process.exit(0);
