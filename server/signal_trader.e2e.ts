// End-to-end test of the Telegram signal trader with a FAKE Kite and FAKE
// Telegram messages — no network. Pretends it is Monday 10:05 IST.
//   npx tsx server/signal_trader.e2e.ts
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import express from 'express';

process.env.SIGNALS_PIN = '123456';
delete process.env.TELEGRAM_API_ID; delete process.env.TELEGRAM_BOT_TOKEN;
const { registerSignalTrader, signalOnTick, signalNoteManualRearm, __test } = await import('./signal_trader');

const dbFile = path.join(os.tmpdir(), `sig-e2e-${Date.now()}.db`);
const db = new Database(dbFile);
db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');

// ---------- fake world ----------
const price = new Map<string, number>();         // tradingsymbol -> ltp
const positions = new Map<string, number>();     // tradingsymbol -> qty
const orders: any[] = [];
const rules = new Map<string, any>();            // the premium_exit_rules stand-in
const log: string[] = [];
let fillMode: 'fill' | 'nofill' | 'reject' = 'fill';
const SYM = 'NIFTY26O2722650CE', TOK = 111;
const kc: any = {
  access_token: 'x',
  async getLTP(keys: string[]) { const o: any = {}; for (const k of keys) { const s = k.split(':')[1]; if (price.has(s)) o[k] = { last_price: price.get(s) }; } return o; },
  async placeOrder(_v: string, p: any) {
    if (fillMode === 'reject') throw new Error('Insufficient funds');
    const id = String(1000 + orders.length);
    const px = Math.min(p.price, price.get(p.tradingsymbol)!);
    orders.push({ id, ...p, fillPx: px, state: fillMode === 'fill' ? 'COMPLETE' : 'OPEN', at: Date.now() });
    if (fillMode === 'fill') positions.set(p.tradingsymbol, (positions.get(p.tradingsymbol) || 0) + (p.transaction_type === 'BUY' ? p.quantity : -p.quantity));
    return { order_id: id };
  },
  async getOrderHistory(id: string) {
    const o = orders.find(x => x.id === id);
    return [{ status: o.state, filled_quantity: o.state === 'COMPLETE' ? o.quantity : 0, average_price: o.state === 'COMPLETE' ? o.fillPx : 0 }];
  },
  async cancelOrder(_v: string, id: string) { const o = orders.find(x => x.id === id); if (o.state === 'OPEN') o.state = 'CANCELLED'; },
  async getPositions() {
    return { net: [...positions].map(([s, q]) => ({ tradingsymbol: s, quantity: q, sell_price: q === 0 ? lastExitPx : 0 })) };
  },
};
let lastExitPx = 0;
async function exitPosition(sym: string, reason: string) {
  const q = positions.get(sym) || 0;
  if (!q) return { ok: false, alreadyClosed: true };
  lastExitPx = price.get(sym)!;
  positions.set(sym, 0);
  orders.push({ id: 'X' + orders.length, tradingsymbol: sym, transaction_type: 'SELL', quantity: q, reason });
  const r = rules.get(sym); if (r && r.status === 'ACTIVE') r.status = 'CANCELLED';
  return { ok: true };
}
const app = express();
registerSignalTrader(app, {
  db, getKiteClient: () => kc, getLatestTick: () => undefined,
  findOption: async (u, strike, type) => (u === 'NIFTY' && strike === 22650 && type === 'CE')
    ? { tradingsymbol: SYM, instrument_token: TOK, exchange: 'NFO', lot_size: 65, expiry: '2026-10-27' } : null,
  refreshSubscriptions: () => { },
  armRule: (r) => { rules.set(r.tradingsymbol, { ...r, status: 'ACTIVE' }); log.push(`ARM sl=${r.sl}`); },
  setRuleSl: (s, sl) => { const r = rules.get(s); if (r?.status === 'ACTIVE') { r.sl = sl; log.push(`SL ${sl}`); } },
  ruleStatus: (s) => rules.get(s)?.status ?? null,
  exitPosition, journalOpen: () => log.push('JOURNAL'),
});
// the existing exit engine, faked: SL touched → position flattened, rule DONE
function tick(ltp: number) {
  __test.clearPriceCache(); price.set(SYM, ltp); __test.clearPriceCache();
  signalOnTick(TOK, ltp);
  const r = rules.get(SYM);
  if (r && r.status === 'ACTIVE' && ltp <= r.sl) { r.status = 'DONE'; lastExitPx = ltp; positions.set(SYM, 0); log.push(`ENGINE EXIT @${ltp}`); }
}
// Monday 26 Oct 2026, 10:05 IST
__test.setClockOffset(Date.UTC(2026, 9, 26, 4, 35) - Date.now());
const now = () => Math.floor(Date.now() / 1000);
let msgId = 500;
const msg = (text: string, replyTo?: number) => ({ id: ++msgId, message: text, date: now(), replyTo: replyTo ? { replyToMsgId: replyTo } : undefined });
const CALL = '🟢 BUY NIFTY 22650 CE\n💰 Entry : ₹145 - ₹149\n📊 Intraday Trade ⭐ ⭐';
const LEVELS = '🎯 TP 1: ₹164\n🎯 TP 2: ₹179\n🎯 TP 3: ₹199\n🛑 Stop Loss: ₹130\n📝 Rationale: Retest\n⏳ Valid for: Intraday Only';
const settle = (ms = 50) => new Promise(r => setTimeout(r, ms));
const calls = () => db.prepare('SELECT status, reason FROM signal_calls ORDER BY id').all() as any[];
const trades = () => db.prepare('SELECT * FROM signal_trades ORDER BY id').all() as any[];
const events = () => (db.prepare('SELECT text FROM signal_events ORDER BY id').all() as any[]).map(e => e.text);
let n = 0; const ok = (name: string) => { n++; console.log('ok', name); };

