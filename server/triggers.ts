// PENDING PRICE TRIGGERS — the first thing in this app that places an order while
// the user is not looking. Everything here is written around that fact.
//
// You arm a level on an option chart ("buy this contract when the premium reaches
// 150") and walk away. When the premium touches the level the order goes in.
//
// The safety rules, and why each exists:
//   * SERVER-SIDE AND PERSISTED. A trigger you armed must not disappear because
//     you closed the app, reloaded, or because a deploy restarted the server —
//     you would believe it was still armed. Rows live in sqlite and are reloaded.
//   * FIRES EXACTLY ONCE. The claim is a single conditional UPDATE; whichever tick
//     wins it is the only one that can place the order. Ticks arrive many times a
//     second, so anything less would double-buy.
//   * MARKET HOURS ONLY, and every armed trigger EXPIRES at the close. An
//     overnight trigger firing into a gap the next morning is not what anyone
//     means by "buy at 150".
//   * ORDERS GO THROUGH THE APP'S OWN /api/orders. Kite rejects plain MARKET
//     orders from the API, so that route converts them to a limit priced just
//     past the market. Duplicating that logic here would eventually drift from it.
//   * FAILURES ARE RECORDED, never retried silently. A trigger that could not be
//     placed is marked FAILED with the reason and stops; a silent retry loop
//     against a broker is how one intended trade becomes five.

import express from 'express';
import { getKiteClient } from './kite_service';
import axios from 'axios';
import { isNseHoliday } from './calendar_service';

const IST_MS = 5.5 * 3600 * 1000;
const istNow = () => new Date(Date.now() + IST_MS);
const istDate = () => {
  const x = istNow();
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};
const istMinuteOfDay = () => { const x = istNow(); return x.getUTCHours() * 60 + x.getUTCMinutes(); };

export const TRIGGER_WINDOW = { openMin: 555, closeMin: 940 }; // 09:15 – 15:40 IST (CAS-era derivatives close)

/** Pure: is the market open for triggers right now? */
export function marketOpenFor(dateStr: string, weekday: number, minuteOfDay: number, holiday: boolean): boolean {
  if (weekday === 0 || weekday === 6) return false;
  if (holiday) return false;
  return minuteOfDay >= TRIGGER_WINDOW.openMin && minuteOfDay <= TRIGGER_WINDOW.closeMin;
}
function marketOpenNow(): boolean {
  const x = istNow();
  return marketOpenFor(istDate(), x.getUTCDay(), istMinuteOfDay(), isNseHoliday(istDate()));
}

/** Pure: which way must price move to reach the level, decided when arming. */
export function directionFor(triggerPrice: number, currentPrice: number): 'UP' | 'DOWN' {
  return triggerPrice > currentPrice ? 'UP' : 'DOWN';
}

/** Pure: has the level been reached? */
export function isHit(direction: 'UP' | 'DOWN', triggerPrice: number, ltp: number): boolean {
  return direction === 'UP' ? ltp >= triggerPrice : ltp <= triggerPrice;
}

let db: any = null;

