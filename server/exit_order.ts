// AN EXIT ORDER IS FOLLOWED UNTIL IT IS FILLED (17 Nov 2026).
// Martin, 9:40 AM, in a trade on expiry morning: "I took a trade and while
// exiting it wasn't exiting. Then in the kite I realized it had placed a sell
// order." The server log has the tap at 9:35:03: one sell was sent and accepted.
// It was a LIMIT order half a percent under the last traded price, placed and
// then never looked at again. The premium was falling faster than half a
// percent between the price being read and the order arriving, so the order
// sat above the market, unfilled, while the app had already said "exit placed".
//
// What an exit does now:
//   1. It is still a limit order (a market order in an option can fill
//      anywhere), but 3% through the last price — a floor well under the bid,
//      which fills at the bid, not at the floor.
//   2. It is then WATCHED: every 600 ms its status is read, and while it is
//      still open it is re-priced through the price as it is now, a little
//      further each time. Eight looks, about ten seconds at the outside.
//   3. It is "done" only when the broker says COMPLETE. If it is still open
//      after that, the answer says so, in words, and nothing calls the trade
//      closed.
//   4. A SECOND EXIT NEVER SENDS A SECOND ORDER. Before placing, the order book
//      is read: an exit order for this contract that is still open is taken up
//      and followed instead. (Two sells for one long position, both filled,
//      leave him short.) And exits for one contract run one at a time
//      (withExitLock in server.ts), each reading the position afresh.
//   5. If the broker will not re-price an order, it is cancelled and — only
//      once the broker confirms it is off — what is left is sent again.
// The broker is passed in, so all of this is tested without one
// (exit_order.test.ts).

export interface ExitOpts { exchange: string; tradingsymbol: string; qty: number; product: string; side: string }
export interface ExitResult { ok: boolean; orderId?: string; filled?: boolean; error?: string }
export interface ExitDeps { kc: any; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void }

/** An order the exchange still has: not filled, not refused, not cancelled. */
const WAITING = new Set(['OPEN', 'OPEN PENDING', 'MODIFY PENDING', 'MODIFIED', 'TRIGGER PENDING', 'PUT ORDER REQ RECEIVED', 'VALIDATION PENDING', 'MODIFY VALIDATION PENDING', 'UPDATE']);
const DEAD = new Set(['REJECTED', 'CANCELLED']);
export const LOOKS = 8;
export const LOOK_EVERY_MS = 600;

const tick = (p: number) => Math.max(0.05, parseFloat((Math.round(p / 0.05) * 0.05).toFixed(2)));
/** The limit for an exit: 3% through the last price on the first try, 2% further on each look, never more than 15%. */
export function exitLimit(last: number, isBuy: boolean, look: number): number {
  const through = Math.min(0.03 + 0.02 * look, 0.15);
  return tick(last * (isBuy ? 1 + through : 1 - through));
}