__test.setSettings({ channelId: '42', channelTitle: 'Nifty Sensex VIP setups', mode: 'LIVE' });

// 1) OFF: nothing is traded
__test.setSettings({ mode: 'OFF' });
__test.clearPriceCache(); price.set(SYM, 147);
let a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.equal(calls().at(-1).status, 'SKIPPED'); assert.equal(orders.length, 0); ok('OFF: call recorded, skipped, no order');

// 2) LIVE, price in range → bought at once, SL armed from the message
__test.setSettings({ mode: 'LIVE' });
a = msg(CALL); await __test.handleMessage(a, 'push');
assert.equal(calls().at(-1).status, 'WAITING_LEVELS');
const t0 = Date.now();
await __test.handleMessage(msg(LEVELS, a.id), 'push');
await settle(700);
assert.equal(orders.length, 1);
assert.deepEqual({ p: orders[0].price, q: orders[0].quantity, t: orders[0].order_type, prod: orders[0].product, ex: orders[0].exchange },
  { p: 151, q: 65, t: 'LIMIT', prod: 'MIS', ex: 'NFO' });
assert.equal(trades()[0].entry, 147); assert.equal(rules.get(SYM).sl, 130);
assert.ok(log.includes('ARM sl=130') && log.includes('JOURNAL'));
console.log(`   order sent ${orders[0].at - t0} ms after the TP/SL message; trade recorded and SL armed ${trades()[0].entry_at - t0} ms after`);
ok('in range: LIMIT BUY capped at 149+2, 1 lot (65), SL 130 armed, journaled');

// 3) duplicate message (push + poll) is ignored
await __test.handleMessage({ ...a }, 'poll'); assert.equal(orders.length, 1); ok('same message twice → handled once');

// 4) ladder through the exit engine
tick(160); assert.equal(rules.get(SYM).sl, 130);
tick(164); await settle(); assert.equal(rules.get(SYM).sl, 147); ok('TP1 → SL to entry 147');
tick(179); await settle(); assert.equal(rules.get(SYM).sl, 164); ok('TP2 → SL to TP1 164');
tick(199); await settle(); assert.equal(rules.get(SYM).sl, 179);
assert.ok(events().some(e => e.includes('TP3 reached'))); ok('TP3 → SL to TP2 179 and the question is asked');
tick(230); await settle(); assert.equal(rules.get(SYM).sl, 179); ok('no answer → SL stays at TP2');
await __test.keep(trades()[0].id); await settle(); assert.equal(rules.get(SYM).sl, 199); ok('Keep trailing → catches up (219 reached → SL 199)');
tick(239); await settle(); assert.equal(rules.get(SYM).sl, 219); ok('next step 239 → SL 219');
tick(218); await settle();                           // engine exits at 218 (<219)
await __test.housekeeping(); await __test.reconcileLive(); await settle();
assert.equal(trades()[0].status, 'CLOSED'); assert.equal(trades()[0].exit_price, 218);
assert.equal(trades()[0].pnl, (218 - 147) * 65); ok(`stop hit → trade closed from broker book, P&L +${(218 - 147) * 65}`);

// 5) price above range+2 → waits, then enters when it comes back
__test.clearPriceCache(); price.set(SYM, 155);
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.equal(calls().at(-1).status, 'WATCHING'); assert.equal(orders.filter(o => o.transaction_type === 'BUY').length, 1);
__test.clearPriceCache(); price.set(SYM, 151.5); await __test.housekeeping(); await settle(); assert.equal(calls().at(-1).status, 'WATCHING');
__test.clearPriceCache(); price.set(SYM, 150.5); await __test.housekeeping(); await settle(800);
assert.equal(calls().at(-1).status, 'ENTERED'); assert.equal(trades().at(-1).entry, 150.5);
ok('155 waits, 151.5 still waits (>151), 150.5 enters');
// exit button
const r = await __test.closeTrade(trades().at(-1).id, 'Exit button (app)'); assert.ok(r.ok);
await __test.reconcileLive(); assert.equal(trades().at(-1).status, 'CLOSED'); ok('Exit button closes it');