export function initTriggers(database: any) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS pending_triggers (
    id TEXT PRIMARY KEY,
    created_at INTEGER, trade_date TEXT,
    tradingsymbol TEXT, instrument_token INTEGER, exchange TEXT,
    side TEXT, product TEXT, quantity INTEGER,
    trigger_price REAL, direction TEXT, armed_at_price REAL,
    status TEXT,                 -- ARMED | FIRING | FIRED | CANCELLED | EXPIRED | FAILED
    fired_at INTEGER, fired_price REAL, order_id TEXT, error TEXT
  );`);
  // Sizing at the moment of firing needs the contract's lot size (to size in
  // whole lots) and records what was actually placed and why, when that differs.
  try { db.exec(`ALTER TABLE pending_triggers ADD COLUMN lot_size INTEGER`); } catch (e) { /* exists */ }
  try { db.exec(`ALTER TABLE pending_triggers ADD COLUMN placed_qty INTEGER`); } catch (e) { /* exists */ }
  try { db.exec(`ALTER TABLE pending_triggers ADD COLUMN note TEXT`); } catch (e) { /* exists */ }
  // Anything left ARMED from an earlier day cannot be honoured today — the level
  // meant something in yesterday's market. Retire them at boot.
  try {
    const n = db.prepare(`UPDATE pending_triggers SET status='EXPIRED', error='not carried past its trading day'
      WHERE status IN ('ARMED','FIRING') AND trade_date <> ?`).run(istDate());
    if (n?.changes) console.log(`[triggers] expired ${n.changes} stale trigger(s) from a previous day`);
    // A FIRING row means the server died mid-placement. We cannot know whether the
    // order reached the broker, so it is flagged for the user, never re-fired.
    const f = db.prepare(`UPDATE pending_triggers SET status='FAILED', error='server restarted while placing — CHECK YOUR ORDERS IN KITE'
      WHERE status='FIRING'`).run();
    if (f?.changes) console.warn(`[triggers] ${f.changes} trigger(s) were mid-placement at restart — flagged, not retried`);
  } catch (e) { console.error('[triggers] boot cleanup failed', e); }
}

/** Tokens that must be on the live feed for triggers to be able to fire. */
export function armedTriggerTokens(): number[] {
  if (!db) return [];
  try {
    return (db.prepare(`SELECT DISTINCT instrument_token FROM pending_triggers WHERE status='ARMED'`).all() as any[])
      .map(r => Number(r.instrument_token)).filter(t => t > 0);
  } catch (e) { return []; }
}

export function expireAtClose() {
  if (!db) return;
  try {
    const n = db.prepare(`UPDATE pending_triggers SET status='EXPIRED', error='market closed before the level was reached'
      WHERE status='ARMED'`).run();
    if (n?.changes) console.log(`[triggers] ${n.changes} trigger(s) expired at the close`);
  } catch (e) {}
}

// SIZE AT THE MOMENT OF FIRING. Armed BUYs were being rejected for insufficient
// funds almost every time. The size was fixed at ARM time: AUTO MAX divided the
// whole balance by the cost of a lot at the TRIGGER price, leaving no headroom.
// But the order is sent as a limit 0.5% ABOVE the live price (Kite rejects plain
// market orders via the API — see /api/orders), and when it fires the live price
// is at or past the level. So Zerodha blocks at least 0.5% more than was sized
// for, and a size that used every rupee cannot cover it.
//
// Now, when the level hits, the server reads the funds available right then,
// prices ONE lot exactly as the order will be priced (live price x 1.005, on the
// 0.05 tick) with Zerodha's own margin calculator — charges included — and places
// the largest whole number of lots that fits within 98.5% of funds, NEVER MORE
// than was armed. The 1.5% margin covers the few hundred milliseconds between
// this check and the order, during which /api/orders re-reads the price.
//
// Fewer lots than armed is recorded with the reason. Not even one lot affordable
// means no order is sent, with the numbers — the same outcome as a rejection, but
// said plainly and before it happens. Anything that cannot be checked (session,
// rate limit, an old trigger without its lot size) falls back to the armed size,
// exactly as before: a sizing step that fails must never block a trade.
const FUNDS_HEADROOM = 0.985;
export function fitLots(armedLots: number, perLot: number, available: number): number {
  if (!(armedLots > 0) || !(perLot > 0) || !(available >= 0)) return armedLots;
  return Math.max(0, Math.min(armedLots, Math.floor((available * FUNDS_HEADROOM) / perLot)));
}
async function sizeAtFire(row: any, ltp: number): Promise<{ qty: number; note: string | null; fail?: string }> {
  const armedQty = Number(row.quantity) || 0;
  const lot = Number(row.lot_size) || 0;
  if (!(lot > 0) || !(armedQty >= lot) || String(row.side) !== 'BUY') return { qty: armedQty, note: null };
  try {
    const kc: any = getKiteClient();
    if (!kc || !kc.access_token) return { qty: armedQty, note: null };
    const limit = Math.round((ltp * 1.005) / 0.05) * 0.05;       // exactly as /api/orders prices it
    const [mg, funds] = await Promise.all([
      kc.orderMargins([{
        exchange: String(row.exchange || 'NFO'), tradingsymbol: String(row.tradingsymbol),
        transaction_type: 'BUY', variety: 'regular', product: String(row.product || 'NRML'),
        order_type: 'LIMIT', quantity: lot, price: +limit.toFixed(2), trigger_price: 0,
      }]),
      kc.getMargins(),
    ]);
    const perLot = Number(mg?.[0]?.total) + (Number(mg?.[0]?.charges?.total) || 0);
    const available = Number(funds?.equity?.available?.live_balance ?? funds?.equity?.net);
    if (!(perLot > 0) || !isFinite(available)) return { qty: armedQty, note: null };
    const armedLots = Math.floor(armedQty / lot);
    const lots = fitLots(armedLots, perLot, available);
    if (lots < 1) {
      return { qty: 0, note: null,
        fail: `Not enough funds for 1 lot at ~${limit.toFixed(2)}: one lot needs ₹${Math.round(perLot).toLocaleString('en-IN')}, available ₹${Math.round(available).toLocaleString('en-IN')}. No order sent.` };
    }
    const qty = lots * lot;
    return { qty, note: lots < armedLots
      ? `Placed ${lots} of ${armedLots} lots — ${armedLots} would need ₹${Math.round(armedLots * perLot).toLocaleString('en-IN')} at ~${limit.toFixed(2)}; ₹${Math.round(available).toLocaleString('en-IN')} available.`
      : null };
  } catch (e: any) {
    console.warn('[triggers] fire-time sizing unavailable, using the armed size:', e?.message || e);
    return { qty: armedQty, note: null };
  }
}

async function placeThroughOwnApi(row: any): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  const port = process.env.PORT || 3000;
  try {
    // 127.0.0.1 with proxy explicitly OFF: this must never be routed through the
    // Bangalore proxy — it is a call to ourselves, and the proxy is for Zerodha.
    const r = await axios.post(`http://127.0.0.1:${port}/api/orders`, {
      action: row.side,
      tradingsymbol: row.tradingsymbol,
      exchange: row.exchange,
      quantity: row.quantity,
      product: row.product,
      order_type: 'MARKET',
    }, { timeout: 15000, proxy: false });
    const d = r.data || {};
    if (d.success === false) return { ok: false, error: d.error || 'order rejected' };
    return { ok: true, orderId: d.order_id || d.orderId || (d.data && d.data.order_id) };
  } catch (e: any) {
    return { ok: false, error: e?.response?.data?.error || e?.message || String(e) };
  }
}

