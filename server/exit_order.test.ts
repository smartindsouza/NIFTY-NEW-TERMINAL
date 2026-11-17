// npx tsx server/exit_order.test.ts
import assert from 'node:assert/strict';
import { placeExitToFill, exitLimit, LOOKS } from './exit_order';

// A broker whose market can be made to fall away from a resting order.
function broker(o: { last: number; fall?: number; fillsWhen?: (price: number, last: number) => boolean; book?: any[]; rejectModify?: boolean }) {
  const st = { last: o.last, orders: [...(o.book || [])] as any[], placed: 0, modified: [] as number[] };
  const fills = o.fillsWhen || ((price: number, last: number) => price <= last);
  const settle = () => { for (const x of st.orders) if (x.status === 'OPEN' && fills(x.price, st.last)) { x.status = 'COMPLETE'; x.average_price = st.last; } };
  const kc = {
    async getQuote(keys: string[]) { st.last = +(st.last - (o.fall || 0)).toFixed(2); return { [keys[0]]: { last_price: st.last } }; },
    async getOrders() { return st.orders; },
    async placeOrder(_v: string, p: any) { st.placed++; const id = 'O' + st.orders.length; st.orders.push({ order_id: id, tradingsymbol: p.tradingsymbol, transaction_type: p.transaction_type, order_type: 'LIMIT', price: p.price, quantity: p.quantity, status: 'OPEN' }); st.last = +(st.last - (o.fall || 0) * 3).toFixed(2); settle(); return { order_id: id }; },
    async getOrderHistory(id: string) { settle(); return [st.orders.find((x) => x.order_id === id)]; },
    async modifyOrder(_v: string, id: string, p: any) { if (o.rejectModify) throw new Error('modify refused'); const x = st.orders.find((y) => y.order_id === id); x.price = p.price; st.modified.push(p.price); settle(); return { order_id: id }; },
  };
  return { kc, st };
}
const opts = { exchange: 'NFO', tradingsymbol: 'NIFTY26N1725450PE', qty: 65, product: 'MIS', side: 'SELL' };
const sleep = async () => {};

