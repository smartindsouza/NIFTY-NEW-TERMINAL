// JODI — A PAIR OF OPTIONS BOUGHT TOGETHER AND MANAGED AS ONE TRADE (27 Nov 2026).
//
// Martin: "I have a strategy called Jodi. Here I buy similar quantities of one
// call above the spot and one put below the spot. There will be a combined
// premium of both options bought, SL and a target. When the premium of any one of
// the two reduces to less than half of price bought, that option is sold/exited.
// The other will go on until reaching target." His example, on SENSEX: 84100 CE
// @114, 84000 PE @110, net combined 220-225, SL 100, target 300-310. "Exit both
// when big move happens." "It is done only on the days of expiry."
//
// And how he wants to take it in the app: "The Jodi Button should show me the
// option chain with basket order on. So that I can add the 2 options to the Jodi
// list. Once the 2 are added and I close it, open a small card with a blurred
// background to add the entry price for each option, combined Premium and SL,
// Target etc. once saved the trades should activate automatically when the entry
// price is hit. Note that both premium prices need not be exactly same since it
// will not be in most cases. 4 - 5 points difference is ok as long as the
// combined premium is maintained. Also I need a manual exit button to exit the
// Jodi trade when it's active as well".
//
// THREE THINGS HE CHOSE WHEN ASKED (27 Nov, 9:41 AM):
//   * ENTRY: "Both together" — both options are bought at the same moment, when
//     their two live prices added together are at or below his combined premium.
//     Never one leg on its own: a Jodi with one side is a plain option he did
//     not ask to hold.
//   * TRADE GUARD: "Ignore Trade Guard" — a Jodi is not stopped by his start
//     time, trade count or daily loss rules, and is not counted towards them
//     (jodiExempt below, read by server/trade_guard.ts).
//   * END OF DAY: "Exit at 3:20 PM" — whatever is still held is sold at 3:20 PM,
//     and a Jodi saved but never entered is cancelled then.
//
// THE RULES, once it is in (the same ones backtested that morning — project doc
// jodi-strategy-backtest-nov-2026, where they LOST money on NIFTY and BANKNIFTY
// taken mechanically; he was shown that before asking for this to be built):
//   * COMBINED VALUE = what was received for a leg already sold + the live price
//     of each leg still held.
//   * It reaches the TARGET: everything held is sold.
//   * It falls to the SL: everything held is sold.
//   * While BOTH are held, a leg whose price is below half of what it was bought
//     for is sold, and the other runs on. The one left is never "cut": only the
//     combined SL, the target, 3:20 PM or his own Exit closes it.
//
// THIS PLACES ORDERS WHILE HE IS NOT LOOKING, so, as in server/triggers.ts:
//   * SERVER-SIDE AND SAVED. Rows live in sqlite and are picked up again after a
//     restart; an ACTIVE Jodi goes on being managed.
//   * EVERY STEP IS CLAIMED ONCE. Ticks arrive many times a second and a timer
//     runs beside them; a single conditional UPDATE decides who may place an
//     order, and one Jodi does one thing at a time.
//   * NEVER LEFT WITH ONE SIDE. If one buy is refused or does not fill, the other
//     is sold again at once, the Jodi is marked FAILED with the reason, and he is
//     told. Funds for both are checked before either order is sent.
//   * A RESTART WHILE BUYING IS FLAGGED, NOT RETRIED: the server cannot know
//     whether those orders reached the broker.
//   * EXITS GO THROUGH THE APP'S OWN EXIT (followed until filled, one at a time
//     per contract, reading the real position). A failed exit is tried again on
//     the next look, three times, then it stops and tells him to exit himself.
//   * WHAT HE DOES HIMSELF IS RESPECTED. A leg he sells from the position card or
//     in Kite is seen within seconds and counted as sold at what it fetched.
//   * THE APP'S OTHER AUTOMATIC STOPS KEEP THEIR HANDS OFF: the chart's default
//     -10% / +20% SL and TP and the Structure SL are not applied to a Jodi's legs
//     (jodiManages, read by server.ts). A stop he sets on a leg himself still is.
//   * ONE JODI AT A TIME, and not in a contract he already holds: the exit sells
//     the whole position in that contract.
//
// PRACTICE: a Jodi saved with Practice on sends no order at all. It is "bought"
// and "sold" at the live prices and shows what would have happened.

import { closedLegs } from './leg_average';
import { isNseHoliday } from './calendar_service';

const IST_MS = 5.5 * 3600 * 1000;
export const JODI_OPEN_MIN = 9 * 60 + 15, JODI_EXIT_MIN = 15 * 60 + 20;      // 9:15 AM, 3:20 PM IST
export const JODI_CUT = 0.5;
const LIVE = ['PENDING', 'ENTERING', 'ACTIVE', 'EXITING'];

export type JodiStatus = 'PENDING' | 'ENTERING' | 'ACTIVE' | 'EXITING' | 'DONE' | 'CANCELLED' | 'FAILED' | 'ERROR';
export type Leg = 'ce' | 'pe';

// ───────────────────────── the pure rules ─────────────────────────

/** NIFTY26N2325250CE -> { root NIFTY, expiry 26N23, strike 25250, type CE }. Monthly: NIFTY26NOV25750PE. */
export function parseOption(sym: string): { root: string; expiry: string; strike: number; type: 'CE' | 'PE' } | null {
  const m = /^([A-Z]+)(\d{2}[A-Z0-9]{3})(\d+)(CE|PE)$/.exec(String(sym || '').toUpperCase());
  return m ? { root: m[1], expiry: m[2], strike: Number(m[3]), type: m[4] as 'CE' | 'PE' } : null;
}

export interface JodiInput {
  ce: { tradingsymbol: string; exchange?: string; instrument_token: number | string; lot_size?: number };
  pe: { tradingsymbol: string; exchange?: string; instrument_token: number | string; lot_size?: number };
  lots: number; ceEntry: number; peEntry: number; combined: number; sl: number; target: number; practice?: boolean;
}

