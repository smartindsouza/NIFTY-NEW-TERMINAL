// Dhan order mapping (step 3, 11 Nov 2026) against a local fake Dhan — no real
// order is ever sent. Run: npx tsx server/dhan_orders.test.ts
// Uses the real scrip master (images.dhan.co) for contracts and lot sizes.
import http from 'http';
import assert from 'assert/strict';

const seen: any[] = []; let mode: 'ok' | 'reject' | 'hang' = 'ok'; const book = new Map<string, any>();
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = body ? JSON.parse(body) : null; seen.push({ m: req.method, u: req.url, j, h: req.headers });
    const send = (code: number, o: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/orders') {
      const id = String(1000 + book.size);
      const o = { orderId: id, correlationId: j.correlationId, orderStatus: mode === 'reject' ? 'REJECTED' : 'TRADED', transactionType: j.transactionType, exchangeSegment: j.exchangeSegment,
        productType: j.productType, orderType: j.orderType, securityId: j.securityId, quantity: j.quantity, price: j.price, filledQty: mode === 'reject' ? 0 : j.quantity,
        averageTradedPrice: mode === 'reject' ? 0 : j.price - 0.5, remainingQuantity: 0, omsErrorDescription: mode === 'reject' ? 'RMS:Margin Exceeds' : '' };
      book.set(id, o);
      if (mode === 'hang') return;                     // order lands, reply never comes
      return send(200, { orderId: id, orderStatus: o.orderStatus === 'TRADED' ? 'TRANSIT' : 'REJECTED' });
    }
    const ext = req.url!.match(/^\/orders\/external\/(.+)$/);
    if (ext) { const o = [...book.values()].find(x => x.correlationId === decodeURIComponent(ext[1])); return o ? send(200, o) : send(404, { errorMessage: 'not found' }); }
    const one = req.url!.match(/^\/orders\/(\d+)$/);
    if (one && req.method === 'GET') return send(200, book.get(one[1]) || {});
    if (one && req.method === 'DELETE') { const o = book.get(one[1]); if (o) o.orderStatus = 'CANCELLED'; return send(202, { orderId: one[1], orderStatus: 'CANCELLED' }); }
    if (req.url === '/margincalculator') return send(200, { totalMargin: j.price * j.quantity, brokerage: 20, spanMargin: 0, exposureMargin: 0 });
    if (req.url === '/marketfeed/ltp') { const seg = Object.keys(j)[0]; return send(200, { data: { [seg]: { [String(j[seg][0])]: { last_price: 101.25 } } }, status: 'success' }); }
    send(404, { errorMessage: 'no route ' + req.url });
  });
});

