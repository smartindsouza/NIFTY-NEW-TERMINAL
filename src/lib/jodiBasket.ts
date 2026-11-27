// THE BASKET IN THE OPTION CHAIN (27 Nov 2026). Martin: "Add a basket order
// button in the option chain to add options to the list." and "The Jodi Button
// should show me the option chain with basket order on. So that I can add the 2
// options to the Jodi list. Once the 2 are added and I close it, open a small
// card..."
//
// With the basket on, a tap on a price in the chain does not open that option's
// chart: it puts the option on the Jodi list, one Call and one Put. A second
// Call replaces the first (a Jodi has one of each); a tap on an option already
// on the list takes it off. The two must be of the same index and expiry, so an
// option of another index or expiry starts the list again with itself.
//
// Kept here, outside the chain's own component: the chain is rebuilt whenever
// its index is changed, and the list must still be there when it is closed.
import { useEffect, useState } from 'react';

export type BasketLeg = {
  type: 'CE' | 'PE'; tradingsymbol: string; instrument_token: string; exchange: string;
  lot_size?: number; strike: number; expiry?: string; underlying: string; ltp: number;
};
export type Basket = { on: boolean; CE: BasketLeg | null; PE: BasketLeg | null };

const sameChain = (a: BasketLeg, b: BasketLeg) => a.underlying === b.underlying && String(a.expiry || '').slice(0, 10) === String(b.expiry || '').slice(0, 10);

/** Pure: the list after a tap on `leg`. */
export function basketTap(b: Basket, leg: BasketLeg): Basket {
  const cur = b[leg.type];
  if (cur && cur.tradingsymbol === leg.tradingsymbol) return { ...b, [leg.type]: null };          // tapped again: off the list
  const other = leg.type === 'CE' ? b.PE : b.CE;
  const keepOther = other && sameChain(other, leg) ? other : null;
  return { on: b.on, CE: leg.type === 'CE' ? leg : keepOther, PE: leg.type === 'PE' ? leg : keepOther };
}
export const basketFull = (b: Basket) => !!(b.CE && b.PE);

let state: Basket = { on: false, CE: null, PE: null };
const subs = new Set<() => void>();
const put = (next: Basket) => { state = next; subs.forEach((f) => { try { f(); } catch (e) {} }); };
export const jodiBasket = {
  get: () => state,
  /** The chain has just been opened: the basket on or off as asked, and an empty list. */
  open: (on: boolean) => put({ on, CE: null, PE: null }),
  toggle: () => put({ ...state, on: !state.on }),
  tap: (leg: BasketLeg) => put(basketTap(state, leg)),
  remove: (type: 'CE' | 'PE') => put({ ...state, [type]: null }),
  clear: () => put({ on: false, CE: null, PE: null }),
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export function useJodiBasket(): Basket {
  const [b, setB] = useState(state);
  useEffect(() => jodiBasket.subscribe(() => setB(jodiBasket.get())), []);
  return b;
}
