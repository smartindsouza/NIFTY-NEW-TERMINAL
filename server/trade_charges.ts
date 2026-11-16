// TRADE CHARGES AND CAPITAL (16 Nov 2026) — what each trade cost, and what the
// account stood at before and after it. Read by the Trade Journal.
//
// WHY: the journal showed gross P&L only ("P&L is gross of brokerage, STT and
// other charges" was a line in its own Excel export). Martin trades one lot, so a
// round trip costs about ₹60–90 against an average trade of a few hundred rupees:
// the gross figure flatters every day. He asked for the charges on each trade,
// kept in step with the rates whenever they change, and for the capital he
// opened the day with and what was left after each trade.
//
// WHERE THE CHARGE FIGURES COME FROM, IN ORDER OF TRUST
//   1. 'zerodha'  Zerodha's own calculation for each executed order (Kite Connect
//                 "virtual contract note", POST /charges/orders). Nothing here
//                 knows a rate: if STT, brokerage or an exchange fee changes, the
//                 figure changes with it the same day.
//   2. 'rates'    Our formula at rates that Zerodha's calculator confirmed. Used
//                 where there is no order to ask about: trades from before this
//                 existed, a carried position's entry, a hand-corrected row, or a
//                 moment the calculator could not be reached.
//   3. 'builtin'  Our formula at the rates written in BUILTIN below — for dates
//                 no Zerodha check covers. Shown as an estimate.
//
// HOW THE RATES STAY CURRENT: once a trading day, on the first import that has
// orders, two imaginary orders (a buy and a sell of the same contract) are put
// through Zerodha's calculator and every rate is read back out of the answer. If
// they equal the card in force, the card is stamped "checked today". If any
// differ, a new card starts from today and the change is recorded in plain
// words. So the formula follows a rate change the day Zerodha does, and old
// trades keep the rates of their own day.
//
// The formula was checked against Zerodha to the paisa on 16 Nov 2026 (six
// orders through /margins/orders on the live account: values ₹6,500 to ₹1,30,000).
// One thing that only shows in such a check: Zerodha rounds stamp duty to the
// whole rupee per order (0.003% of ₹6,500 is 19.5 paise and it charges ₹0; of
// ₹19,500 is 58.5 paise and it charges ₹1). The formula does the same.
//
// CAPITAL: Zerodha reports the day's opening balance in its funds call and keeps
// it fixed all day, so it is read once the session is under way and stored per
// day. "After the trade" is that balance plus everything closed so far, after
// charges. Zerodha does not give past days' balances, so days before this was
// built have none.
//
// NOTHING HERE PLACES, CHANGES OR CANCELS AN ORDER. It reads fills, asks a
// calculator, and writes to its own three tables and two journal columns.

export type Charges = { brokerage: number; stt: number; exchange: number; sebi: number; stamp: number; gst: number; total: number };
export type ChargeSource = 'zerodha' | 'rates' | 'builtin';
export type Seg = 'NFO-OPT' | 'BFO-OPT' | 'NFO-FUT' | 'BFO-FUT';
/** Rates are fractions of traded value (0.0015 = 0.15%). brokeragePct is null where
 *  brokerage is a flat fee; where set, brokerage is the lower of the two. */
export type RateCard = {
  seg: Seg; from: string; source: 'zerodha' | 'builtin';
  brokerageFlat: number; brokeragePct: number | null;
  sttSell: number; sttBuy: number; exchange: number; sebi: number; stampBuy: number; gst: number;
  changes?: string[];
};
export type ExecOrder = { order_id: string; exchange: string; tradingsymbol: string; transaction_type: 'BUY' | 'SELL'; product: string; quantity: number; average_price: number };
export type OrderCharge = { qty: number; charges: Charges; source: ChargeSource };
export type RowDetail = { v: 1; src: ChargeSource; entry: Charges; exit: Charges | null; qty: number; orders: number };

const IST_MS = 5.5 * 3600 * 1000;
export const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMinute = (ms: number) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const fin = (x: any): x is number => typeof x === 'number' && Number.isFinite(x);

