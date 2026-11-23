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

// EACH TRADE'S OWN EXIT AND P&L (23 Nov 2026). Martin: "The Zerodha and my app P&L
// shows a huge difference." He had traded 25750 PE twice that morning: bought
// 163.90, sold 210.85 (+3,051.75), then bought 174.00 and sold 161.75 (-796.25).
// Zerodha said +2,255.50 for the contract. The journal's second row said exit
// 186.30 and +2,255.50, so the day read +5,310.50 against Zerodha's +2,258.75.
// The row had been closed from Zerodha's NET POSITION, whose sell_price is the
// average of BOTH sells ((210.85 + 161.75) / 2 = 186.30) and whose pnl is the
// contract's whole day. Same blending as the entry average above, on the way out.
//
// So a trade's exit is read from the fills too: replay them, and every time the
// position goes flat that is one finished trade with its own entry average, exit
// average and P&L.
export interface ClosedLeg { side: 'BUY' | 'SELL'; qty: number; entry: number; exit: number; pnl: number; entryTime: number; exitTime: number }

// Kite's fill times are IST wall-clock. The kiteconnect library has usually
// already turned them into Date objects read in the SERVER's zone, so the
// components are re-read and anchored to IST (the same correction the journal
// import makes, for the reason written there).
export const fillMs = (f: Fill): number => {
  const v: any = f.fill_timestamp || f.exchange_timestamp || f.order_timestamp;
  if (!v) return 0;
  if (v instanceof Date) {
    const ms = Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds(), v.getMilliseconds()) - 5.5 * 3600000;
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  let str = String(v).trim();
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(str)) str = str.replace(' ', 'T') + '+05:30';
  const ms = new Date(str).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/** Every finished trade in `fills` for one contract, oldest first. */
export function closedLegs(fills: Fill[], tradingsymbol: string): ClosedLeg[] {
  const mine = fills.filter(f => f.tradingsymbol === tradingsymbol && Number(f.quantity) > 0)
    .sort((a, b) => ts(a) - ts(b) || String(a.trade_id ?? '').localeCompare(String(b.trade_id ?? '')));
  const out: ClosedLeg[] = [];
  let pos = 0, avg = 0, opened = 0, exitQty = 0, exitVal = 0, t0 = 0;
  const finish = (when: number) => {
    if (opened > 0 && exitQty > 0) {
      const exit = exitVal / exitQty, long = lastSide === 'BUY';
      out.push({ side: lastSide, qty: opened, entry: Math.round(avg * 100) / 100, exit: Math.round(exit * 100) / 100,
                 pnl: Math.round((long ? exit - avg : avg - exit) * exitQty * 100) / 100, entryTime: t0, exitTime: when });
    }
    pos = 0; avg = 0; opened = 0; exitQty = 0; exitVal = 0; t0 = 0;
  };
  let lastSide: 'BUY' | 'SELL' = 'BUY';
  for (const f of mine) {
    const px = Number(f.average_price ?? f.price);
    if (!(px > 0)) continue;
    const buy = String(f.transaction_type).toUpperCase() === 'BUY';
    let q = Number(f.quantity);
    const when = fillMs(f);
    if (pos !== 0 && (pos > 0) !== buy) {                          // against the open leg: an exit
      const take = Math.min(q, Math.abs(pos));
      exitQty += take; exitVal += take * px; pos += buy ? take : -take; q -= take;
      if (pos === 0) finish(when);
    }
    if (q > 0) {                                                   // opening, adding, or what is left after a reversal
      if (pos === 0) { lastSide = buy ? 'BUY' : 'SELL'; t0 = when; }
      avg = (avg * Math.abs(pos) + px * q) / (Math.abs(pos) + q);
      pos += buy ? q : -q; opened += q;
    }
  }
  return out;
}

/** The finished trade a journal row describes: same side and quantity, entered within two
 *  minutes of the row's entry time; failing a time, the nearest entry price within 1%. */
export function legForRow(legs: ClosedLeg[], row: { side?: string; qty?: number; entry_price?: number | null; entry_time?: number | null }): ClosedLeg | null {
  const side = String(row.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const same = legs.filter(l => l.side === side && l.qty === Number(row.qty));
  const t = Number(row.entry_time) || 0;
  const byTime = same.filter(l => l.entryTime > 0 && t > 0 && Math.abs(l.entryTime - t) <= 120000)
    .sort((a, b) => Math.abs(a.entryTime - t) - Math.abs(b.entryTime - t));
  if (byTime.length) return byTime[0];
  const e = Number(row.entry_price);
  if (!(e > 0)) return null;
  const byPrice = same.filter(l => Math.abs(l.entry - e) <= e * 0.01).sort((a, b) => Math.abs(a.entry - e) - Math.abs(b.entry - e) || b.exitTime - a.exitTime);
  return byPrice.length ? byPrice[0] : null;
}