/** Called for every tick of a subscribed instrument. Hot path: keep it cheap. */
export function onTickForTriggers(token: number, ltp: number) {
  if (!db || !(ltp > 0)) return;
  let rows: any[];
  try {
    rows = db.prepare(`SELECT * FROM pending_triggers WHERE status='ARMED' AND instrument_token = ?`).all(Number(token)) as any[];
  } catch (e) { return; }
  if (!rows.length) return;

  for (const row of rows) {
    if (!isHit(row.direction, row.trigger_price, ltp)) continue;

    // Refuse outside market hours even though a tick arrived — pre-open and
    // post-close prints exist, and neither is a tradable moment.
    if (!marketOpenNow()) continue;

    // THE ONE-SHOT CLAIM. Ticks arrive many times a second; only the update that
    // actually changes a row may proceed to place an order.
    let claimed = false;
    try {
      const res = db.prepare(`UPDATE pending_triggers SET status='FIRING', fired_price=? WHERE id=? AND status='ARMED'`)
        .run(ltp, row.id);
      claimed = res.changes === 1;
    } catch (e) { claimed = false; }
    if (!claimed) continue;

    console.log(`[triggers] ${row.side} ${row.quantity} ${row.tradingsymbol} — level ${row.trigger_price} reached at ${ltp}`);
    sizeAtFire(row, ltp).then((sz) => {
      if (sz.fail) {
        try {
          db.prepare(`UPDATE pending_triggers SET status='FAILED', fired_at=?, error=? WHERE id=?`)
            .run(Date.now(), sz.fail.slice(0, 300), row.id);
        } catch (e) {}
        console.error(`[triggers] NOT PLACED ${row.tradingsymbol}: ${sz.fail}`);
        return null;
      }
      try { db.prepare(`UPDATE pending_triggers SET placed_qty=?, note=? WHERE id=?`).run(sz.qty, sz.note, row.id); } catch (e) {}
      if (sz.note) console.warn(`[triggers] ${row.tradingsymbol}: ${sz.note}`);
      return placeThroughOwnApi({ ...row, quantity: sz.qty });
    }).then((out) => {
      if (!out) return;
      try {
        if (out.ok) {
          db.prepare(`UPDATE pending_triggers SET status='FIRED', fired_at=?, order_id=? WHERE id=?`)
            .run(Date.now(), out.orderId || '', row.id);
          console.log(`[triggers] placed ${row.tradingsymbol} order ${out.orderId || '(no id)'}`);
        } else {
          db.prepare(`UPDATE pending_triggers SET status='FAILED', fired_at=?, error=? WHERE id=?`)
            .run(Date.now(), String(out.error).slice(0, 300), row.id);
          console.error(`[triggers] FAILED ${row.tradingsymbol}: ${out.error}`);
        }
      } catch (e) { console.error('[triggers] could not record outcome', e); }
    }).catch((e) => console.error('[triggers] fire chain error — check Kite for this order', e));
  }
}