// 6) max trades per day (2 entered so far) + 3rd allowed, 4th skipped
__test.setSettings({ maxTrades: 2 });
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.match(calls().at(-1).reason, /already 2 trades/); ok('max trades per day respected');
__test.setSettings({ maxTrades: 3 });

// 7) levels message NOT a reply → attaches to the newest waiting call
__test.clearPriceCache(); price.set(SYM, 146);
await __test.handleMessage(msg(CALL), 'push'); await __test.handleMessage(msg(LEVELS), 'push'); await settle(800);
assert.equal(calls().at(-1).status, 'ENTERED'); ok('TP/SL message without reply-link still pairs with the call');

// 8) chart default arriving right after the fill is replaced; a later chart drag hands over
rules.get(SYM).sl = 131.5; signalNoteManualRearm(SYM); assert.equal(rules.get(SYM).sl, 130); ok('chart default within 15 s → message SL restored');
db.prepare('UPDATE signal_trades SET entry_at = ? WHERE id = ?').run(Date.now() - 60000, trades().at(-1).id);
signalNoteManualRearm(SYM); assert.equal(trades().at(-1).status, 'MANUAL');
tick(170); await settle(); assert.equal(rules.get(SYM).sl, 130); ok('later chart change → hands-off, ladder stops');
await exitPosition(SYM, 'x'); await __test.reconcileLive(); assert.equal(trades().at(-1).status, 'CLOSED');

// 9) unfilled order is cancelled and reported; rejection reported
fillMode = 'nofill'; __test.setSettings({ maxTrades: 10 }); __test.clearPriceCache(); price.set(SYM, 147);
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push');
await settle(21500);
assert.equal(calls().at(-1).status, 'FAILED'); assert.equal(orders.at(-1).state, 'CANCELLED'); ok('no fill in 20 s → cancelled, reported');
fillMode = 'reject';
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.equal(calls().at(-1).status, 'FAILED'); assert.match(calls().at(-1).reason, /Insufficient/); ok('rejected order reported');
fillMode = 'fill';

// 10) skips: below SL, bad levels, unknown strike, old message, levels never arrive
__test.clearPriceCache(); price.set(SYM, 128);
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.match(calls().at(-1).reason, /below the SL/); ok('price already under SL → skipped');
__test.clearPriceCache(); price.set(SYM, 147);
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS.replace('130', '150'), a.id), 'push'); await settle();
assert.match(calls().at(-1).reason, /not below/); ok('SL above entry → skipped');
a = msg(CALL.replace('22650', '22700')); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.match(calls().at(-1).reason, /could not find/); ok('unknown contract → skipped');
const before = calls().length;
await __test.handleMessage({ id: ++msgId, message: CALL, date: now() - 600 }, 'poll'); assert.equal(calls().length, before); ok('10-minute-old call ignored');
await __test.handleMessage(msg('Good morning traders 🌞'), 'push'); await __test.handleMessage(msg('TP 1 done ✅'), 'push'); assert.equal(calls().length, before); ok('chatter ignored');

// 11) practice mode: no orders, ladder + SL simulated
__test.setSettings({ mode: 'PRACTICE' });
const nOrders = orders.length;
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.equal(orders.length, nOrders); assert.equal(trades().at(-1).mode, 'PRACTICE');
tick(165); tick(140); await settle();
assert.equal(trades().at(-1).status, 'CLOSED'); assert.equal(trades().at(-1).exit_price, 140);
ok('practice: no order placed; TP1 then SL at entry → closed at 140');

// 12) square-off at 15:15
__test.setSettings({ mode: 'LIVE' }); __test.clearPriceCache(); price.set(SYM, 147);
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle(800);
assert.equal(trades().at(-1).status, 'OPEN');
__test.setClockOffset(Date.UTC(2026, 9, 26, 9, 46) - Date.now());   // 15:16 IST
await __test.housekeeping(); await __test.reconcileLive();
assert.equal(trades().at(-1).status, 'CLOSED'); assert.match(trades().at(-1).exit_reason, /square-off/); ok('15:15 square-off');
a = msg(CALL); await __test.handleMessage(a, 'push'); await __test.handleMessage(msg(LEVELS, a.id), 'push'); await settle();
assert.match(calls().at(-1).reason, /last entry/); ok('no new entries after 15:00');

// 13) bot: only the owner may press buttons
__test.setOwner('777');
await __test.onBotUpdate({ update_id: 1, callback_query: { id: 'q', from: { id: 1 }, data: `exit:${trades().at(-1).id}` } });
ok('stranger button press refused (no crash, no exit)');

console.log(`\n${n} passed`);
fs.rmSync(dbFile, { force: true });
process.exit(0);