/** What is wrong with a Jodi as asked for, in words he can act on; null when nothing is. */
export function validateJodi(b: any): string | null {
  const c = parseOption(b?.ce?.tradingsymbol), p = parseOption(b?.pe?.tradingsymbol);
  if (!c || c.type !== 'CE') return 'The first option must be a Call.';
  if (!p || p.type !== 'PE') return 'The second option must be a Put.';
  if (c.root !== p.root || c.expiry !== p.expiry) return 'Both options must be of the same index and the same expiry.';
  if (!(Number(b.ce.instrument_token) > 0) || !(Number(b.pe.instrument_token) > 0)) return 'An option is missing its contract details — pick it from the option chain again.';
  const lots = Number(b.lots);
  if (!Number.isInteger(lots) || lots < 1 || lots > 50) return 'Lots must be a whole number from 1 to 50.';
  const lot = Number(b.ce.lot_size) || Number(b.pe.lot_size);
  if (!(lot > 0)) return 'The lot size of this contract is not known — pick it from the option chain again.';
  const comb = Number(b.combined), sl = Number(b.sl), tg = Number(b.target);
  if (!(Number(b.ceEntry) > 0) || !(Number(b.peEntry) > 0)) return 'Type an entry price for each option.';
  if (!(comb > 0)) return 'Type the combined premium.';
  if (!(sl >= 0) || !(sl < comb)) return 'The SL must be below the combined premium.';
  if (!(tg > comb)) return 'The target must be above the combined premium.';
  return null;
}

export interface JodiView {
  status: string; combined: number; sl: number; target: number;
  ce_held: number; pe_held: number; ce_buy: number | null; pe_buy: number | null; ce_sold: number | null; pe_sold: number | null;
}

/** The combined value now: money from a leg already sold + the live price of each leg still held. */
export function combinedValue(r: JodiView, ltpCe: number, ltpPe: number): number {
  return (r.ce_held ? ltpCe : Number(r.ce_sold) || 0) + (r.pe_held ? ltpPe : Number(r.pe_sold) || 0);
}

export type JodiAction = 'ENTER' | 'EXPIRE' | 'EXIT_TARGET' | 'EXIT_SL' | 'EXIT_TIME' | 'CUT_CE' | 'CUT_PE' | null;

/** What a Jodi should do at these prices and this minute of the day (IST). Target before
 *  SL before the clock before the half-price cut; null when there is nothing to do. */
export function decide(r: JodiView, ltpCe: number, ltpPe: number, minuteOfDay: number): JodiAction {
  const late = minuteOfDay >= JODI_EXIT_MIN;
  if (r.status === 'PENDING') {
    if (late) return 'EXPIRE';
    if (minuteOfDay < JODI_OPEN_MIN) return null;
    if (!(ltpCe > 0) || !(ltpPe > 0)) return null;                    // both prices, or it is not judged
    return ltpCe + ltpPe <= r.combined ? 'ENTER' : null;
  }
  if (r.status !== 'ACTIVE') return null;
  const needCe = !!r.ce_held, needPe = !!r.pe_held;
  if (!needCe && !needPe) return null;
  if ((needCe && !(ltpCe > 0)) || (needPe && !(ltpPe > 0))) return late ? 'EXIT_TIME' : null;
  const v = combinedValue(r, ltpCe, ltpPe);
  if (v >= r.target) return 'EXIT_TARGET';
  if (v <= r.sl) return 'EXIT_SL';
  if (late) return 'EXIT_TIME';
  if (needCe && needPe) {
    if (Number(r.ce_buy) > 0 && ltpCe < JODI_CUT * Number(r.ce_buy)) return 'CUT_CE';
    if (Number(r.pe_buy) > 0 && ltpPe < JODI_CUT * Number(r.pe_buy)) return 'CUT_PE';
  }
  return null;
}

/** Rupees made or lost so far: realised on what is sold, at the live price on what is held. */
export function jodiPnl(r: JodiView & { qty: number }, ltpCe: number, ltpPe: number): number | null {
  if (!(Number(r.ce_buy) > 0) || !(Number(r.pe_buy) > 0)) return null;
  return +((combinedValue(r, ltpCe, ltpPe) - Number(r.ce_buy) - Number(r.pe_buy)) * Number(r.qty)).toFixed(2);
}

// ───────────────────────── the engine ─────────────────────────