export function registerTriggers(app: any, database: any) {
  initTriggers(database);

  app.post('/api/triggers', express.json(), async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const quantity = parseInt(String(b.quantity), 10);
      const triggerPrice = parseFloat(String(b.trigger_price));
      const currentPrice = parseFloat(String(b.current_price));
      const token = parseInt(String(b.instrument_token), 10);
      const side = String(b.side || '').toUpperCase();
      const product = String(b.product || 'NRML').toUpperCase();

      if (!b.tradingsymbol || !token) return res.status(400).json({ ok: false, error: 'contract required' });
      if (!(quantity > 0)) return res.status(400).json({ ok: false, error: 'quantity required' });
      if (!(triggerPrice > 0)) return res.status(400).json({ ok: false, error: 'trigger price required' });
      if (!(currentPrice > 0)) return res.status(400).json({ ok: false, error: 'current price required to decide direction' });
      if (side !== 'BUY' && side !== 'SELL') return res.status(400).json({ ok: false, error: 'side must be BUY or SELL' });
      if (product !== 'MIS' && product !== 'NRML') return res.status(400).json({ ok: false, error: 'product must be MIS or NRML' });

      // MARGIN PRE-CHECK. Two of Martin's armed entries were rejected by Zerodha
      // at the moment the level was reached — for insufficient funds — after he
      // had already waited on them. The level came, the entry did not, and he
      // found out days later. Asking the broker NOW turns that into a question he
      // can answer while it still matters.
      //
      // Advisory, not a veto: margin moves during the day, and refusing outright
      // would sometimes be wrong. So a shortfall comes back as needsConfirm and
      // the caller may re-send with force:true. Anything that fails or is
      // unavailable ARMS NORMALLY — a broken pre-check must never block a trade.
      if (!b.force) {
        try {
          const kc = getKiteClient();
          // @ts-ignore
          if (kc && kc.access_token) {
            const [mg, funds] = await Promise.all([
              kc.orderMargins([{
                exchange: String(b.exchange || 'NFO'),
                tradingsymbol: String(b.tradingsymbol).toUpperCase(),
                transaction_type: side,
                variety: 'regular',
                product,
                order_type: 'MARKET',
                quantity,
                price: 0,
                trigger_price: 0,
              }]),
              kc.getMargins(),
            ]);
            const required = Number(mg?.[0]?.total);
            const available = Number(funds?.equity?.available?.live_balance ?? funds?.equity?.net);
            if (isFinite(required) && isFinite(available) && required > available) {
              return res.status(409).json({
                ok: false,
                needsConfirm: true,
                reason: 'INSUFFICIENT_MARGIN',
                required: Math.round(required * 100) / 100,
                available: Math.round(available * 100) / 100,
                shortfall: Math.round((required - available) * 100) / 100,
                error: `Margin required ${Math.round(required)} but only ${Math.round(available)} available — short by ${Math.round(required - available)}. Zerodha would reject this when the level is hit.`,
              });
            }
          }
        } catch (e) {
          // Pre-check unavailable (session, rate limit, market closed). Arm anyway
          // rather than block on a check that is only advisory.
          console.warn('[triggers] margin pre-check skipped:', (e as any)?.message || e);
        }
      }

      const id = `trg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`INSERT INTO pending_triggers
        (id, created_at, trade_date, tradingsymbol, instrument_token, exchange, side, product, quantity,
         trigger_price, direction, armed_at_price, status, lot_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ARMED', ?)`)
        .run(id, Date.now(), istDate(), String(b.tradingsymbol).toUpperCase(), token,
             String(b.exchange || 'NFO'), side, product, quantity,
             triggerPrice, directionFor(triggerPrice, currentPrice), currentPrice,
             (parseInt(String(b.lot_size), 10) > 0 ? parseInt(String(b.lot_size), 10) : null));

      res.json({
        ok: true, id, direction: directionFor(triggerPrice, currentPrice),
        note: marketOpenNow()
          ? 'armed — will place a market order when the level is reached'
          : 'armed, but the market is closed; it expires at the next close if untouched',
      });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  app.get('/api/triggers', (_req: any, res: any) => {
    try {
      const rows = db.prepare(`SELECT * FROM pending_triggers ORDER BY created_at DESC LIMIT 50`).all();
      res.json({ marketOpen: marketOpenNow(), rows });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.delete('/api/triggers/:id', (req: any, res: any) => {
    try {
      const r = db.prepare(`UPDATE pending_triggers SET status='CANCELLED' WHERE id=? AND status='ARMED'`)
        .run(String(req.params.id));
      // A trigger already FIRING or FIRED cannot be called back — say so plainly
      // rather than reporting a cancellation that did not happen.
      res.json({ ok: r.changes === 1, cancelled: r.changes === 1,
        error: r.changes === 1 ? undefined : 'not cancellable — it has already fired or is being placed' });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Retire anything still armed once the market has closed. Checked on a timer
  // rather than a cron so a restart mid-afternoon still picks it up.
  setInterval(() => {
    try { if (istMinuteOfDay() > TRIGGER_WINDOW.closeMin) expireAtClose(); } catch (e) {}
  }, 60000);

  console.log('[triggers] price-trigger engine registered');
}