export const ZERO: Charges = { brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, total: 0 };
const KEYS = ['brokerage', 'stt', 'exchange', 'sebi', 'stamp', 'gst'] as const;
const withTotal = (c: Omit<Charges, 'total'>): Charges => ({ ...c, total: c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst });
export const addCharges = (a: Charges, b: Charges): Charges => withTotal({ brokerage: a.brokerage + b.brokerage, stt: a.stt + b.stt, exchange: a.exchange + b.exchange, sebi: a.sebi + b.sebi, stamp: a.stamp + b.stamp, gst: a.gst + b.gst });
export const scaleCharges = (c: Charges, f: number): Charges => withTotal({ brokerage: c.brokerage * f, stt: c.stt * f, exchange: c.exchange * f, sebi: c.sebi * f, stamp: c.stamp * f, gst: c.gst * f });
const tidy = (c: Charges): Charges => ({ brokerage: r4(c.brokerage), stt: r4(c.stt), exchange: r4(c.exchange), sebi: r4(c.sebi), stamp: r4(c.stamp), gst: r4(c.gst), total: r4(c.total) });
const worst = (a: ChargeSource, b: ChargeSource): ChargeSource => (a === 'builtin' || b === 'builtin' ? 'builtin' : a === 'rates' || b === 'rates' ? 'rates' : 'zerodha');

export function segOf(exchange: string | null | undefined, tradingsymbol: string): Seg {
  const sym = String(tradingsymbol || '').toUpperCase();
  const bse = String(exchange || '').toUpperCase() === 'BFO' || /^(SENSEX|BANKEX)/.test(sym);
  const opt = /(CE|PE)$/.test(sym);
  return `${bse ? 'BFO' : 'NFO'}-${opt ? 'OPT' : 'FUT'}` as Seg;
}

// THE RATES WRITTEN DOWN, newest first within each segment. Source: Zerodha's
// charges page read on 16 Nov 2026 (options: flat ₹20 an executed order; STT
// 0.15% on the sell side; NSE 0.03553% and BSE 0.0325% of premium; SEBI ₹10 a
// crore; stamp 0.003% on the buy side; GST 18% on brokerage + SEBI + exchange),
// and the Union Budget 2026-27, which raised STT from 1 April 2026 (options
// 0.10% → 0.15%, futures 0.02% → 0.05%). These are the fallback only — a card
// learned from Zerodha's calculator always wins from its own date onward.
const base = { brokerageFlat: 20, sttBuy: 0, sebi: 0.000001, gst: 0.18, source: 'builtin' as const };
export const BUILTIN: RateCard[] = [
  { ...base, seg: 'NFO-OPT', from: '2026-04-01', brokeragePct: null, sttSell: 0.0015, exchange: 0.0003553, stampBuy: 0.00003 },
  { ...base, seg: 'NFO-OPT', from: '2024-10-01', brokeragePct: null, sttSell: 0.0010, exchange: 0.0003553, stampBuy: 0.00003 },
  { ...base, seg: 'BFO-OPT', from: '2026-04-01', brokeragePct: null, sttSell: 0.0015, exchange: 0.000325, stampBuy: 0.00003 },
  { ...base, seg: 'BFO-OPT', from: '2024-10-01', brokeragePct: null, sttSell: 0.0010, exchange: 0.000325, stampBuy: 0.00003 },
  { ...base, seg: 'NFO-FUT', from: '2026-04-01', brokeragePct: 0.0003, sttSell: 0.0005, exchange: 0.0000183, stampBuy: 0.00002 },
  { ...base, seg: 'NFO-FUT', from: '2024-10-01', brokeragePct: 0.0003, sttSell: 0.0002, exchange: 0.0000183, stampBuy: 0.00002 },
  { ...base, seg: 'BFO-FUT', from: '2026-04-01', brokeragePct: 0.0003, sttSell: 0.0005, exchange: 0, stampBuy: 0.00002 },
  { ...base, seg: 'BFO-FUT', from: '2024-10-01', brokeragePct: 0.0003, sttSell: 0.0002, exchange: 0, stampBuy: 0.00002 },
];

/** One executed order's charges by the formula. `value` is quantity × average price. */
export function estimateOrder(card: RateCard, side: 'BUY' | 'SELL', value: number): Charges {
  if (!(value > 0)) return { ...ZERO };
  const brokerage = card.brokeragePct == null ? card.brokerageFlat : Math.min(card.brokerageFlat, value * card.brokeragePct);
  const exchange = value * card.exchange, sebi = value * card.sebi;
  const stt = value * (side === 'SELL' ? card.sttSell : card.sttBuy);
  // Whole rupees per order, as Zerodha does it — see the header.
  const stamp = side === 'BUY' ? Math.round(value * card.stampBuy) : 0;
  return withTotal({ brokerage, stt, exchange, sebi, stamp, gst: card.gst * (brokerage + exchange + sebi) });
}

