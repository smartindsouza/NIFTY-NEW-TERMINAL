// ENTRY PRICE OF THE TRADE THAT IS OPEN NOW (30 Oct 2026, Martin).
//
// Zerodha's net-position `average_price` covers the whole day for a contract.
// Trade 23000 CE once, exit, and buy it again, and the second trade's "average"
// is blended with the first one's buy and sell — on 30 Oct that put the second
// trade's automatic −10% SL a couple of points under the price, and it was hit
// at once. The app's entry line, its default SL/TP and the trailing engine all
// read that one number.
//
// The fix: replay today's fills for that contract, start a fresh leg every time
// the position goes flat, and average only the fills of the leg still open
// (average-cost: partial exits do not change the average, adding does). Used
// only when the contract was reduced or reversed today — otherwise Zerodha's own
// figure is already the right one and nothing extra is fetched.

export interface Fill { tradingsymbol: string; transaction_type: string; quantity: number; average_price?: number; price?: number;
  fill_timestamp?: any; exchange_timestamp?: any; order_timestamp?: any; trade_id?: string | number }

const ts = (f: Fill) => {
  const v = f.fill_timestamp || f.exchange_timestamp || f.order_timestamp;
  const t = v instanceof Date ? v.getTime() : new Date(String(v).replace(' ', 'T') + (String(v).includes('+') || String(v).endsWith('Z') ? '' : '+05:30')).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** Average price and signed quantity of the leg still open after replaying `fills`. */
export function currentLeg(fills: Fill[], tradingsymbol: string): { qty: number; avg: number } {
  const mine = fills.filter(f => f.tradingsymbol === tradingsymbol && Number(f.quantity) > 0)
    .sort((a, b) => ts(a) - ts(b) || String(a.trade_id ?? '').localeCompare(String(b.trade_id ?? '')));
  let pos = 0, avg = 0;
  for (const f of mine) {
    const px = Number(f.average_price ?? f.price);
    if (!(px > 0)) continue;
    const q = (String(f.transaction_type).toUpperCase() === 'BUY' ? 1 : -1) * Number(f.quantity);
    if (pos === 0 || Math.sign(q) === Math.sign(pos)) {           // opening or adding
      avg = (avg * Math.abs(pos) + px * Math.abs(q)) / (Math.abs(pos) + Math.abs(q));
      pos += q;
    } else if (Math.abs(q) < Math.abs(pos)) {                      // partial exit: average unchanged
      pos += q;
    } else if (Math.abs(q) === Math.abs(pos)) {                    // flat: the next fill starts a new leg
      pos = 0; avg = 0;
    } else {                                                       // reversed through zero
      pos += q; avg = px;
    }
  }
  return { qty: pos, avg: Math.round(avg * 100) / 100 };
}

/** Did this net position change direction or size against itself today? Only then is
 *  Zerodha's day average possibly blended. Overnight carries are left alone. */
export function needsLegAverage(p: any): boolean {
  const q = Number(p.quantity) || 0;
  if (!q || Number(p.overnight_quantity) || 0) return false;
  const daySell = Number(p.day_sell_quantity ?? p.sell_quantity) || 0;
  const dayBuy = Number(p.day_buy_quantity ?? p.buy_quantity) || 0;
  return q > 0 ? daySell > 0 : dayBuy > 0;
}