(async () => {
  // the price: 3% through, then 2% more a look, capped, on the tick
  assert.equal(exitLimit(150, false, 0), 145.5); assert.equal(exitLimit(150, true, 0), 154.5);
  assert.equal(exitLimit(150, false, 1), 142.5); assert.equal(exitLimit(150, false, 99), 127.5);
  assert.equal(exitLimit(0.1, false, 0), 0.1); assert.equal(exitLimit(0.01, false, 0), 0.05, 'never under a tick');

  // a quiet market: one order, filled at once, nothing re-priced
  { const b = broker({ last: 150 }); const r = await placeExitToFill(opts, { kc: b.kc, sleep });
    assert.deepEqual([r.ok, r.filled, b.st.placed, b.st.modified.length], [true, true, 1, 0]); }

  // 17 Nov: the premium falls away faster than the old half percent. The order rests, is re-priced, and fills.
  { const b = broker({ last: 150, fall: 2.5 }); const r = await placeExitToFill(opts, { kc: b.kc, sleep });
    assert.equal(r.ok, true); assert.equal(r.filled, true); assert.equal(b.st.placed, 1, 'still one order');
    assert.ok(b.st.modified.length >= 1, 're-priced at least once');
    for (let i = 1; i < b.st.modified.length; i++) assert.ok(b.st.modified[i] < b.st.modified[i - 1], 'a sell is only ever lowered'); }

  // an exit order already resting at the broker (his second tap): followed, never doubled
  { const b = broker({ last: 150, book: [{ order_id: 'OLD', tradingsymbol: opts.tradingsymbol, transaction_type: 'SELL', order_type: 'LIMIT', price: 155, quantity: 65, status: 'OPEN' }] });
    const r = await placeExitToFill(opts, { kc: b.kc, sleep });
    assert.deepEqual([r.ok, r.filled, r.orderId, b.st.placed], [true, true, 'OLD', 0]); assert.ok(b.st.modified[0] < 150); }
  // ...but a resting BUY, or another contract's sell, is not taken for it
  { const b = broker({ last: 150, book: [{ order_id: 'B', tradingsymbol: opts.tradingsymbol, transaction_type: 'BUY', order_type: 'LIMIT', price: 100, quantity: 65, status: 'OPEN' }, { order_id: 'X', tradingsymbol: 'OTHER', transaction_type: 'SELL', order_type: 'LIMIT', price: 999, quantity: 65, status: 'OPEN' }], fillsWhen: (p, l) => p <= l && p > 120 });
    const r = await placeExitToFill(opts, { kc: b.kc, sleep }); assert.equal(b.st.placed, 1); assert.equal(r.filled, true); assert.notEqual(r.orderId, 'B'); }

  // a resting sell of ANOTHER size is his own order for something else: left alone, a new exit is sent
  { const b = broker({ last: 150, book: [{ order_id: 'T', tradingsymbol: opts.tradingsymbol, transaction_type: 'SELL', order_type: 'LIMIT', price: 190, quantity: 130, status: 'OPEN' }], fillsWhen: (p, l) => p <= l });
    const r = await placeExitToFill(opts, { kc: b.kc, sleep }); assert.equal(b.st.placed, 1); assert.notEqual(r.orderId, 'T'); assert.equal(b.st.orders[0].price, 190, 'not re-priced'); }
  // a partly filled earlier exit (35 of 65 done, 30 waiting) with 30 still open: followed
  { const b = broker({ last: 150, book: [{ order_id: 'P', tradingsymbol: opts.tradingsymbol, transaction_type: 'SELL', order_type: 'LIMIT', price: 160, quantity: 65, filled_quantity: 35, pending_quantity: 30, status: 'OPEN' }] });
    const r = await placeExitToFill({ ...opts, qty: 30 }, { kc: b.kc, sleep }); assert.deepEqual([r.orderId, r.filled, b.st.placed], ['P', true, 0]); }

  // the broker refuses to re-price: the order is cancelled, and only what was left of it is sent again
  { const b = broker({ last: 150, fall: 2.5, rejectModify: true });
    const cancelled: string[] = [];
    const kc = { ...b.kc, async cancelOrder(_v: string, id: string) { const x = b.st.orders.find((y) => y.order_id === id); if (x.status === 'OPEN') { x.status = 'CANCELLED'; x.filled_quantity = 20; } cancelled.push(id); return { order_id: id }; } };
    const r = await placeExitToFill(opts, { kc, sleep });
    assert.equal(r.filled, true); assert.equal(cancelled.length >= 1, true);
    assert.equal(b.st.orders[1].quantity, 45, '65 less the 20 that had filled');
    assert.equal(b.st.orders.filter((x) => x.status === 'OPEN').length, 0, 'nothing left resting'); }
  // ...and if it filled while being cancelled, nothing more is sent
  { const b = broker({ last: 150, fall: 2.5, rejectModify: true });
    const kc = { ...b.kc, async cancelOrder(_v: string, id: string) { const x = b.st.orders.find((y) => y.order_id === id); x.status = 'COMPLETE'; x.average_price = 140; throw new Error('order already complete'); } };
    const r = await placeExitToFill(opts, { kc, sleep }); assert.deepEqual([r.ok, r.filled, b.st.placed], [true, true, 1]); }

  // never fills: it says so, it is not "ok", and there is still only one order
  { const b = broker({ last: 150, fillsWhen: () => false }); const r = await placeExitToFill(opts, { kc: b.kc, sleep });
    assert.equal(r.ok, false); assert.equal(r.filled, false); assert.match(r.error!, /NOT filled/); assert.equal(b.st.placed, 1); assert.ok(b.st.modified.length <= LOOKS); }
  // refused by the broker
  { const b = broker({ last: 150, fillsWhen: () => false }); const kc = { ...b.kc, async getOrderHistory() { return [{ status: 'REJECTED', status_message: 'Insufficient funds' }]; } };
    const r = await placeExitToFill(opts, { kc, sleep }); assert.equal(r.ok, false); assert.match(r.error!, /rejected: Insufficient funds/); }
  // no price: nothing is sent
  { const b = broker({ last: 0 }); const r = await placeExitToFill(opts, { kc: b.kc, sleep }); assert.equal(r.ok, false); assert.equal(b.st.placed, 0); }
  // covering a short: a buy, priced above, only ever raised
  { const b = broker({ last: 150, fall: -2.5, fillsWhen: (p, l) => p >= l }); const r = await placeExitToFill({ ...opts, side: 'BUY' }, { kc: b.kc, sleep });
    assert.equal(r.filled, true); for (let i = 1; i < b.st.modified.length; i++) assert.ok(b.st.modified[i] > b.st.modified[i - 1]); }
  console.log('exit_order: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