/** Zerodha's `charges` object (contract note or order margins) in our shape; null if it is not one. */
export function fromZerodha(c: any): Charges | null {
  if (!c || typeof c !== 'object') return null;
  const out = { brokerage: Number(c.brokerage), stt: Number(c.transaction_tax), exchange: Number(c.exchange_turnover_charge), sebi: Number(c.sebi_turnover_charge), stamp: Number(c.stamp_duty), gst: Number(c.gst?.total) };
  if (!KEYS.every(k => Number.isFinite(out[k]) && out[k] >= 0)) return null;
  // Their own total is used as the total: it is the figure Kite shows.
  const total = Number(c.total);
  const sum = withTotal(out).total;
  return { ...out, total: Number.isFinite(total) && Math.abs(total - sum) < 0.01 ? total : sum };
}

const pct = (x: number) => `${+(x * 100).toFixed(5)}%`;
/** The differences between two cards, in words a trader would use. Empty = same rates. */
export function rateChanges(was: RateCard, now: RateCard): string[] {
  const out: string[] = [];
  const moved = (a: number, b: number) => Math.abs(a - b) > Math.max(1e-9, 0.002 * Math.max(Math.abs(a), Math.abs(b)));
  if (Math.abs(was.brokerageFlat - now.brokerageFlat) > 0.005) out.push(`Brokerage ₹${+was.brokerageFlat.toFixed(2)} → ₹${+now.brokerageFlat.toFixed(2)} an order`);
  if (moved(was.sttSell, now.sttSell)) out.push(`STT on sells ${pct(was.sttSell)} → ${pct(now.sttSell)}`);
  if (moved(was.sttBuy, now.sttBuy)) out.push(`STT on buys ${pct(was.sttBuy)} → ${pct(now.sttBuy)}`);
  if (moved(was.exchange, now.exchange)) out.push(`Exchange charge ${pct(was.exchange)} → ${pct(now.exchange)}`);
  if (moved(was.sebi, now.sebi)) out.push(`SEBI fee ₹${+(was.sebi * 1e7).toFixed(2)} → ₹${+(now.sebi * 1e7).toFixed(2)} a crore`);
  if (moved(was.stampBuy, now.stampBuy)) out.push(`Stamp duty on buys ${pct(was.stampBuy)} → ${pct(now.stampBuy)}`);
  if (moved(was.gst, now.gst)) out.push(`GST ${pct(was.gst)} → ${pct(now.gst)}`);
  return out;
}

/** Bring a card into line with Zerodha's answer for a reference buy and sell of
 *  the same value. A rate is kept unless Zerodha's figure contradicts it — by
 *  more than a paise, or for stamp duty (which comes back in whole rupees) by
 *  more than the rounding. Judging in rupees rather than dividing every figure
 *  out means a calculator that rounds its answer to the paisa cannot make a
 *  rate look as if it had moved. */
export function cardFromReference(current: RateCard, buy: Charges, sell: Charges, value: number, day: string): RateCard {
  const frac = (x: number) => Math.round((x / value) * 1e10) / 1e10;
  const off = (ours: number, theirs: number, tol = 0.011) => Math.abs(ours - theirs) > tol;
  const next: RateCard = { ...current, from: day, source: 'zerodha', changes: undefined };
  const mineBuy = estimateOrder(current, 'BUY', value), mineSell = estimateOrder(current, 'SELL', value);
  // A percentage brokerage is capped by the flat fee at a reference this large,
  // so only the cap can be learned from it.
  if (off(mineBuy.brokerage, buy.brokerage)) next.brokerageFlat = r2(buy.brokerage);
  if (off(mineBuy.exchange, buy.exchange)) next.exchange = frac(buy.exchange);
  if (off(mineBuy.sebi, buy.sebi)) next.sebi = frac(buy.sebi);
  if (off(mineSell.stt, sell.stt)) next.sttSell = frac(sell.stt);
  if (off(mineBuy.stt, buy.stt)) next.sttBuy = frac(buy.stt);
  if (off(mineBuy.stamp, buy.stamp, 0.5)) next.stampBuy = frac(buy.stamp);
  // GST is charged on the three fees, so it is judged on Zerodha's own fees: a
  // changed brokerage must not read as a changed GST rate.
  const feeBase = buy.brokerage + buy.exchange + buy.sebi;
  if (feeBase > 0 && off(current.gst * feeBase, buy.gst)) next.gst = Math.round((buy.gst / feeBase) * 1e6) / 1e6;
  return next;
}

