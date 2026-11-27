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
// TWO BASKETS (27 Nov 2026, the same evening). Martin: "The basket in the option
// chain says 0/2. This should be the case only for Jodi trades. When I normally
// open option chain it should allow me to add Atleast 5 and max upto 10 to the
// list." Asked what the ten are for, he chose: "Add to option charts list".
// So the basket has a mode, set by how the chain was opened:
//   'jodi' — from Strategy > Jodi: one Call and one Put, as above.
//   'list' — opened any other way: up to LIST_MAX options, any mix of Calls and
//            Puts, of any index or expiry (the list is kept while the chain's
//            index or expiry is changed). Closed, they all go onto the chart
//            page's list of option charts; no order is placed.
export const LIST_MAX = 10;
export type Basket = { on: boolean; CE: BasketLeg | null; PE: BasketLeg | null; mode?: 'jodi' | 'list'; items?: BasketLeg[] };
/** Pure: the chart-list basket after a tap on `leg`. A tap on one already there takes it off; a full list takes no more. */
export function listTap(b: Basket, leg: BasketLeg): Basket {
  const items = b.items || [];
  if (items.some((x) => x.tradingsymbol === leg.tradingsymbol)) return { ...b, items: items.filter((x) => x.tradingsymbol !== leg.tradingsymbol) };
  if (items.length >= LIST_MAX) return b;
  return { ...b, items: [...items, leg] };
}
export const basketCount = (b: Basket) => (b.mode === 'list' ? (b.items || []).length : (b.CE ? 1 : 0) + (b.PE ? 1 : 0));

const sameChain = (a: BasketLeg, b: BasketLeg) => a.underlying === b.underlying && String(a.expiry || '').slice(0, 10) === String(b.expiry || '').slice(0, 10);

/** Pure: the list after a tap on `leg`. */
export function basketTap(b: Basket, leg: BasketLeg): Basket {
  const cur = b[leg.type];
  if (cur && cur.tradingsymbol === leg.tradingsymbol) return { ...b, [leg.type]: null };          // tapped again: off the list
  const other = leg.type === 'CE' ? b.PE : b.CE;
  const keepOther = other && sameChain(other, leg) ? other : null;
  return { ...b, CE: leg.type === 'CE' ? leg : keepOther, PE: leg.type === 'PE' ? leg : keepOther };
}
export const basketFull = (b: Basket) => !!(b.CE && b.PE);

// NOT EXPIRY DAY (27 Nov 2026). Martin: "Don't forget to add an alert in the card
// when it's not expiry day. It works well only on expiry days". The options he
// picked carry their expiry date; the day is India's, whatever the phone's clock
// zone is (he is in Dubai). null when the expiry is not known: nothing is said
// rather than a warning that may be wrong.
/** Pure: is this expiry (YYYY-MM-DD...) today in India? null if it cannot be told. */
export function expiryIsToday(expiry: string | undefined, nowMs: number = Date.now()): boolean | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(expiry || ''));
  if (!m) return null;
  return new Date(nowMs + 5.5 * 3600000).toISOString().slice(0, 10) === m[1];
}
/** "2026-12-03" -> "3 Dec" */
export function expiryWords(expiry: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expiry || ''));
  return m ? `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]}` : '';
}

let state: Basket = { on: false, CE: null, PE: null, mode: 'list', items: [] };
const subs = new Set<() => void>();
const put = (next: Basket) => { state = next; subs.forEach((f) => { try { f(); } catch (e) {} }); };
export const jodiBasket = {
  get: () => state,
  /** The chain has just been opened: for a Jodi the basket is on and takes two; otherwise it is off, and switched on it takes up to ten for the chart list. */
  open: (jodi: boolean) => put({ on: jodi, CE: null, PE: null, mode: jodi ? 'jodi' : 'list', items: [] }),
  toggle: () => put({ ...state, on: !state.on }),
  tap: (leg: BasketLeg) => put(state.mode === 'list' ? listTap(state, leg) : basketTap(state, leg)),
  remove: (type: 'CE' | 'PE') => put({ ...state, [type]: null }),
  removeItem: (tradingsymbol: string) => put({ ...state, items: (state.items || []).filter((x) => x.tradingsymbol !== tradingsymbol) }),
  clear: () => put({ on: false, CE: null, PE: null, mode: 'list', items: [] }),
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export function useJodiBasket(): Basket {
  const [b, setB] = useState(state);
  useEffect(() => jodiBasket.subscribe(() => setB(jodiBasket.get())), []);
  return b;
}