(async () => {
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  process.env.DHAN_API_BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
  process.env.DHAN_CLIENT_ID = '1100000001'; process.env.DHAN_ACCESS_TOKEN = 'fake-token';
  delete process.env.DHAN_PIN; delete process.env.DHAN_TOTP_SECRET;
  const A = await import('./dhan_kite_adapter');
  const ok = (m: string) => console.log('ok -', m);
  let on = true;
  const k: any = A.makeDhanKite({ ordersEnabled: () => on });
  await A.ensureInstruments();
  const opt = (await k.getInstruments('NFO')).find((r: any) => r.name === 'NIFTY' && r.instrument_type === 'CE' && r.strike === 25300);
  assert.ok(opt, 'a NIFTY 25300 CE contract'); const lot = opt.lot_size; assert.ok(lot > 1);

  // 1) the app's normal entry: LIMIT, MIS, units — one lot
  const r1 = await k.placeOrder('regular', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', quantity: lot, product: 'MIS', order_type: 'LIMIT', price: 120.35, validity: 'DAY', tag: 'tgsignal' });
  const sent = seen.find(s => s.u === '/orders' && s.m === 'POST')!;
  assert.equal(sent.h['access-token'], 'fake-token'); assert.equal(sent.h['client-id'], '1100000001');
  assert.deepEqual({ ...sent.j, correlationId: 'x' }, { dhanClientId: '1100000001', correlationId: 'x', transactionType: 'BUY', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
    orderType: 'LIMIT', validity: 'DAY', securityId: String(opt.exchange_token), quantity: lot, disclosedQuantity: 0, price: 120.35, triggerPrice: 0,
    afterMarketOrder: false, amoTime: '', boProfitValue: 0, boStopLossValue: 0 });
  assert.match(sent.j.correlationId, /^tgsignal-[a-z0-9]+$/); assert.ok(sent.j.correlationId.length <= 30);
  assert.equal(r1.order_id, '1000');
  ok(`entry: 1 lot = ${lot} units, LIMIT MIS→INTRADAY, NSE_FNO security ${opt.exchange_token}, correlation ${sent.j.correlationId}`);

  // 2) the fill is read back the way the auto-trader reads it (last history row)
  const h = await k.getOrderHistory(r1.order_id); const st = h[h.length - 1];
  assert.equal(st.status, 'COMPLETE'); assert.equal(st.filled_quantity, lot); assert.equal(st.average_price, 119.85); assert.equal(st.product, 'MIS');
  ok('order history: TRADED → COMPLETE with filled qty and average price');

  // 3) exit (NRML position) → MARGIN, SELL
  await k.placeOrder('regular', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'SELL', quantity: lot * 2, product: 'NRML', order_type: 'LIMIT', price: 99.95, validity: 'DAY' });
  const s3 = seen.filter(s => s.u === '/orders' && s.m === 'POST').pop()!.j;
  assert.equal(s3.productType, 'MARGIN'); assert.equal(s3.transactionType, 'SELL'); assert.equal(s3.quantity, lot * 2); assert.match(s3.correlationId, /^app-/);
  ok('exit: NRML → MARGIN, SELL 2 lots');

  // 4) not a whole number of lots → refused before anything is sent
  const before = seen.length;
  await assert.rejects(k.placeOrder('regular', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', quantity: 1, product: 'MIS', order_type: 'LIMIT', price: 100 }), /not a whole number of lots/);
  await assert.rejects(k.placeOrder('regular', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', quantity: lot, product: 'MIS', order_type: 'LIMIT', price: 0 }), /needs a price/);
  await assert.rejects(k.placeOrder('co', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', quantity: lot, product: 'MIS', order_type: 'LIMIT', price: 100 }), /not supported/);
  assert.equal(seen.length, before);
  ok('refused locally: 1 unit (lots mix-up), LIMIT without price, non-regular variety — nothing sent');

  // 5) rejected by Dhan → throws with Dhan's reason (the auto-trader shows it)
  mode = 'reject';
  await assert.rejects(k.placeOrder('regular', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', quantity: lot, product: 'MIS', order_type: 'LIMIT', price: 100 }), /Dhan rejected the order: RMS:Margin Exceeds/);
  ok('rejection surfaces Dhan\'s reason');

  // 6) reply lost but the order landed → found by correlation id, not reported as failed
  mode = 'hang';
  const t0 = Date.now();
  const r6 = await k.placeOrder('regular', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', quantity: lot, product: 'MIS', order_type: 'LIMIT', price: 100, tag: 'tgsignal' }).catch((e: any) => e);
  assert.ok(r6.order_id, `found after a lost reply: ${r6.message || ''}`);
  ok(`lost reply: order ${r6.order_id} found by its correlation id after ${Math.round((Date.now() - t0) / 1000)} s (20 s timeout + lookup)`);
  mode = 'ok';

  // 7) cancel, margins
  const c = await k.cancelOrder('regular', r1.order_id); assert.equal(c.order_id, r1.order_id);
  assert.equal(seen.filter(s => s.m === 'DELETE').pop()!.u, `/orders/${r1.order_id}`);
  const mg = await k.orderMargins([{ exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', product: 'MIS', order_type: 'LIMIT', quantity: lot, price: 120 }]);
  assert.equal(mg[0].total, 120 * lot); assert.equal(mg[0].charges.total, 20);
  const mg0 = await k.orderMargins([{ exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', product: 'MIS', order_type: 'MARKET', quantity: lot, price: 0 }]);
  assert.equal(mg0[0].total, 101.25 * lot);
  ok('cancel → DELETE /orders/{id}; margins in Zerodha shape, MARKET priced at LTP');

  // 8) off switch
  on = false;
  await assert.rejects(k.placeOrder('regular', { exchange: 'NFO', tradingsymbol: opt.tradingsymbol, transaction_type: 'BUY', quantity: lot, product: 'MIS', order_type: 'LIMIT', price: 100 }), /switched off/);
  ok('orders_enabled = 0 blocks placing');
  srv.close(); console.log('ALL PASSED'); process.exit(0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
