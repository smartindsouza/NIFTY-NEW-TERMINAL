// Trade charges and capital. Run: npx tsx server/trade_charges.test.ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  estimateOrder, fromZerodha, cardFromReference, rateChanges, segOf, BUILTIN, allocateRow, accountRows, rowCharges,
  initTradeCharges, cardFor, chargesForOrders, captureCapital, journalAccounts, ratesInfo, checkedOn, addCharges, scaleCharges,
  __test, type Charges, type RateCard, type ExecOrder, type OrderCharge, type RowDetail,
} from './trade_charges';

const near = (a: number, b: number, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const NOW = BUILTIN.find(c => c.seg === 'NFO-OPT' && c.from === '2026-04-01')!;

// ── the formula against ZERODHA'S OWN ANSWERS ──
// Read from Zerodha on 16 Nov 2026 through the live account (/margins/orders,
// NIFTY 17 Nov 25100 CE). [side, traded value, Zerodha's charges].
const Z: [ 'BUY' | 'SELL', number, any ][] = [
  ['BUY', 6500, { transaction_tax: 0, exchange_turnover_charge: 2.30945, sebi_turnover_charge: 0.0065, brokerage: 20, stamp_duty: 0, gst: { total: 4.016870999999999 }, total: 26.332821 }],
  ['BUY', 19500, { transaction_tax: 0, exchange_turnover_charge: 6.92835, sebi_turnover_charge: 0.0195, brokerage: 20, stamp_duty: 1, gst: { total: 4.850613 }, total: 32.798463000000005 }],
  ['BUY', 32500, { transaction_tax: 0, exchange_turnover_charge: 11.54725, sebi_turnover_charge: 0.0325, brokerage: 20, stamp_duty: 1, gst: { total: 5.684355 }, total: 38.264105 }],
  ['BUY', 65000, { transaction_tax: 0, exchange_turnover_charge: 23.0945, sebi_turnover_charge: 0.065, brokerage: 20, stamp_duty: 2, gst: { total: 7.76871 }, total: 52.92821 }],
  ['BUY', 130000, { transaction_tax: 0, exchange_turnover_charge: 46.189, sebi_turnover_charge: 0.13, brokerage: 20, stamp_duty: 4, gst: { total: 11.93742 }, total: 82.25642 }],
  ['SELL', 13819, { transaction_tax: 20.7285, exchange_turnover_charge: 4.9098907, sebi_turnover_charge: 0.013819, brokerage: 20, stamp_duty: 0, gst: { total: 4.486267746 }, total: 50.138477446 }],
];
for (const [side, value, z] of Z) {
  const mine = estimateOrder(NOW, side, value), theirs = fromZerodha(z)!;
  for (const k of ['brokerage', 'stt', 'exchange', 'sebi', 'stamp', 'gst', 'total'] as const) near(mine[k], theirs[k], 1e-6, `${side} ${value} ${k}:`);
}
// a one-lot round trip, the size Martin trades: buy 65 at 150, sell at 160
{ const b = estimateOrder(NOW, 'BUY', 65 * 150), s = estimateOrder(NOW, 'SELL', 65 * 160);
  near(b.total + s.total, 20 + 3.464175 + 0.00975 + 0 + 0.18 * (20 + 3.464175 + 0.00975) + 20 + 15.6 + 3.69512 + 0.0104 + 0.18 * (20 + 3.69512 + 0.0104), 1e-6, 'round trip'); }
assert.equal(estimateOrder(NOW, 'BUY', 0).total, 0);
// before April 2026 STT on option sells was 0.10%
initTradeCharges({ db: new Database(':memory:') as any, now: () => Date.UTC(2026, 10, 16, 6, 0) });
assert.equal(cardFor('NFO-OPT', '2026-03-31').sttSell, 0.001); assert.equal(cardFor('NFO-OPT', '2026-04-01').sttSell, 0.0015);
assert.equal(cardFor('NFO-OPT', '2020-01-01').from, '2024-10-01', 'older than every card: the oldest one');
assert.equal(segOf('NFO', 'NIFTY26N1725100CE'), 'NFO-OPT'); assert.equal(segOf('NFO', 'SENSEX26N1980000PE'), 'BFO-OPT');
assert.equal(segOf('BFO', 'SENSEX26NOVFUT'), 'BFO-FUT'); assert.equal(segOf(null, 'NIFTY26NOVFUT'), 'NFO-FUT');
// futures: brokerage is the lower of 0.03% and ₹20
near(estimateOrder(cardFor('NFO-FUT', '2026-11-16'), 'BUY', 50000).brokerage, 15); near(estimateOrder(cardFor('NFO-FUT', '2026-11-16'), 'BUY', 500000).brokerage, 20);

// ── Zerodha's shape ──
assert.equal(fromZerodha(null), null); assert.equal(fromZerodha({ brokerage: 20 }), null); assert.equal(fromZerodha({ ...Z[0][2], brokerage: 'x' }), null);
near(fromZerodha(Z[5][2])!.stt, 20.7285);
const shape = (c: Charges) => ({ transaction_tax: c.stt, transaction_tax_type: 'stt', exchange_turnover_charge: c.exchange, sebi_turnover_charge: c.sebi, brokerage: c.brokerage, stamp_duty: c.stamp, gst: { igst: c.gst, cgst: 0, sgst: 0, total: c.gst }, total: c.total });

// ── learning the rates back from a reference buy and sell ──
{ const V = 1040 * 1000;
  let learned = cardFromReference(NOW, estimateOrder(NOW, 'BUY', V), estimateOrder(NOW, 'SELL', V), V, '2026-11-16');
  assert.deepEqual(rateChanges(NOW, learned), [], 'same rates in, no change out');
  assert.equal(learned.stampBuy, NOW.stampBuy, 'a whole-rupee stamp figure that fits the current rate leaves it alone');
  const hiked: RateCard = { ...NOW, sttSell: 0.002, exchange: 0.0004, brokerageFlat: 40, stampBuy: 0.00006 };
  learned = cardFromReference(NOW, estimateOrder(hiked, 'BUY', V), estimateOrder(hiked, 'SELL', V), V, '2026-11-16');
  near(learned.sttSell, 0.002, 1e-10); near(learned.exchange, 0.0004, 1e-10); assert.equal(learned.brokerageFlat, 40); near(learned.gst, 0.18, 1e-6);
  near(learned.stampBuy, 0.00006, 1e-6, 'stamp:'); assert.equal(learned.source, 'zerodha'); assert.equal(learned.from, '2026-11-16');
  assert.deepEqual(rateChanges(NOW, learned), ['Brokerage ₹20 → ₹40 an order', 'STT on sells 0.15% → 0.2%', 'Exchange charge 0.03553% → 0.04%', 'Stamp duty on buys 0.003% → 0.00596%']);
  // Zerodha answering to the paisa (0.10 where the exact figure is 0.104) must not look like a rate change
  const paise = (c: Charges): Charges => ({ brokerage: Math.round(c.brokerage * 100) / 100, stt: Math.round(c.stt * 100) / 100, exchange: Math.round(c.exchange * 100) / 100, sebi: Math.round(c.sebi * 100) / 100, stamp: c.stamp, gst: Math.round(c.gst * 100) / 100, total: Math.round(c.total * 100) / 100 });
  const small = 1040 * 100;
  assert.deepEqual(rateChanges(NOW, cardFromReference(NOW, paise(estimateOrder(NOW, 'BUY', small)), paise(estimateOrder(NOW, 'SELL', small)), small, '2026-11-16')), [], 'paise rounding is not a change');
  // ...while a real change is still seen through the rounding
  assert.deepEqual(rateChanges(NOW, cardFromReference(NOW, paise(estimateOrder(hiked, 'BUY', small)), paise(estimateOrder(hiked, 'SELL', small)), small, '2026-11-16')).length, 4);
  // a changed brokerage alone is not mistaken for a changed GST rate
  assert.deepEqual(rateChanges(NOW, cardFromReference(NOW, estimateOrder({ ...NOW, brokerageFlat: 40 }, 'BUY', small), estimateOrder({ ...NOW, brokerageFlat: 40 }, 'SELL', small), small, '2026-11-16')), ['Brokerage ₹20 → ₹40 an order']);
  // and the learned card prices a real order as the changed rates would, to the rupee of stamp rounding
  near(estimateOrder(learned, 'SELL', 9750).total, estimateOrder(hiked, 'SELL', 9750).total, 1e-6); }

// ── sharing orders' charges among journal rows ──
const oc = (side: 'BUY' | 'SELL', qty: number, px: number): OrderCharge => ({ qty, charges: estimateOrder(NOW, side, qty * px), source: 'zerodha' });
const row = (o: Partial<Parameters<typeof allocateRow>[0]>) => ({ sym: 'NIFTY26N1725100CE', exchange: 'NFO', side: 'BUY', qty: 65, entryAvg: 100, exitAvg: 120 as number | null, status: 'CLOSED', entryOrderId: 'A' as string | null, entryDay: '2026-11-16', exitDay: '2026-11-16' as string | null, exits: new Map<string, number>([['B', 65]]), ...o });
{ // one order in, one order out
  const priced = new Map([['A', oc('BUY', 65, 100)], ['B', oc('SELL', 65, 120)]]);
  const r = allocateRow(row({}), priced)!;
  near(r.total, Math.round((priced.get('A')!.charges.total + priced.get('B')!.charges.total) * 100) / 100); assert.equal(r.detail.src, 'zerodha'); assert.equal(r.detail.orders, 2);
  // out in two parts (TP1 then the rest): two exit orders, two brokerages
  const two = new Map([['A', oc('BUY', 65, 100)], ['B', oc('SELL', 33, 118)], ['C', oc('SELL', 32, 122)]]);
  const r2 = allocateRow(row({ exits: new Map([['B', 33], ['C', 32]]) }), two)!;
  near(r2.detail.entry.brokerage + r2.detail.exit!.brokerage, 60, 1e-4); assert.equal(r2.detail.orders, 3);
  // one exit order closing two entries: its charges are split by quantity
  const shared = new Map([['A', oc('BUY', 65, 100)], ['A2', oc('BUY', 65, 104)], ['B', oc('SELL', 130, 120)]]);
  const x1 = allocateRow(row({}), shared)!, x2 = allocateRow(row({ entryOrderId: 'A2', entryAvg: 104 }), shared)!;
  near(x1.detail.exit!.total + x2.detail.exit!.total, shared.get('B')!.charges.total, 1e-3); near(x1.detail.exit!.brokerage, 10, 1e-4);
  // an entry order part closed, part still open: each row carries its share
  const part = new Map([['A', oc('BUY', 130, 100)], ['B', oc('SELL', 65, 120)]]);
  const closed = allocateRow(row({}), part)!, open = allocateRow(row({ status: 'OPEN', exitAvg: null, exits: new Map() }), part)!;
  near(closed.detail.entry.total + open.detail.entry.total, part.get('A')!.charges.total, 1e-3); assert.equal(open.detail.exit, null); assert.equal(open.detail.orders, 1);
  // nothing priced (calculator down): the formula, and it says so
  const none = allocateRow(row({}), new Map())!;
  near(none.total, r.total, 0.011); assert.notEqual(none.detail.src, 'zerodha');
  // a carried position keeps the entry charge of the day it was bought
  const prior: RowDetail = { v: 1, src: 'zerodha', entry: { ...oc('BUY', 130, 90).charges }, exit: null, qty: 130, orders: 1 };
  const carried = allocateRow(row({ entryOrderId: 'PRIOR:7', entryDay: '2026-11-13', entryAvg: 90, prior: { detail: prior, qty: 130 } }), new Map([['B', oc('SELL', 65, 120)]]))!;
  near(carried.detail.entry.total, prior.entry.total / 2, 1e-3); assert.equal(carried.detail.src, 'zerodha');
  assert.equal(allocateRow(row({ entryAvg: 0 }), priced), null); }

// ── with storage and a fake Zerodha ──
const db = new Database(':memory:');
db.exec(`CREATE TABLE trade_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, tradingsymbol TEXT, exchange TEXT, side TEXT, qty INTEGER, product TEXT, entry_price REAL, entry_time INTEGER,
  test_mode INTEGER DEFAULT 0, simulated INTEGER DEFAULT 0, status TEXT, exit_price REAL, exit_time INTEGER, pnl REAL, kite_user_id TEXT)`);
let clock = Date.UTC(2026, 10, 16, 5, 0);                     // 10:30 AM IST, Mon 16 Nov 2026
initTradeCharges({ db: db as any, now: () => clock });
assert.ok((db.prepare('PRAGMA table_info(trade_journal)').all() as any[]).some(c => c.name === 'charges_detail'), 'journal columns added');
initTradeCharges({ db: db as any, now: () => clock });        // twice is harmless
let truth: RateCard = NOW; let calls: any[][] = []; let broken: string | null = null;
const kc: any = {
  access_token: 'x',
  getvirtualContractNote: async (orders: any[]) => {
    calls.push(orders); if (broken === 'throw') throw new Error('TokenException'); if (broken === 'short') return orders.slice(1);
    if (broken === 'rates' && String(orders[0].order_id).startsWith('RATES-')) throw new Error('InputException: invalid order');
    return orders.map(o => ({ transaction_type: o.transaction_type, tradingsymbol: o.tradingsymbol, exchange: o.exchange, quantity: o.quantity, price: o.average_price, charges: shape(estimateOrder(truth, o.transaction_type, o.quantity * o.average_price)) }));
  },
};
const ord = (id: string, side: 'BUY' | 'SELL', qty: number, px: number): ExecOrder => ({ order_id: id, exchange: 'NFO', tradingsymbol: 'NIFTY26N1725100CE', transaction_type: side, product: 'MIS', quantity: qty, average_price: px });
const day = '2026-11-16';
assert.equal(ratesInfo().source, 'builtin'); assert.equal(checkedOn('NFO-OPT'), null);
let got = await chargesForOrders(kc, 'ZZ0001', [ord('A', 'BUY', 65, 100), ord('B', 'SELL', 65, 120)], day);
assert.equal(calls.length, 2, 'one call for the two orders, then one reference call for the rates');
assert.deepEqual(calls[0].map(o => o.order_id), ['A', 'B']);
assert.deepEqual(calls[1].map(o => [o.order_id, o.tradingsymbol, o.quantity, o.average_price, o.variety, o.order_type]),
  [['RATES-BUY', 'NIFTY26N1725100CE', 1040, 100, 'regular', 'MARKET'], ['RATES-SELL', 'NIFTY26N1725100CE', 1040, 100, 'regular', 'MARKET']], 'the reference pair: the real contract at its real price, 16 lots');
assert.equal(got.get('A')!.source, 'zerodha'); near(got.get('B')!.charges.total, estimateOrder(NOW, 'SELL', 7800).total);
assert.equal(checkedOn('NFO-OPT'), day, 'rates agreed with Zerodha today'); assert.equal(ratesInfo().source, 'builtin'); assert.equal(ratesInfo().checkedOn, day); assert.equal(ratesInfo().changes, null);
// asked again five minutes later: nothing new to ask
calls = []; got = await chargesForOrders(kc, 'ZZ0001', [ord('A', 'BUY', 65, 100), ord('B', 'SELL', 65, 120)], day);
assert.equal(calls.length, 0); assert.equal(got.get('A')!.source, 'zerodha');
// an order that filled further is asked again; a new one is added; the settled one is not
got = await chargesForOrders(kc, 'ZZ0001', [ord('A', 'BUY', 65, 100), ord('B', 'SELL', 65, 120.5), ord('C', 'BUY', 65, 90)], day);
assert.deepEqual(calls.map(c => c.map(o => o.order_id)), [['B', 'C']]);
// another account's order ids are its own
calls = []; await chargesForOrders(kc, 'YY0002', [ord('A', 'BUY', 130, 50)], day); assert.deepEqual(calls.map(c => c.map(o => o.order_id)), [['A']]);
// the calculator is down: the formula at the checked rates, labelled, and no hammering
broken = 'throw'; calls = [];
got = await chargesForOrders(kc, 'ZZ0001', [ord('D', 'SELL', 65, 70)], day);
assert.equal(got.get('D')!.source, 'rates'); near(got.get('D')!.charges.total, estimateOrder(NOW, 'SELL', 4550).total); assert.equal(calls.length, 1);
await chargesForOrders(kc, 'ZZ0001', [ord('D', 'SELL', 65, 70)], day); assert.equal(calls.length, 1, 'rested for ten minutes after a failure');
clock += 11 * 60 * 1000; broken = 'short';
got = await chargesForOrders(kc, 'ZZ0001', [ord('D', 'SELL', 65, 70), ord('E', 'BUY', 65, 70)], day);
assert.equal(got.get('E')!.source, 'rates', 'an answer of the wrong length is not matched by guesswork');
// back up: the same order now gets Zerodha's figure
clock += 11 * 60 * 1000; broken = null; calls = [];
got = await chargesForOrders(kc, 'ZZ0001', [ord('D', 'SELL', 65, 70)], day); assert.equal(got.get('D')!.source, 'zerodha');
// junk in, nothing out, no throw
assert.equal((await chargesForOrders(kc, 'ZZ0001', [null as any, ord('', 'BUY', 65, 1), ord('Q', 'BUY', 0, 1), ord('R', 'BUY', 65, 0)], day)).size, 0);
assert.equal((await chargesForOrders({}, 'ZZ0001', [ord('S', 'BUY', 65, 10)], day)).get('S')!.source, 'rates', 'a broker with no calculator (Dhan) still gets the formula');

// ── THE RATES CHANGE: the next trading day Zerodha charges 0.20% STT and ₹40 an order ──
clock = Date.UTC(2026, 10, 17, 5, 0); truth = { ...NOW, sttSell: 0.002, brokerageFlat: 40 }; calls = [];
got = await chargesForOrders(kc, 'ZZ0001', [ord('F', 'SELL', 65, 100)], '2026-11-17');
near(got.get('F')!.charges.stt, 13, 1e-6); near(got.get('F')!.charges.brokerage, 40, 1e-6);
assert.equal(cardFor('NFO-OPT', '2026-11-17').sttSell, 0.002); assert.equal(cardFor('NFO-OPT', '2026-11-17').source, 'zerodha');
assert.equal(cardFor('NFO-OPT', '2026-11-16').sttSell, 0.0015, 'yesterday keeps yesterday\'s rates');
assert.deepEqual(ratesInfo().changes, ['Brokerage ₹20 → ₹40 an order', 'STT on sells 0.15% → 0.2%']); assert.equal(ratesInfo().from, '2026-11-17'); assert.equal(ratesInfo().sttSellPct, 0.2);
// a trade the calculator never priced is estimated at the NEW rates from that day on
broken = 'throw'; clock += 11 * 60 * 1000;
near((await chargesForOrders(kc, 'ZZ0001', [ord('G', 'SELL', 65, 100)], '2026-11-17')).get('G')!.charges.total, estimateOrder(truth, 'SELL', 6500).total);
broken = null; __test.resetBackoff();

// ── a rate check the calculator refuses must not stop real orders being priced ──
clock = Date.UTC(2026, 10, 18, 5, 0); broken = 'rates'; calls = []; truth = { ...NOW, sttSell: 0.002, brokerageFlat: 40 };
got = await chargesForOrders(kc, 'ZZ0001', [ord('H', 'BUY', 65, 100)], '2026-11-18');
assert.equal(got.get('H')!.source, 'zerodha', 'the real order is priced'); assert.equal(calls.length, 2); assert.equal(__test.kvGet('learned:NFO-OPT'), '2026-11-17', 'the failed check is not recorded as done');
clock += 5 * 60 * 1000; calls = [];
got = await chargesForOrders(kc, 'ZZ0001', [ord('H', 'BUY', 65, 100), ord('I', 'SELL', 65, 110)], '2026-11-18');
assert.deepEqual(calls.map(c => c.map(o => o.order_id)), [['I']], 'five minutes on: the new order is priced, the rate check is resting for an hour');
assert.equal(got.get('I')!.source, 'zerodha');
clock += 61 * 60 * 1000; broken = null; calls = [];
await chargesForOrders(kc, 'ZZ0001', [ord('H', 'BUY', 65, 100), ord('I', 'SELL', 65, 110)], '2026-11-18');
assert.deepEqual(calls.map(c => c.map(o => o.order_id)), [['RATES-BUY', 'RATES-SELL']], 'an hour on, with nothing new to price, the check is tried again'); assert.equal(__test.kvGet('learned:NFO-OPT'), '2026-11-18');
__test.resetBackoff();

// ── capital ──
clock = Date.UTC(2026, 10, 16, 3, 20);                        // 8:50 AM IST: too early, yesterday's figure may still be showing
let margins = { equity: { net: 99000, available: { opening_balance: 100000, intraday_payin: 0, collateral: 0 }, utilised: { payout: 0 } } };
let mCalls = 0; kc.getMargins = async () => { mCalls++; return margins; };
await captureCapital(kc, 'ZZ0001'); assert.equal(mCalls, 0);
clock = Date.UTC(2026, 10, 16, 4, 35);                        // 10:05 AM IST
await captureCapital(kc, 'ZZ0001'); assert.equal(mCalls, 1);
const cap = () => db.prepare("SELECT * FROM journal_capital WHERE kite_user_id = 'ZZ0001' AND day = '2026-11-16'").get() as any;
assert.equal(cap().opening, 100000);
await captureCapital(kc, 'ZZ0001'); assert.equal(mCalls, 1, 'not again inside four minutes');
clock += 5 * 60 * 1000; margins = { equity: { net: 104000, available: { opening_balance: 123456, intraday_payin: 5000, collateral: 0 }, utilised: { payout: 0 } } };
await captureCapital(kc, 'ZZ0001'); assert.equal(cap().opening, 100000, 'the opening balance is kept as first read'); assert.equal(cap().payin, 5000);
clock = Date.UTC(2026, 10, 16, 13, 0);                        // 6:30 PM IST: Zerodha's end-of-day run may already have moved it
mCalls = 0; await captureCapital(kc, 'ZZ0001'); assert.equal(mCalls, 0);
clock = Date.UTC(2026, 10, 17, 5, 0); kc.getMargins = async () => ({ equity: { net: 1, available: {} } });
await captureCapital(kc, 'ZZ0001'); assert.equal(db.prepare("SELECT COUNT(*) n FROM journal_capital WHERE day = '2026-11-17'").get()!['n' as never], 0, 'no opening balance, no row');
await captureCapital({ access_token: null, getMargins: async () => { throw new Error('x'); } }, 'ZZ0001'); await captureCapital(kc, null);

// ── the journal's view: charges, net and the balance after each trade ──
const ist = (d: string, hm: string) => Date.parse(`${d}T${hm}:00+05:30`);
const ins = db.prepare(`INSERT INTO trade_journal (tradingsymbol, exchange, side, qty, product, entry_price, entry_time, test_mode, simulated, status, exit_price, exit_time, pnl, kite_user_id, charges, charges_detail)
  VALUES (@sym, 'NFO', @side, @qty, 'MIS', @ep, @et, @test, @sim, @status, @xp, @xt, @pnl, @uid, @charges, @detail)`);
const J = (o: any) => Number(ins.run({ sym: 'NIFTY26N1725100CE', side: 'BUY', qty: 65, test: 0, sim: 0, status: 'CLOSED', xp: null, xt: null, pnl: null, uid: 'ZZ0001', charges: null, detail: null, ...o }).lastInsertRowid);
const pricedRow = allocateRow(row({ entryAvg: 100, exitAvg: 120 }), new Map([['A', oc('BUY', 65, 100)], ['B', oc('SELL', 65, 120)]]))!;
const t1 = J({ ep: 100, et: ist(day, '10:05'), xp: 120, xt: ist(day, '10:40'), pnl: 1300, charges: pricedRow.total, detail: JSON.stringify(pricedRow.detail) });   // priced by Zerodha
const t2 = J({ ep: 150, et: ist(day, '11:00'), xp: 140, xt: ist(day, '11:20'), pnl: -650 });                                                                   // never priced: formula
const t3 = J({ ep: 80, et: ist(day, '14:00'), status: 'OPEN' });                                                                                                // still open
const t4 = J({ ep: 90, et: ist('2026-11-13', '15:00'), xp: 95, xt: ist(day, '09:20'), pnl: 325 });                                                             // carried in from Friday
const t5 = J({ ep: 100, et: ist(day, '12:00'), xp: 300, xt: ist(day, '12:30'), pnl: 13000, sim: 1 });                                                          // paper trade
const t6 = J({ ep: 100, et: ist(day, '13:00'), xp: 110, xt: ist(day, '13:10'), pnl: 650, uid: 'YY0002' });                                                     // someone else's
const acc = journalAccounts('ZZ0001', ist(day, '00:00'), ist(day, '23:59'));
assert.equal(acc.byId.has(t6), false, 'another account is not in it'); assert.equal(acc.byId.size, 5);
const A = (id: number) => acc.byId.get(id)!;
near(A(t1).charges!, pricedRow.total); assert.equal(A(t1).chargesSrc, 'zerodha'); near(A(t1).net!, 1300 - pricedRow.total, 0.005);
near(A(t1).breakdown!.brokerage, 40); near(A(t1).breakdown!.stt, 11.7); assert.equal(A(t1).orders, 2);
const c2 = estimateOrder(NOW, 'BUY', 9750).total + estimateOrder(NOW, 'SELL', 9100).total;
near(A(t2).charges!, c2, 0.006); assert.equal(A(t2).chargesSrc, 'rates'); near(A(t2).net!, -650 - c2, 0.006);
near(A(t3).charges!, estimateOrder(NOW, 'BUY', 5200).total, 0.006); assert.equal(A(t3).net, null); assert.equal(A(t3).capitalAfter, null);
// the balance: opened with 1,00,000 and 5,000 added. 9:20 the carried lot is sold (proceeds less the exit charge),
// 10:40 trade 1, 11:20 trade 2; the paper trade moves nothing.
const x4 = estimateOrder(NOW, 'SELL', 65 * 95).total;
near(A(t4).capitalAfter!, 105000 + 65 * 95 - x4, 0.006, 'carried:'); near(A(t1).capitalAfter!, A(t4).capitalAfter! + 1300 - pricedRow.total, 0.011);
near(A(t2).capitalAfter!, A(t1).capitalAfter! - 650 - c2, 0.011); assert.equal(A(t5).capitalAfter, null); assert.ok(A(t5).charges! > 0);
const d = acc.days[day];
assert.equal(d.opening, 100000); assert.equal(d.added, 5000); assert.equal(d.openTrades, 1); assert.equal(d.inOpen, 5200); assert.equal(d.complete, true);
near(d.carriedIn, 65 * 95 - x4, 0.006, 'carried in:'); assert.equal(d.carriedTrades, 1);
// the day adds up: opened with + added + what the carried lot brought back + the day's own trades after every charge = left
near(d.opening + d.added + d.carriedIn + (1300 - pricedRow.total) + (-650 - c2) - estimateOrder(NOW, 'BUY', 5200).total, d.left, 0.02, 'the day adds up:');
near(d.left, A(t2).capitalAfter! - estimateOrder(NOW, 'BUY', 5200).total, 0.011, 'left:');
assert.equal(acc.days['2026-11-13'], undefined, 'no balance was recorded for Friday, so none is shown');
// a row priced while open and then closed by the app's own exit: the exit leg is added by the formula until the next import
const openPriced = allocateRow(row({ status: 'OPEN', exitAvg: null, exits: new Map() }), new Map([['A', oc('BUY', 65, 100)]]))!;
const rc = rowCharges({ tradingsymbol: 'NIFTY26N1725100CE', exchange: 'NFO', side: 'BUY', qty: 65, entry_price: 100, entry_time: ist(day, '10:00'), status: 'CLOSED', exit_price: 120, exit_time: ist(day, '10:30'), charges: openPriced.total, charges_detail: JSON.stringify(openPriced.detail) })!;
near(rc.total, pricedRow.total, 0.011); assert.equal(rc.src, 'rates'); assert.equal(rc.orders, 2);
assert.equal(rowCharges({ tradingsymbol: 'X', qty: 65, entry_price: null, entry_time: 1, status: 'OPEN' }), null);
// a closed row with no exit price (closed at the broker, price unknown) cannot move the balance, and the day says so
J({ ep: 100, et: ist(day, '14:30'), xp: null, xt: ist(day, '14:45'), pnl: null });
assert.equal(journalAccounts('ZZ0001', ist(day, '00:00'), ist(day, '23:59')).days[day].complete, false);
// helpers
near(addCharges(scaleCharges(oc('BUY', 65, 100).charges, 0.25), scaleCharges(oc('BUY', 65, 100).charges, 0.75)).total, oc('BUY', 65, 100).charges.total, 1e-9);
console.log('trade_charges: all checks passed');