export interface JodiDeps {
  db: any;
  getKiteClient: () => any;
  /** One market buy through the app's own order route (no journal flag, so the Trade Guard is not asked). */
  placeBuy: (o: { tradingsymbol: string; exchange: string; quantity: number; product: string }) => Promise<{ ok: boolean; orderId?: string; error?: string }>;
  /** The app's own exit: sells the whole open position in this contract and follows the order until it is filled. */
  exitPosition: (tradingsymbol: string, reason: string) => Promise<{ ok: boolean; orderId?: string; error?: string; alreadyClosed?: boolean }>;
  notify: (text: string) => Promise<any> | any;
  /** The last price the live feed gave for a contract, and when. */
  liveTick: (token: number) => { ltp: number; at: number } | null;
  /** Called when the set of contracts that need live prices has changed. */
  resubscribe: () => void;
  journalOpen?: (o: { tradingsymbol: string; exchange: string; qty: number; product: string; entryPrice: number; practice: boolean }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

let D: JodiDeps | null = null;
const now = () => (D?.now ? D.now() : Date.now());
const sleep = (ms: number) => (D?.sleep ? D.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));
const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMinute = (ms: number) => { const x = new Date(ms + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const istWeekday = (ms: number) => new Date(ms + IST_MS).getUTCDay();
const r2 = (n: number) => Math.round(n * 100) / 100;
const PRODUCT = 'NRML';
const busy = new Set<string>();
const retryAfter = new Map<string, number>();

const get = (id: string): any => D!.db.prepare('SELECT * FROM jodi_trades WHERE id = ?').get(id);
const liveRows = (): any[] => { try { return D!.db.prepare(`SELECT * FROM jodi_trades WHERE status IN ('PENDING','ACTIVE')`).all() as any[]; } catch (e) { return []; } };
const set = (id: string, cols: Record<string, any>) => {
  const k = Object.keys(cols);
  D!.db.prepare(`UPDATE jodi_trades SET ${k.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...k.map((c) => cols[c]), now(), id);
};
/** The one-shot claim: only the caller whose UPDATE changes the row may go on. */
const claim = (id: string, from: string, to: string): boolean => {
  try { return D!.db.prepare('UPDATE jodi_trades SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, now(), id, from).changes === 1; } catch (e) { return false; }
};
const say = (text: string) => { try { Promise.resolve(D!.notify(text)).catch(() => {}); } catch (e) {} };
const name = (sym: string) => { const p = parseOption(sym); return p ? `${p.root} ${p.strike} ${p.type}` : sym; };

/** Is this contract a leg of a Jodi that is waiting or running? The chart's automatic
 *  SL / TP and the Structure SL are kept off such a contract. */
export function jodiManages(tradingsymbol: string): boolean {
  if (!D) return false;
  try {
    return !!D.db.prepare(`SELECT 1 FROM jodi_trades WHERE status IN ('PENDING','ENTERING','ACTIVE','EXITING') AND practice = 0 AND (ce_symbol = ? OR pe_symbol = ?)`)
      .get(String(tradingsymbol), String(tradingsymbol));
  } catch (e) { return false; }
}

/** Contracts that must be on the live feed for a Jodi to be judged. */
export function jodiTokens(): number[] {
  if (!D) return [];
  try {
    const out = new Set<number>();
    for (const r of D.db.prepare(`SELECT ce_token, pe_token FROM jodi_trades WHERE status IN ('PENDING','ENTERING','ACTIVE','EXITING')`).all() as any[]) {
      if (Number(r.ce_token) > 0) out.add(Number(r.ce_token));
      if (Number(r.pe_token) > 0) out.add(Number(r.pe_token));
    }
    return [...out];
  } catch (e) { return []; }
}

/** What the Trade Guard leaves out for a day: the orders a Jodi placed, and its contracts' P&L. */
export function jodiExempt(day: string): { orderIds: Set<string>; symbols: Set<string> } {
  const orderIds = new Set<string>(), symbols = new Set<string>();
  if (!D) return { orderIds, symbols };
  try {
    for (const r of D.db.prepare('SELECT * FROM jodi_trades WHERE trade_date = ? AND practice = 0').all(day) as any[]) {
      for (const k of ['ce_order', 'pe_order']) if (r[k]) orderIds.add(String(r[k]));
      if (r.entered_at) { symbols.add(String(r.ce_symbol)); symbols.add(String(r.pe_symbol)); }
    }
  } catch (e) {}
  return { orderIds, symbols };
}

// ── prices ──
const lastRead = new Map<number, { ltp: number; at: number }>();
let readingUntil = 0;
/** Both legs' prices: from the live feed when it is fresh, else read from the broker (at most every 3 s). */
async function prices(r: any): Promise<{ ce: number; pe: number }> {
  const t = now();
  const fresh = (tok: number) => {
    const a = D!.liveTick(tok), b = lastRead.get(tok);
    const best = a && b ? (a.at >= b.at ? a : b) : (a || b || null);
    return best && t - best.at < 6000 && best.ltp > 0 ? best.ltp : 0;
  };
  let ce = fresh(Number(r.ce_token)), pe = fresh(Number(r.pe_token));
  if ((!ce || !pe) && t >= readingUntil) {
    readingUntil = t + 3000;
    try {
      const kc = D!.getKiteClient();
      if (kc && kc.access_token) {
        const kC = `${r.ce_exchange}:${r.ce_symbol}`, kP = `${r.pe_exchange}:${r.pe_symbol}`;
        const q = await kc.getLTP([kC, kP]);
        const c = Number(q?.[kC]?.last_price), p = Number(q?.[kP]?.last_price);
        if (c > 0) { lastRead.set(Number(r.ce_token), { ltp: c, at: now() }); ce = ce || c; }
        if (p > 0) { lastRead.set(Number(r.pe_token), { ltp: p, at: now() }); pe = pe || p; }
      }
    } catch (e) { /* the next look tries again */ }
  }
  return { ce, pe };
}

// ── buying both ──
const WAITING = new Set(['OPEN', 'OPEN PENDING', 'MODIFY PENDING', 'MODIFIED', 'TRIGGER PENDING', 'PUT ORDER REQ RECEIVED', 'VALIDATION PENDING', 'MODIFY VALIDATION PENDING', 'UPDATE']);
const tick05 = (p: number) => Math.max(0.05, parseFloat((Math.round(p / 0.05) * 0.05).toFixed(2)));

/** Follows a buy until the broker says it is filled. It is re-priced a little through the
 *  market while it waits (never more than 3%), and taken off if it still has not filled:
 *  a Jodi is entered now, at about these prices, or not at all. */
async function followBuy(kc: any, orderId: string, full: string): Promise<{ filled: boolean; avg?: number; error?: string }> {
  for (let look = 1; look <= 8; look++) {
    await sleep(600);
    let st: any = null;
    try { const h = await kc.getOrderHistory(orderId); st = h && h.length ? h[h.length - 1] : null; } catch (e) { continue; }
    const status = String(st?.status || '').toUpperCase();
    if (status === 'COMPLETE') return { filled: true, avg: Number(st.average_price) || undefined };
    if (status === 'REJECTED' || status === 'CANCELLED') return { filled: false, error: `order ${status.toLowerCase()}${st?.status_message ? `: ${st.status_message}` : ''}` };
    if (look === 8 || !WAITING.has(status)) continue;
    try {
      const q = await kc.getLTP([full]); const last = Number(q?.[full]?.last_price);
      const price = tick05(last * (1 + Math.min(0.005 + 0.005 * look, 0.03)));
      if (last > 0 && price > (Number(st?.price) || 0)) await kc.modifyOrder('regular', orderId, { price, order_type: 'LIMIT', quantity: Number(st?.quantity), validity: 'DAY' });
    } catch (e) { /* it stays where it is; the next look reads it again */ }
  }
  // Still not filled: take it off, and believe only what the broker then says.
  try { await kc.cancelOrder('regular', orderId); } catch (e) { /* it may have just filled */ }
  await sleep(400);
  try {
    const h = await kc.getOrderHistory(orderId); const st = h && h.length ? h[h.length - 1] : null;
    const status = String(st?.status || '').toUpperCase();
    if (status === 'COMPLETE') return { filled: true, avg: Number(st.average_price) || undefined };
    if (status === 'CANCELLED' && !(Number(st?.filled_quantity) > 0)) return { filled: false, error: 'did not fill in 5 seconds and was cancelled' };
    return { filled: false, error: `order is ${status || 'in an unknown state'} at the broker — CHECK IT IN KITE` };
  } catch (e: any) { return { filled: false, error: `could not read the order after cancelling — CHECK IT IN KITE (${e?.message || e})` }; }
}

async function enter(id: string, ce: number, pe: number): Promise<void> {
  if (!claim(id, 'PENDING', 'ENTERING')) return;
  const r = get(id);
  const fail = (why: string, tell = true) => {
    set(id, { status: 'FAILED', detail: why.slice(0, 400), closed_at: now() });
    console.error(`[jodi] ${id} NOT ENTERED: ${why}`);
    if (tell) say(`❗ Jodi not entered — ${why}`);
    D!.resubscribe();
  };
  console.log(`[jodi] ${id} combined ${r2(ce + pe)} at or below ${r.combined} (CE ${ce}, PE ${pe}) — buying both`);
  if (r.practice) {
    set(id, { status: 'ACTIVE', ce_buy: ce, pe_buy: pe, ce_held: 1, pe_held: 1, entered_at: now(), detail: `Practice: "bought" at ${ce} + ${pe} = ${r2(ce + pe)}` });
    say(`🧪 Jodi (practice) entered: ${name(r.ce_symbol)} ${ce} + ${name(r.pe_symbol)} ${pe} = ${r2(ce + pe)}. SL ${r.sl}, target ${r.target}. No real order.`);
    return;
  }
  const kc = D!.getKiteClient();
  if (!kc || !kc.access_token) return fail('Zerodha is not logged in. No order sent.');
  // Not in a contract he already holds: the exit would sell that too.
  try {
    const net: any[] = ((await kc.getPositions())?.net) || [];
    const held = net.find((p) => (p.tradingsymbol === r.ce_symbol || p.tradingsymbol === r.pe_symbol) && Number(p.quantity) !== 0);
    if (held) return fail(`you already hold ${name(held.tradingsymbol)}. No order sent.`);
  } catch (e) { /* positions unreadable: the orders below are still only what he asked for */ }
  // Funds for BOTH, before either is sent.
  try {
    const leg = (sym: string, ex: string, px: number) => ({ exchange: ex, tradingsymbol: sym, transaction_type: 'BUY', variety: 'regular', product: PRODUCT, order_type: 'LIMIT', quantity: Number(r.qty), price: tick05(px * 1.005), trigger_price: 0 });
    const [mg, funds] = await Promise.all([kc.orderMargins([leg(r.ce_symbol, r.ce_exchange, ce), leg(r.pe_symbol, r.pe_exchange, pe)]), kc.getMargins()]);
    const need = (mg || []).reduce((s: number, m: any) => s + (Number(m?.total) || 0) + (Number(m?.charges?.total) || 0), 0);
    const have = Number(funds?.equity?.available?.live_balance ?? funds?.equity?.net);
    if (need > 0 && isFinite(have) && need > have) return fail(`not enough funds for both options: needs ₹${Math.round(need).toLocaleString('en-IN')}, available ₹${Math.round(have).toLocaleString('en-IN')}. No order sent.`);
  } catch (e) { /* a check that cannot be made must not block the trade */ }

  const [a, b] = await Promise.all([
    D!.placeBuy({ tradingsymbol: r.ce_symbol, exchange: r.ce_exchange, quantity: Number(r.qty), product: PRODUCT }).catch((e: any) => ({ ok: false, error: e?.message || String(e) } as any)),
    D!.placeBuy({ tradingsymbol: r.pe_symbol, exchange: r.pe_exchange, quantity: Number(r.qty), product: PRODUCT }).catch((e: any) => ({ ok: false, error: e?.message || String(e) } as any)),
  ]);
  set(id, { ce_order: a.ok ? String(a.orderId || '') : null, pe_order: b.ok ? String(b.orderId || '') : null });
  if (!a.ok && !b.ok) return fail(`both buys were refused (${a.error || 'rejected'}). Nothing was bought.`);
  const [fa, fb] = await Promise.all([
    a.ok && a.orderId ? followBuy(kc, String(a.orderId), `${r.ce_exchange}:${r.ce_symbol}`) : Promise.resolve({ filled: false, error: a.error || 'refused' } as { filled: boolean; avg?: number; error?: string }),
    b.ok && b.orderId ? followBuy(kc, String(b.orderId), `${r.pe_exchange}:${r.pe_symbol}`) : Promise.resolve({ filled: false, error: b.error || 'refused' } as { filled: boolean; avg?: number; error?: string }),
  ]);
  if (fa.filled && fb.filled) {
    const cb = Number(fa.avg) > 0 ? Number(fa.avg) : ce, pb = Number(fb.avg) > 0 ? Number(fb.avg) : pe;
    set(id, { status: 'ACTIVE', ce_buy: cb, pe_buy: pb, ce_held: 1, pe_held: 1, entered_at: now(), detail: `Bought at ${cb} + ${pb} = ${r2(cb + pb)}` });
    try { D!.journalOpen?.({ tradingsymbol: r.ce_symbol, exchange: r.ce_exchange, qty: Number(r.qty), product: PRODUCT, entryPrice: cb, practice: false }); } catch (e) {}
    try { D!.journalOpen?.({ tradingsymbol: r.pe_symbol, exchange: r.pe_exchange, qty: Number(r.qty), product: PRODUCT, entryPrice: pb, practice: false }); } catch (e) {}
    say(`🤝 Jodi entered (${r.lots} lot${r.lots > 1 ? 's' : ''}): ${name(r.ce_symbol)} ${cb} + ${name(r.pe_symbol)} ${pb} = ${r2(cb + pb)}. SL ${r.sl}, target ${r.target}. A leg under half its price is sold; everything is sold at 3:20 PM.`);
    return;
  }
  // One side only. Sell it again: a Jodi is two legs or nothing.
  const got: Leg | null = fa.filled ? 'ce' : fb.filled ? 'pe' : null;
  const missErr = !fa.filled ? `the Call ${fa.error}` : `the Put ${fb.error}`;
  if (!got) return fail(`neither buy filled (Call: ${fa.error}; Put: ${fb.error}). Check your orders in Kite.`);
  const sym = got === 'ce' ? r.ce_symbol : r.pe_symbol;
  const ex = await D!.exitPosition(sym, 'JODI_ONE_SIDE').catch((e: any) => ({ ok: false, error: e?.message || String(e) } as any));
  if (ex.ok || ex.alreadyClosed) return fail(`${missErr}, so ${name(sym)}, which did fill, was sold again. You hold nothing from this Jodi.`);
  fail(`${missErr}, and selling ${name(sym)} again FAILED (${ex.error}). YOU ARE HOLDING ${name(sym)} — exit it yourself now.`);
}

// ── selling ──
/** What a leg just sold fetched per unit: the exit order's own average, else Zerodha's fills, else the last price. */
async function soldPrice(r: any, leg: Leg, orderId: string | undefined, fallback: number): Promise<number> {
  const kc = D!.getKiteClient();
  const sym = leg === 'ce' ? r.ce_symbol : r.pe_symbol;
  try { if (orderId && kc) { const h = await kc.getOrderHistory(orderId); const st = h && h.length ? h[h.length - 1] : null; if (Number(st?.average_price) > 0 && String(st?.status).toUpperCase() === 'COMPLETE') return Number(st.average_price); } } catch (e) {}
  try { if (kc) { const legs = closedLegs((await kc.getTrades()) || [], sym); const last = legs[legs.length - 1]; if (last && last.exit > 0) return last.exit; } } catch (e) {}
  return fallback;
}

async function sellLeg(r: any, leg: Leg, reason: string, ltp: number): Promise<{ ok: boolean; price?: number; error?: string }> {
  const sym = leg === 'ce' ? r.ce_symbol : r.pe_symbol;
  if (r.practice) return { ok: true, price: ltp };
  const ex = await D!.exitPosition(sym, `JODI_${reason}`).catch((e: any) => ({ ok: false, error: e?.message || String(e) } as any));
  if (!ex.ok && !ex.alreadyClosed) return { ok: false, error: ex.error || 'exit failed' };
  return { ok: true, price: await soldPrice(r, leg, ex.orderId, ltp) };
}

const WORDS: Record<string, string> = { TARGET: 'target reached', SL: 'SL hit', TIME: '3:20 PM', MANUAL: 'you exited', CLOSED_BY_YOU: 'closed outside the Jodi' };

async function exitAll(id: string, reason: string, ce: number, pe: number): Promise<{ ok: boolean; error?: string }> {
  if (!claim(id, 'ACTIVE', 'EXITING')) return { ok: false, error: 'not active' };
  const r = get(id);
  console.log(`[jodi] ${id} ${reason} — selling ${[r.ce_held && 'CE', r.pe_held && 'PE'].filter(Boolean).join(' + ')}`);
  const todo: Leg[] = (['ce', 'pe'] as Leg[]).filter((k) => r[`${k}_held`]);
  const res = await Promise.all(todo.map((k) => sellLeg(r, k, reason, k === 'ce' ? ce : pe)));
  const cols: Record<string, any> = {};
  const errors: string[] = [];
  todo.forEach((k, i) => { if (res[i].ok) { cols[`${k}_held`] = 0; cols[`${k}_sold`] = r2(res[i].price || 0); } else errors.push(`${k.toUpperCase()}: ${res[i].error}`); });
  if (errors.length) {
    const attempts = (Number(r.attempts) || 0) + 1;
    const stop = attempts >= 3;
    set(id, { ...cols, status: stop ? 'ERROR' : 'ACTIVE', attempts, exit_reason: reason, detail: `${WORDS[reason] || reason}, but selling FAILED (${errors.join('; ')})`.slice(0, 400) });
    retryAfter.set(id, now() + 3000);
    console.error(`[jodi] ${id} exit failed (attempt ${attempts}): ${errors.join('; ')}`);
    if (stop) { say(`❗ Jodi: ${WORDS[reason] || reason}, but the exit FAILED three times (${errors.join('; ')}). Exit it yourself now.`); D!.resubscribe(); }
    return { ok: false, error: errors.join('; ') };
  }
  const after = { ...r, ...cols };
  const out = (Number(after.ce_sold) || 0) + (Number(after.pe_sold) || 0), pnl = r2((out - Number(r.ce_buy) - Number(r.pe_buy)) * Number(r.qty));
  set(id, { ...cols, status: 'DONE', exit_reason: reason, pnl, closed_at: now(), detail: `${WORDS[reason] || reason}: out at ${r2(out)} against ${r2(Number(r.ce_buy) + Number(r.pe_buy))} in` });
  say(`${r.practice ? '🧪 Jodi (practice)' : pnl >= 0 ? '✅ Jodi' : '🛑 Jodi'} closed — ${WORDS[reason] || reason}. In at ${r2(Number(r.ce_buy) + Number(r.pe_buy))}, out at ${r2(out)}: ${pnl >= 0 ? '+' : '−'}₹${Math.abs(pnl).toLocaleString('en-IN')} before charges.`);
  D!.resubscribe();
  return { ok: true };
}

async function cutLeg(id: string, leg: Leg, ltp: number): Promise<void> {
  const r = get(id);
  if (!r || r.status !== 'ACTIVE' || !r[`${leg}_held`]) return;
  const sym = leg === 'ce' ? r.ce_symbol : r.pe_symbol, buy = Number(r[`${leg}_buy`]);
  console.log(`[jodi] ${id} ${name(sym)} at ${ltp} is under half of ${buy} — selling it`);
  const s = await sellLeg(r, leg, 'HALF', ltp);
  if (!s.ok) {
    const attempts = (Number(r.attempts) || 0) + 1;
    set(id, { attempts, detail: `${name(sym)} fell under half its price but selling it FAILED (${s.error})`.slice(0, 400), ...(attempts >= 3 ? { status: 'ERROR' } : {}) });
    retryAfter.set(id, now() + 3000);
    if (attempts >= 3) { say(`❗ Jodi: ${name(sym)} fell under half its price but selling it FAILED three times (${s.error}). The Jodi is no longer managed — exit it yourself.`); D!.resubscribe(); }
    return;
  }
  // Only while still ACTIVE: an Exit that came in while this sale was at the broker has the row.
  D!.db.prepare(`UPDATE jodi_trades SET ${leg}_held = 0, ${leg}_sold = ?, attempts = 0, detail = ?, updated_at = ? WHERE id = ? AND status IN ('ACTIVE','EXITING')`)
    .run(r2(s.price || 0), `${name(sym)} sold at ${r2(s.price || 0)} (under half of ${buy}); the other leg runs on`, now(), id);
  say(`✂️ Jodi${r.practice ? ' (practice)' : ''}: ${name(sym)} fell under half its price (${buy} → ${ltp}) and was sold at ${r2(s.price || 0)}. The other leg runs to the target ${r.target} or SL ${r.sl}.`);
}

/** One look at one Jodi: read the prices, decide, act. One thing at a time per Jodi. */
async function look(id: string): Promise<void> {
  if (busy.has(id)) return;
  if ((retryAfter.get(id) || 0) > now()) return;
  busy.add(id);
  try {
    const r = get(id);
    if (!r || (r.status !== 'PENDING' && r.status !== 'ACTIVE')) return;
    const t = now();
    if (istDate(t) !== r.trade_date) return;                       // boot cleanup deals with another day's rows
    const wd = istWeekday(t);
    if (wd === 0 || wd === 6 || isNseHoliday(istDate(t))) return;
    const { ce, pe } = await prices(r);
    const act = decide(r, ce, pe, istMinute(t));
    if (!act) return;
    if (act === 'EXPIRE') {
      if (claim(id, 'PENDING', 'CANCELLED')) { set(id, { detail: 'Not entered by 3:20 PM', closed_at: now() }); say('Jodi cancelled: the combined premium was not reached by 3:20 PM. Nothing was bought.'); D!.resubscribe(); }
    } else if (act === 'ENTER') await enter(id, ce, pe);
    else if (act === 'CUT_CE') await cutLeg(id, 'ce', ce);
    else if (act === 'CUT_PE') await cutLeg(id, 'pe', pe);
    else await exitAll(id, act.replace('EXIT_', ''), ce, pe);
  } catch (e: any) { console.error('[jodi] look failed', id, e?.message || e); }
  finally { busy.delete(id); }
}

/** A leg he sold himself (position card, Kite) is seen here and counted as sold. */
async function reconcile(): Promise<void> {
  const rows = liveRows().filter((r) => r.status === 'ACTIVE' && !r.practice && now() - Number(r.entered_at) > 15000);
  if (!rows.length) return;
  const kc = D!.getKiteClient();
  if (!kc || !kc.access_token) return;
  let net: any[];
  try { net = ((await kc.getPositions())?.net) || []; } catch (e) { return; }
  for (const r of rows) {
    if (busy.has(r.id)) continue;
    busy.add(r.id);
    try {
      const fresh = get(r.id);
      if (!fresh || fresh.status !== 'ACTIVE') continue;
      const cols: Record<string, any> = {};
      for (const k of ['ce', 'pe'] as Leg[]) {
        if (!fresh[`${k}_held`]) continue;
        const sym = fresh[`${k}_symbol`];
        const q = net.filter((p) => p.tradingsymbol === sym).reduce((s, p) => s + (Number(p.quantity) || 0), 0);
        if (q !== 0) continue;
        const px = await soldPrice(fresh, k, undefined, Number(D!.liveTick(Number(fresh[`${k}_token`]))?.ltp) || 0);
        cols[`${k}_held`] = 0; cols[`${k}_sold`] = r2(px);
        console.log(`[jodi] ${r.id} ${name(sym)} is no longer held (sold outside the Jodi) — counted as sold at ${r2(px)}`);
      }
      if (!Object.keys(cols).length) continue;
      const after = { ...fresh, ...cols };
      if (!after.ce_held && !after.pe_held) {
        const out = (Number(after.ce_sold) || 0) + (Number(after.pe_sold) || 0), pnl = r2((out - Number(fresh.ce_buy) - Number(fresh.pe_buy)) * Number(fresh.qty));
        set(r.id, { ...cols, status: 'DONE', exit_reason: 'CLOSED_BY_YOU', pnl, closed_at: now(), detail: `Both legs were closed outside the Jodi: out at ${r2(out)}` });
        say(`Jodi closed — both legs were sold outside the Jodi. In at ${r2(Number(fresh.ce_buy) + Number(fresh.pe_buy))}, out at ${r2(out)}: ${pnl >= 0 ? '+' : '−'}₹${Math.abs(pnl).toLocaleString('en-IN')} before charges.`);
        D!.resubscribe();
      } else set(r.id, { ...cols, detail: 'One leg was sold outside the Jodi; the other runs on' });
    } catch (e: any) { console.error('[jodi] reconcile failed', r.id, e?.message || e); }
    finally { busy.delete(r.id); }
  }
}

/** A price for one of a Jodi's contracts has just arrived on the live feed. */
export function jodiOnTick(token: number, _ltp: number): void {
  if (!D || !watched.has(Number(token))) return;
  for (const r of liveRows()) if (Number(r.ce_token) === Number(token) || Number(r.pe_token) === Number(token)) void look(r.id);
}
let watched = new Set<number>();
const rewatch = () => { watched = new Set(jodiTokens()); };

/** Exported for the tests: one pass of the timer. */
export async function jodiSweep(): Promise<void> { rewatch(); await Promise.all(liveRows().map((r) => look(r.id))); }
export async function jodiReconcile(): Promise<void> { await reconcile(); }

function view(r: any) {
  const a = D!.liveTick(Number(r.ce_token)), b = D!.liveTick(Number(r.pe_token));
  const ce = Number(a?.ltp) || Number(lastRead.get(Number(r.ce_token))?.ltp) || 0, pe = Number(b?.ltp) || Number(lastRead.get(Number(r.pe_token))?.ltp) || 0;
  const live = LIVE.includes(r.status);
  const held = r.status === 'ACTIVE' || r.status === 'EXITING' || r.status === 'ERROR';
  return {
    ...r, ce_name: name(r.ce_symbol), pe_name: name(r.pe_symbol),
    ce_ltp: ce || null, pe_ltp: pe || null,
    value: held && (!r.ce_held || ce > 0) && (!r.pe_held || pe > 0) ? r2(combinedValue(r, ce, pe)) : live && ce > 0 && pe > 0 ? r2(ce + pe) : null,
    live_pnl: held && (!r.ce_held || ce > 0) && (!r.pe_held || pe > 0) ? jodiPnl(r, ce, pe) : null,
  };
}

export function registerJodi(app: any, express: any, deps: JodiDeps) {
  D = deps;
  const db = deps.db;
  db.exec(`CREATE TABLE IF NOT EXISTS jodi_trades (
    id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, trade_date TEXT, status TEXT, practice INTEGER DEFAULT 0,
    ce_symbol TEXT, ce_token INTEGER, ce_exchange TEXT, pe_symbol TEXT, pe_token INTEGER, pe_exchange TEXT,
    lot_size INTEGER, lots INTEGER, qty INTEGER,
    ce_entry REAL, pe_entry REAL, combined REAL, sl REAL, target REAL,
    ce_order TEXT, pe_order TEXT, ce_buy REAL, pe_buy REAL, ce_held INTEGER DEFAULT 0, pe_held INTEGER DEFAULT 0, ce_sold REAL, pe_sold REAL,
    entered_at INTEGER, closed_at INTEGER, exit_reason TEXT, pnl REAL, attempts INTEGER DEFAULT 0, detail TEXT
  )`);
  // Boot. A Jodi from another day cannot be honoured today. One caught in the
  // middle of buying is flagged, never retried: the orders may or may not have
  // reached the broker. One caught in the middle of selling is simply looked at
  // again — the exit reads the real position, so it cannot sell twice.
  try {
    const today = istDate(now());
    db.prepare(`UPDATE jodi_trades SET status='CANCELLED', detail='Not carried past its trading day', closed_at=? WHERE status='PENDING' AND trade_date <> ?`).run(now(), today);
    db.prepare(`UPDATE jodi_trades SET status='ERROR', detail='Still open when its trading day ended — CHECK YOUR POSITIONS IN KITE', closed_at=? WHERE status IN ('ACTIVE','EXITING') AND trade_date <> ?`).run(now(), today);
    const f = db.prepare(`UPDATE jodi_trades SET status='FAILED', detail='The server restarted while the two buys were being placed — CHECK YOUR ORDERS AND POSITIONS IN KITE', closed_at=? WHERE status='ENTERING'`).run(now());
    if (f?.changes) { console.warn(`[jodi] ${f.changes} Jodi(s) were mid-entry at restart — flagged, not retried`); say('❗ Jodi: the server restarted while the two buys were being placed. Check your orders and positions in Kite — the Jodi is NOT being managed.'); }
    db.prepare(`UPDATE jodi_trades SET status='ACTIVE' WHERE status='EXITING'`).run();
  } catch (e) { console.error('[jodi] boot cleanup failed', e); }
  rewatch();

  app.get('/api/jodi', (_req: any, res: any) => {
    try {
      const today = istDate(now());
      const live = db.prepare(`SELECT * FROM jodi_trades WHERE status IN ('PENDING','ENTERING','ACTIVE','EXITING') ORDER BY created_at DESC LIMIT 1`).get()
        || db.prepare(`SELECT * FROM jodi_trades WHERE status = 'ERROR' AND trade_date = ? AND (ce_held = 1 OR pe_held = 1) ORDER BY created_at DESC LIMIT 1`).get(today);
      const done = db.prepare(`SELECT * FROM jodi_trades WHERE trade_date = ? AND status IN ('DONE','CANCELLED','FAILED','ERROR') ORDER BY created_at DESC LIMIT 10`).all(today) as any[];
      res.json({ ok: true, live: live ? view(live) : null, today: done.filter((d) => !live || d.id !== (live as any).id).map(view), exitAt: '3:20 PM' });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.post('/api/jodi', express.json(), async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const bad = validateJodi(b);
      if (bad) return res.status(400).json({ ok: false, error: bad });
      const t = now(), wd = istWeekday(t);
      if (wd === 0 || wd === 6 || isNseHoliday(istDate(t)) || istMinute(t) >= JODI_EXIT_MIN) return res.status(400).json({ ok: false, error: 'Market closed: a Jodi can be saved until 3:20 PM on a trading day.' });
      if (db.prepare(`SELECT 1 FROM jodi_trades WHERE status IN ('PENDING','ENTERING','ACTIVE','EXITING')`).get()) return res.status(409).json({ ok: false, error: 'A Jodi is already waiting or running. Exit or cancel it first.' });
      const practice = b.practice === true;
      if (!practice) {
        const kc = deps.getKiteClient();
        if (!kc || !kc.access_token) return res.status(400).json({ ok: false, error: 'Zerodha is not logged in.' });
        try {
          const net: any[] = ((await kc.getPositions())?.net) || [];
          const held = net.find((p) => (p.tradingsymbol === String(b.ce.tradingsymbol).toUpperCase() || p.tradingsymbol === String(b.pe.tradingsymbol).toUpperCase()) && Number(p.quantity) !== 0);
          if (held) return res.status(409).json({ ok: false, error: `You already hold ${name(held.tradingsymbol)}. A Jodi cannot use a contract you are already in: its exit sells the whole position.` });
        } catch (e) { /* checked again at the moment of entry */ }
      }
      const lot = Number(b.ce.lot_size) || Number(b.pe.lot_size), lots = Number(b.lots);
      const exOf = (o: any) => String(o.exchange || (/^SENSEX|^BANKEX/.test(String(o.tradingsymbol).toUpperCase()) ? 'BFO' : 'NFO'));
      const id = `jodi_${t}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`INSERT INTO jodi_trades (id, created_at, updated_at, trade_date, status, practice, ce_symbol, ce_token, ce_exchange, pe_symbol, pe_token, pe_exchange,
        lot_size, lots, qty, ce_entry, pe_entry, combined, sl, target, detail) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, t, t, istDate(t), practice ? 1 : 0, String(b.ce.tradingsymbol).toUpperCase(), Number(b.ce.instrument_token), exOf(b.ce),
          String(b.pe.tradingsymbol).toUpperCase(), Number(b.pe.instrument_token), exOf(b.pe), lot, lots, lot * lots,
          r2(Number(b.ceEntry)), r2(Number(b.peEntry)), r2(Number(b.combined)), r2(Number(b.sl)), r2(Number(b.target)),
          `Waiting for the two prices together to be at or below ${r2(Number(b.combined))}`);
      rewatch(); deps.resubscribe();
      console.log(`[jodi] ${id} saved${practice ? ' (practice)' : ''}: ${b.ce.tradingsymbol} + ${b.pe.tradingsymbol} x${lots} lot, combined ${b.combined}, SL ${b.sl}, target ${b.target}`);
      void look(id);
      res.json({ ok: true, id, jodi: view(get(id)) });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // HIS EXIT BUTTON. Waiting: it is cancelled, nothing was bought. Running:
  // everything still held is sold now. Stopped after failed exits (ERROR): the
  // sale is tried once more.
  app.post('/api/jodi/:id/exit', express.json(), async (req: any, res: any) => {
    try {
      const id = String(req.params.id);
      const r = get(id);
      if (!r) return res.status(404).json({ ok: false, error: 'No such Jodi.' });
      if (r.status === 'PENDING') {
        if (!claim(id, 'PENDING', 'CANCELLED')) return res.json({ ok: false, error: 'It is being entered right now — tap Exit again in a few seconds.' });
        set(id, { detail: 'Cancelled by you before it was entered', closed_at: now() });
        rewatch(); deps.resubscribe();
        return res.json({ ok: true, cancelled: true });
      }
      if (r.status === 'ENTERING') return res.json({ ok: false, error: 'The two buys are being placed right now — tap Exit again in a few seconds.' });
      if (r.status === 'ERROR' && (r.ce_held || r.pe_held)) { db.prepare(`UPDATE jodi_trades SET status='ACTIVE', attempts=0 WHERE id=? AND status='ERROR'`).run(id); rewatch(); }
      else if (r.status !== 'ACTIVE') return res.json({ ok: false, error: r.status === 'EXITING' ? 'It is already being exited.' : 'This Jodi is not running.' });
      // Wait out anything this Jodi is in the middle of (a leg being cut), then sell.
      for (let i = 0; i < 40 && busy.has(id); i++) await sleep(250);
      busy.add(id);
      try {
        const cur = get(id);
        const { ce, pe } = await prices(cur);
        const out = await exitAll(id, 'MANUAL', ce, pe);
        const after = get(id);
        return res.json({ ok: out.ok, error: out.ok ? undefined : `The exit FAILED: ${out.error}. Exit the two options yourself from their position cards.`, jodi: view(after) });
      } finally { busy.delete(id); rewatch(); }
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // A look every second whether or not a tick came (a quiet option, a stalled
  // feed, the 3:20 PM clock), and the positions read every ten for what he may
  // have closed himself. Neither asks the broker anything while no Jodi is live.
  setInterval(() => { try { rewatch(); for (const r of liveRows()) void look(r.id); } catch (e) {} }, 1000);
  setInterval(() => { reconcile().catch(() => {}); }, 10000);
  console.log('[jodi] registered');
}

export const __test = { reset() { busy.clear(); retryAfter.clear(); lastRead.clear(); readingUntil = 0; } };