export async function placeExitToFill(opts: ExitOpts, deps: ExitDeps): Promise<ExitResult> {
  const { kc } = deps;
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log || (() => {});
  const side = String(opts.side).toUpperCase();
  const isBuy = side === 'BUY';
  const full = `${opts.exchange}:${opts.tradingsymbol}`;
  const lastPrice = async (): Promise<number> => { try { const q = await kc.getQuote([full]); return Number(q?.[full]?.last_price) || 0; } catch { return 0; } };

  try {
    // 4. an exit already at the exchange is followed, not doubled
    let orderId: string | null = null;
    try {
      const book: any[] = (await kc.getOrders()) || [];
      // "An exit already there" is an order of this side for this contract that
      // is still waiting AND is for exactly what is open — which is what an
      // earlier, unfilled exit looks like. A resting order of another size is
      // something he placed himself for another purpose, and is left alone.
      const waitingQty = (o: any) => Number(o.pending_quantity ?? (Number(o.quantity) - (Number(o.filled_quantity) || 0)));
      const mine = book.filter((o) => o && o.tradingsymbol === opts.tradingsymbol && String(o.transaction_type).toUpperCase() === side
        && WAITING.has(String(o.status).toUpperCase()) && String(o.order_type).toUpperCase() === 'LIMIT' && waitingQty(o) === Number(opts.qty));
      if (mine.length) { orderId = String(mine[mine.length - 1].order_id); log(`[exit] ${opts.tradingsymbol}: an exit order is already open (${orderId}) — following it, not sending another`); }
    } catch { /* the book could not be read: go on and place */ }

    if (!orderId) {
      const last = await lastPrice();
      if (!(last > 0)) return { ok: false, error: 'Could not fetch live price for exit' };
      const price = exitLimit(last, isBuy, 0);
      const resp = await kc.placeOrder('regular', {
        exchange: opts.exchange, tradingsymbol: opts.tradingsymbol, transaction_type: side, quantity: opts.qty,
        product: opts.product || 'MIS', order_type: 'LIMIT', price, validity: 'DAY',
      });
      orderId = String(typeof resp === 'string' ? resp : (resp as any).order_id);
      log(`[exit] ${opts.tradingsymbol}: ${side} ${opts.qty} LIMIT ${price} (last ${last}) -> order ${orderId}`);
    }

    // 2. watched until it is filled
    for (let look = 1; look <= LOOKS; look++) {
      await sleep(LOOK_EVERY_MS);
      let st: any = null;
      try { const h = await kc.getOrderHistory(orderId); st = h && h.length ? h[h.length - 1] : null; } catch { continue; }
      const status = String(st?.status || '').toUpperCase();
      if (status === 'COMPLETE') { log(`[exit] ${opts.tradingsymbol}: order ${orderId} filled at ${st.average_price} (look ${look})`); return { ok: true, orderId, filled: true }; }
      if (DEAD.has(status)) { log(`[exit] ${opts.tradingsymbol}: order ${orderId} ${status} ${st?.status_message || ''}`); return { ok: false, orderId, filled: false, error: `Exit order ${status.toLowerCase()}${st?.status_message ? ': ' + st.status_message : ''}` }; }
      if (look === LOOKS) break;
      const last = await lastPrice();
      if (!(last > 0)) continue;
      const price = exitLimit(last, isBuy, look);
      // Only ever towards the market: a sell is not raised, a buy is not lowered.
      const cur = Number(st?.price) || 0;
      if (cur > 0 && (isBuy ? price <= cur : price >= cur)) continue;
      try {
        // The order's own (whole) quantity goes with it unchanged: only the price moves.
        await kc.modifyOrder('regular', orderId, { price, order_type: 'LIMIT', quantity: Number(st?.quantity) || opts.qty, validity: 'DAY' });
        log(`[exit] ${opts.tradingsymbol}: order ${orderId} still open — re-priced ${cur} -> ${price} (last ${last}, look ${look})`);
      } catch (e: any) {
        // The broker would not re-price it. Then it is taken off and what is
        // left of it is sent again at the new price — but only once the broker
        // CONFIRMS it is off: an order that filled while being cancelled must
        // not be followed by a second one.
        log(`[exit] ${opts.tradingsymbol}: re-price refused (${e?.message || e}) — cancelling ${orderId} to send it again`);
        try { await kc.cancelOrder('regular', orderId); } catch { /* it may have just filled: the status below says */ }
        let after: any = null;
        try { const h = await kc.getOrderHistory(orderId); after = h && h.length ? h[h.length - 1] : null; } catch { continue; }
        const s2 = String(after?.status || '').toUpperCase();
        if (s2 === 'COMPLETE') { log(`[exit] ${opts.tradingsymbol}: order ${orderId} filled at ${after.average_price} while being cancelled`); return { ok: true, orderId, filled: true }; }
        if (s2 !== 'CANCELLED') continue;                 // still there: look again
        const left = (Number(after?.quantity) || opts.qty) - (Number(after?.filled_quantity) || 0);
        if (left <= 0) return { ok: true, orderId, filled: true };
        const resp = await kc.placeOrder('regular', {
          exchange: opts.exchange, tradingsymbol: opts.tradingsymbol, transaction_type: side, quantity: left,
          product: opts.product || 'MIS', order_type: 'LIMIT', price, validity: 'DAY',
        });
        orderId = String(typeof resp === 'string' ? resp : (resp as any).order_id);
        log(`[exit] ${opts.tradingsymbol}: sent again — ${side} ${left} LIMIT ${price} -> order ${orderId}`);
      }
    }
    return { ok: false, orderId, filled: false, error: `The exit order is at the broker but NOT filled yet (order ${orderId}). Do not send another — check it in Kite, or tap Exit again to have it re-priced.` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