// ─────────────────────────────── storage and Zerodha ───────────────────────────────

type Deps = { db: any; now?: () => number };
let D: Deps | null = null;
const now = () => (D?.now ? D.now() : Date.now());

export function initTradeCharges(deps: Deps) {
  D = deps;
  D.db.exec(`
    CREATE TABLE IF NOT EXISTS charge_rates (seg TEXT, day TEXT, json TEXT, fetched_at INTEGER, PRIMARY KEY (seg, day));
    CREATE TABLE IF NOT EXISTS charge_kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS order_charges (owner TEXT, order_id TEXT, day TEXT, qty REAL, avg REAL, json TEXT, fetched_at INTEGER, PRIMARY KEY (owner, order_id));
    CREATE TABLE IF NOT EXISTS journal_capital (kite_user_id TEXT, day TEXT, opening REAL, payin REAL, payout REAL, net REAL, collateral REAL,
      captured_at INTEGER, updated_at INTEGER, PRIMARY KEY (kite_user_id, day));
  `);
  // The journal's own two columns. Added here, after server.ts has created the table.
  for (const col of ['charges REAL', 'charges_detail TEXT']) { try { D.db.exec(`ALTER TABLE trade_journal ADD COLUMN ${col}`); } catch { /* already there */ } }
}

const kvGet = (k: string): string | null => { try { return (D!.db.prepare('SELECT value FROM charge_kv WHERE key = ?').get(k) as any)?.value ?? null; } catch { return null; } };
const kvSet = (k: string, v: string) => { D!.db.prepare('INSERT INTO charge_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v); };

/** The card in force for a segment on a day: the newest learned card that had
 *  started by then, else the newest built-in one that had. */
export function cardFor(seg: Seg, day: string): RateCard {
  if (D) {
    try {
      const row: any = D.db.prepare('SELECT json FROM charge_rates WHERE seg = ? AND day <= ? ORDER BY day DESC LIMIT 1').get(seg, day);
      if (row?.json) { const c = JSON.parse(row.json); if (c && fin(c.exchange)) return c as RateCard; }
    } catch { /* fall through to the built-in card */ }
  }
  const list = BUILTIN.filter(c => c.seg === seg);
  return list.find(c => c.from <= day) || list[list.length - 1];
}
/** The day Zerodha's calculator last agreed with (or replaced) the card for a segment. */
export const checkedOn = (seg: Seg): string | null => kvGet(`checked:${seg}`);
/** A formula figure is 'rates' when the card it used is one Zerodha's calculator
 *  produced, or a written-down card the calculator has agreed with; 'builtin'
 *  when it is a written-down card nothing has checked (a trade from before April
 *  2026, or an account that never reached the calculator). The agreement is
 *  remembered per card, so a later rate change does not un-confirm the days the
 *  old card covered. */
function formulaSource(seg: Seg, day: string): ChargeSource {
  const card = cardFor(seg, day);
  return card.source === 'zerodha' || kvGet(`agreed:${seg}:${card.from}`) ? 'rates' : 'builtin';
}

// Two rests, kept apart on purpose. Pricing the day's real orders and the
// once-a-day rate check both go through the same calculator, but a failed rate
// check (an imaginary order the calculator will not take, say) must never stop
// real orders being priced — with one shared rest it would have, on every pass,
// for good.
let contractNoteDownUntil = 0;
let rateCheckDownUntil = 0;
async function contractNote(kc: any, orders: ExecOrder[], rateCheck = false): Promise<(Charges | null)[] | null> {
  if (!kc || typeof kc.getvirtualContractNote !== 'function' || !orders.length) return null;
  if (now() < (rateCheck ? rateCheckDownUntil : contractNoteDownUntil)) return null;
  try {
    const res: any = await kc.getvirtualContractNote(orders.map(o => ({
      order_id: String(o.order_id), exchange: o.exchange, tradingsymbol: o.tradingsymbol, transaction_type: o.transaction_type,
      variety: 'regular', product: o.product || 'MIS', order_type: 'MARKET', quantity: o.quantity, average_price: o.average_price,
    })));
    // The answer carries no order id: it is matched by position, so a list of a
    // different length cannot be trusted at all.
    if (!Array.isArray(res) || res.length !== orders.length) throw new Error(`contract note returned ${Array.isArray(res) ? res.length : typeof res} for ${orders.length} orders`);
    return res.map((r: any, i: number) => (String(r?.tradingsymbol || '') === orders[i].tradingsymbol && String(r?.transaction_type || '') === orders[i].transaction_type ? fromZerodha(r?.charges) : null));
  } catch (e: any) {
    // The import runs every five minutes; a calculator that is down should not
    // be asked on every pass. Ten minutes for real orders, an hour for the rate
    // check (it is wanted once a day and the current card stays in force meanwhile).
    if (rateCheck) { rateCheckDownUntil = now() + 60 * 60 * 1000; console.error('[charges] rate check could not use Zerodha\'s calculator — keeping the current rates:', e?.message || e); }
    else { contractNoteDownUntil = now() + 10 * 60 * 1000; console.error('[charges] Zerodha contract note unavailable — using the rate card:', e?.message || e); }
    return null;
  }
}

/** Once a trading day per segment: put a reference buy and sell through Zerodha's
 *  calculator and bring the card into line with the answer. */
async function learnRates(kc: any, sample: ExecOrder, day: string): Promise<void> {
  const seg = segOf(sample.exchange, sample.tradingsymbol);
  if (kvGet(`learned:${seg}`) === day) return;
  // A real contract at the price it actually traded, in a size big enough for
  // the ratios to be exact (16 lots of NIFTY): nothing about the reference pair
  // is unusual except that nobody placed it.
  const qty = sample.quantity * Math.max(1, Math.ceil(1000 / sample.quantity)), price = sample.average_price, value = qty * price;
  const ref = (side: 'BUY' | 'SELL'): ExecOrder => ({ ...sample, order_id: `RATES-${side}`, transaction_type: side, quantity: qty, average_price: price });
  const res = await contractNote(kc, [ref('BUY'), ref('SELL')], true);
  if (!res || !res[0] || !res[1]) return;
  const current = cardFor(seg, day);
  const learned = cardFromReference(current, res[0], res[1], value, day);
  const changes = rateChanges(current, learned);
  if (changes.length) {
    learned.changes = changes;
    D!.db.prepare('INSERT INTO charge_rates (seg, day, json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(seg, day) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      .run(seg, day, JSON.stringify(learned), now());
    console.log(`[charges] ${seg} rates changed from ${day}: ${changes.join('; ')}`);
  }
  else if (current.source === 'builtin') kvSet(`agreed:${seg}:${current.from}`, day);
  kvSet(`checked:${seg}`, day); kvSet(`learned:${seg}`, day);
}

/** Charges for today's executed orders: Zerodha's own figure for each where it
 *  can be had (kept once fetched), the formula otherwise. Never throws. */
export async function chargesForOrders(kc: any, owner: string, orders: ExecOrder[], day: string): Promise<Map<string, OrderCharge>> {
  const out = new Map<string, OrderCharge>();
  const good = orders.filter(o => o && o.order_id && o.quantity > 0 && o.average_price > 0 && (o.transaction_type === 'BUY' || o.transaction_type === 'SELL'));
  try {
    const need: ExecOrder[] = [];
    const sel = D!.db.prepare('SELECT qty, avg, json FROM order_charges WHERE owner = ? AND order_id = ?');
    for (const o of good) {
      const row: any = sel.get(owner, String(o.order_id));
      // An order still filling changes quantity and average between imports; only an identical order is a hit.
      if (row && Math.abs(row.qty - o.quantity) < 1e-9 && Math.abs(row.avg - o.average_price) < 1e-6) {
        try { out.set(String(o.order_id), { qty: o.quantity, charges: JSON.parse(row.json), source: 'zerodha' }); continue; } catch { /* refetch */ }
      }
      need.push(o);
    }
    const res = need.length ? await contractNote(kc, need) : null;
    const put = D!.db.prepare('INSERT INTO order_charges (owner, order_id, day, qty, avg, json, fetched_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner, order_id) DO UPDATE SET day = excluded.day, qty = excluded.qty, avg = excluded.avg, json = excluded.json, fetched_at = excluded.fetched_at');
    need.forEach((o, i) => {
      const z = res ? res[i] : null;
      if (z) { put.run(owner, String(o.order_id), day, o.quantity, o.average_price, JSON.stringify(tidy(z)), now()); out.set(String(o.order_id), { qty: o.quantity, charges: z, source: 'zerodha' }); }
      else { const seg = segOf(o.exchange, o.tradingsymbol); out.set(String(o.order_id), { qty: o.quantity, charges: estimateOrder(cardFor(seg, day), o.transaction_type, o.quantity * o.average_price), source: formulaSource(seg, day) }); }
    });
    // The once-a-day rate check, AFTER the real orders and only when the
    // calculator has just answered (or had nothing to answer): if it is down
    // there is no point asking it a second question.
    if (good.length && (res || !need.length)) { try { await learnRates(kc, good[0], day); } catch (e: any) { console.error('[charges] rate check failed:', e?.message || e); } }
  } catch (e: any) {
    console.error('[charges] could not price the orders — the journal will estimate:', e?.message || e);
  }
  return out;
}

/** One journal row's share of its orders' charges.
 *  A row is one entry order (or part of it) closed by one or more exit orders
 *  (or parts of them); each order's charges are split by quantity. */
export function allocateRow(a: {
  sym: string; exchange?: string | null; side: string; qty: number; entryAvg: number; exitAvg: number | null; status: string;
  entryOrderId: string | null; entryDay: string; exitDay: string | null; exits: Map<string, number>;
  prior?: { detail: RowDetail | null; qty: number } | null;
}, priced: Map<string, OrderCharge>): { total: number; detail: RowDetail } | null {
  if (!(a.qty > 0) || !(a.entryAvg > 0)) return null;
  const seg = segOf(a.exchange, a.sym);
  const entrySide: 'BUY' | 'SELL' = String(a.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const exitSide: 'BUY' | 'SELL' = entrySide === 'BUY' ? 'SELL' : 'BUY';
  let src: ChargeSource = 'zerodha'; let orders = 0;

  let entry: Charges;
  const eo = a.entryOrderId ? priced.get(a.entryOrderId) : undefined;
  if (eo && eo.qty > 0) { entry = scaleCharges(eo.charges, a.qty / eo.qty); src = worst(src, eo.source); orders += 1; }
  // A position carried in: its entry was charged on the day it was bought. If the
  // journal priced that entry then, that figure is the one — not today's rates.
  else if (a.prior?.detail?.entry && a.prior.qty > 0) { entry = scaleCharges(a.prior.detail.entry, a.qty / a.prior.qty); src = worst(src, a.prior.detail.src); orders += 1; }
  else { entry = estimateOrder(cardFor(seg, a.entryDay), entrySide, a.qty * a.entryAvg); src = worst(src, formulaSource(seg, a.entryDay)); orders += 1; }

  let exit: Charges | null = null;
  if (a.status === 'CLOSED' && a.exitAvg != null && a.exitAvg > 0) {
    exit = { ...ZERO };
    let covered = 0;
    for (const [oid, q] of a.exits) {
      const xo = priced.get(oid);
      if (!xo || !(xo.qty > 0) || !(q > 0)) continue;
      exit = addCharges(exit, scaleCharges(xo.charges, q / xo.qty)); src = worst(src, xo.source); covered += q; orders += 1;
    }
    // Whatever no priced order accounts for (nothing, normally) goes through the formula as one order.
    const rest = a.qty - covered;
    if (rest > 1e-9) { const day = a.exitDay || a.entryDay; exit = addCharges(exit, estimateOrder(cardFor(seg, day), exitSide, rest * a.exitAvg)); src = worst(src, formulaSource(seg, day)); orders += 1; }
  }
  const total = r2(entry.total + (exit ? exit.total : 0));
  return { total, detail: { v: 1, src, entry: tidy(entry), exit: exit ? tidy(exit) : null, qty: a.qty, orders } };
}

export function parseDetail(json: any): RowDetail | null {
  if (!json) return null;
  try { const d = typeof json === 'string' ? JSON.parse(json) : json; return d && d.v === 1 && d.entry && fin(d.entry.total) ? d as RowDetail : null; } catch { return null; }
}

// ─────────────────────────────── capital ───────────────────────────────

/** Store today's opening balance (once) and keep the day's pay-ins and pay-outs
 *  current. Zerodha's opening balance is the day's from the start of the session
 *  until its end-of-day run, so it is only read between 09:00 and 18:00 IST —
 *  outside that the same field can still mean yesterday, or already tomorrow. */
export async function captureCapital(kc: any, owner: string | null): Promise<void> {
  try {
    if (!D || !owner || !kc || !kc.access_token || typeof kc.getMargins !== 'function') return;
    const t = now(), m = istMinute(t), day = istDay(t);
    const wd = new Date(t + IST_MS).getUTCDay();
    if (wd === 0 || wd === 6 || m < 9 * 60 || m >= 18 * 60) return;
    const have: any = D.db.prepare('SELECT updated_at FROM journal_capital WHERE kite_user_id = ? AND day = ?').get(owner, day);
    if (have && t - have.updated_at < 4 * 60 * 1000) return;       // the import runs every five minutes; once per pass is plenty
    const all: any = await kc.getMargins();
    const eq = all?.equity || all;
    const opening = Number(eq?.available?.opening_balance);
    if (!Number.isFinite(opening)) return;
    const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const payin = num(eq?.available?.intraday_payin), payout = num(eq?.utilised?.payout), net = num(eq?.net), collateral = num(eq?.available?.collateral);
    if (have) D.db.prepare('UPDATE journal_capital SET payin = ?, payout = ?, net = ?, collateral = ?, updated_at = ? WHERE kite_user_id = ? AND day = ?').run(payin, payout, net, collateral, t, owner, day);
    else D.db.prepare('INSERT INTO journal_capital (kite_user_id, day, opening, payin, payout, net, collateral, captured_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(owner, day, opening, payin, payout, net, collateral, t, t);
  } catch (e: any) { console.error('[charges] capital snapshot failed:', e?.message || e); }
}

// ─────────────────────────────── the journal's view ───────────────────────────────

export type RowAccount = { charges: number | null; chargesSrc: ChargeSource | null; breakdown: Charges | null; orders: number | null; net: number | null; capitalAfter: number | null };
/** carriedIn: what positions bought on an earlier day and sold today put back
 *  into the account (proceeds less today's charges). It is part of `left` but
 *  not of the day's own trades, so the page names it or the day would not add up. */
export type DayAccount = { opening: number; added: number; withdrawn: number; left: number; inOpen: number; openTrades: number; carriedIn: number; carriedTrades: number; complete: boolean };

/** Charges for one stored row: what the import priced, else the formula on the
 *  row's own prices (one entry order, one exit order). */
export function rowCharges(r: any): { entry: Charges; exit: Charges | null; src: ChargeSource; orders: number; total: number } | null {
  const qty = Number(r.qty), ep = Number(r.entry_price), xp = Number(r.exit_price);
  const seg = segOf(r.exchange, r.tradingsymbol);
  const entrySide: 'BUY' | 'SELL' = String(r.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const closed = r.status === 'CLOSED' && xp > 0;
  const formulaExit = (): { c: Charges; src: ChargeSource } => {
    const xDay = r.exit_time ? istDay(Number(r.exit_time)) : istDay(Number(r.entry_time));
    return { c: estimateOrder(cardFor(seg, xDay), entrySide === 'BUY' ? 'SELL' : 'BUY', qty * xp), src: formulaSource(seg, xDay) };
  };
  const d = parseDetail(r.charges_detail);
  if (d && fin(r.charges)) {
    if (d.exit || !closed) return { entry: d.entry, exit: d.exit, src: d.src, orders: d.orders, total: Number(r.charges) };
    // Priced while it was open, then closed by the app's own exit path (which
    // writes the exit price but knows nothing of charges). Until the next import
    // rebuilds the row from the broker's fills, the exit leg is the formula's.
    const x = formulaExit();
    return { entry: d.entry, exit: x.c, src: worst(d.src, x.src), orders: d.orders + 1, total: r2(d.entry.total + x.c.total) };
  }
  if (!(qty > 0) || !(ep > 0) || !r.entry_time) return null;
  const eDay = istDay(Number(r.entry_time));
  let src = formulaSource(seg, eDay);
  const entry = estimateOrder(cardFor(seg, eDay), entrySide, qty * ep);
  let exit: Charges | null = null;
  if (closed) { const x = formulaExit(); exit = x.c; src = worst(src, x.src); }
  return { entry, exit, src, orders: exit ? 2 : 1, total: r2(entry.total + (exit ? exit.total : 0)) };
}

/** Charges, net P&L and capital for a set of journal rows (one account).
 *  `rows` must hold every row entered OR closed on the days being shown, or the
 *  running balance will miss a trade. */
export function accountRows(rows: any[], capital: any[]): { byId: Map<number, RowAccount>; days: Record<string, DayAccount> } {
  const byId = new Map<number, RowAccount>();
  const parts = new Map<number, { entry: number; exit: number }>();
  for (const r of rows) {
    const c = rowCharges(r);
    if (!c) { byId.set(r.id, { charges: null, chargesSrc: null, breakdown: null, orders: null, net: null, capitalAfter: null }); continue; }
    const all = c.exit ? addCharges(c.entry, c.exit) : c.entry;
    const total = c.total;
    parts.set(r.id, { entry: c.entry.total, exit: c.exit ? c.exit.total : 0 });
    byId.set(r.id, {
      charges: total, chargesSrc: c.src, orders: c.orders,
      breakdown: { brokerage: r2(all.brokerage), stt: r2(all.stt), exchange: r2(all.exchange), sebi: r2(all.sebi), stamp: r2(all.stamp), gst: r2(all.gst), total },
      net: r.status === 'CLOSED' && fin(r.pnl) ? r2(r.pnl - total) : null, capitalAfter: null,
    });
  }
  const days: Record<string, DayAccount> = {};
  // Paper trades never touched the account.
  const real = rows.filter(r => !r.test_mode && !r.simulated);
  for (const cap of capital) {
    const day = String(cap.day); const opening = Number(cap.opening);
    if (!Number.isFinite(opening)) continue;
    const added = Number(cap.payin) || 0, withdrawn = Number(cap.payout) || 0;
    let running = opening + added - withdrawn, complete = true, carriedIn = 0, carriedTrades = 0;
    const closedToday = real.filter(r => r.status === 'CLOSED' && r.exit_time && istDay(Number(r.exit_time)) === day)
      .sort((x, y) => Number(x.exit_time) - Number(y.exit_time) || x.id - y.id);
    for (const r of closedToday) {
      const p = parts.get(r.id), acc = byId.get(r.id)!;
      const sameDay = r.entry_time && istDay(Number(r.entry_time)) === day;
      let effect: number | null = null;
      if (p && sameDay && fin(r.pnl)) effect = r.pnl - (p.entry + p.exit);
      // Carried in: the premium left the account on an earlier day, so today the
      // account receives the sale proceeds (or pays to buy back a short), less
      // today's charges only.
      else if (p && !sameDay && Number(r.exit_price) > 0) effect = (String(r.side).toUpperCase() === 'SELL' ? -1 : 1) * Number(r.qty) * Number(r.exit_price) - p.exit;
      if (effect === null) { complete = false; continue; }
      if (!sameDay) { carriedIn += effect; carriedTrades++; }
      running += effect; acc.capitalAfter = r2(running);
    }
    // Opened today and not closed today: the entry charge is spent; the premium
    // is still in the trade and is reported beside the balance, not taken off it.
    const stillOpen = real.filter(r => r.entry_time && istDay(Number(r.entry_time)) === day && !(r.status === 'CLOSED' && r.exit_time && istDay(Number(r.exit_time)) === day));
    let inOpen = 0;
    for (const r of stillOpen) { const p = parts.get(r.id); if (p) running -= p.entry; inOpen += (Number(r.qty) || 0) * (Number(r.entry_price) || 0); }
    days[day] = { opening: r2(opening), added: r2(added), withdrawn: r2(withdrawn), left: r2(running), inOpen: r2(inOpen), openTrades: stillOpen.length, carriedIn: r2(carriedIn), carriedTrades, complete };
  }
  return { byId, days };
}

/** Everything the journal needs for one account over a date range. */
export function journalAccounts(owner: string, fromMs: number, toMs: number): { byId: Map<number, RowAccount>; days: Record<string, DayAccount> } {
  const rows = D!.db.prepare(
    `SELECT * FROM trade_journal WHERE kite_user_id = ? AND ((entry_time >= ? AND entry_time <= ?) OR (exit_time >= ? AND exit_time <= ?))`
  ).all(owner, fromMs, toMs, fromMs, toMs) as any[];
  const capital = D!.db.prepare('SELECT * FROM journal_capital WHERE kite_user_id = ? AND day >= ? AND day <= ?').all(owner, istDay(Math.max(0, fromMs)), istDay(toMs)) as any[];
  return accountRows(rows, capital);
}

/** The rates in force today, for the note under the journal. */
export function ratesInfo(seg: Seg = 'NFO-OPT') {
  const day = istDay(now()); const c = cardFor(seg, day);
  return {
    seg, from: c.from, source: c.source, checkedOn: checkedOn(seg), changes: c.changes || null,
    brokerage: c.brokerageFlat, sttSellPct: +(c.sttSell * 100).toFixed(5), exchangePct: +(c.exchange * 100).toFixed(5),
    sebiPerCrore: +(c.sebi * 1e7).toFixed(2), stampBuyPct: +(c.stampBuy * 100).toFixed(5), gstPct: +(c.gst * 100).toFixed(3),
  };
}

export const __test = { learnRates, contractNote, kvGet, resetBackoff() { contractNoteDownUntil = 0; rateCheckDownUntil = 0; } };
