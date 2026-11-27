// TRADE GUARD (11 Nov 2026). Martin's own rules, enforced by the server.
//
// WHY: his journal (19 Oct – 11 Nov, 56 trades, −₹7,302) showed the losses come
// from three habits, not from any one indicator: the first trade of the day
// (2 wins in 15, mostly 09:15–10:00, that hour alone −₹14k), long days (the 5th+
// trade of a day −₹11k) and red days that kept going. He chose these rules:
//   • no NEW entry before 10:00 IST,
//   • at most 4 entries a day,
//   • once the day's P&L reaches −₹3,000, no more entries today.
//
// WHAT IT BLOCKS: only OPENING orders that Martin places himself — the order
// ticket / Quick Trade (POST /api/orders with journal:true), My Order entries
// and, since 16 Nov 2026, ARMED ORDERS (server/triggers.ts; see ARMED ORDERS
// below). It NEVER blocks an exit, an SL/TP, Exit All or a square-off: a guard
// that could trap him in a losing position would be worse than no guard. The
// Telegram auto-trader and his wife's account are separate systems with their
// own limits and are not touched.
//
// ARMED ORDERS (16 Nov 2026). An order armed at a level went to the broker
// through /api/orders WITHOUT journal:true, so nothing checked it: a fifth trade
// of the day, or one after the loss limit, could still be armed and would fire.
// Asked whether the guard should cover "Market, Limit/Trigger, and the armed
// orders you have today, which it does not check now", Martin chose "Yes, all
// entries". They are checked the way My Order is: the count and loss rules when
// the order is armed (the start time is not, because it may be armed at 9:40 to
// fire at 10:20), and every rule at the moment the level is reached. An armed
// order can also be an EXIT — a sell armed above a long he is holding — so it is
// checked only when it would OPEN a position: see isOpeningOrder.
//
// LOOSENING WAITS UNTIL TOMORROW: the moment a rule bites is exactly when it is
// tempting to switch it off. So a change that makes a rule stricter applies at
// once, and a change that relaxes it (later start → earlier, more trades, bigger
// loss limit, guard off) is saved and only takes effect the next trading day.
//
// COUNTING: "entries today" are today's filled orders on NFO/BFO from Kite's
// order book that OPENED or added to a position — a buy from flat or on top of a
// long, a sell from flat or on top of a short, and an order that turns a position
// over (see countEntries) — so trades placed in the Kite app count too, minus the
// ones the Telegram auto-trader placed. Until 16 Nov 2026 it was simply "filled
// BUY orders", which is the same thing for a trader who only ever buys options;
// the ScalpPro screen then put a one-tap Sell at Mkt on the phone, and a short
// opened with it was not an entry until it was bought back — so shorts opened
// side by side did not count at all. "Day P&L" is the whole account's, using the
// same formula as the positions banner: (sell value − buy value) + qty × LTP.

type GuardRules = { enabled: boolean; startTime: string; maxTrades: number; maxLoss: number };
type Stored = { active: GuardRules; pending: Partial<GuardRules> | null; pendingFrom: string | null };

export const GUARD_DEFAULTS: GuardRules = { enabled: true, startTime: '10:00', maxTrades: 4, maxLoss: 3000 };

const IST_MS = 5.5 * 3600 * 1000;
export const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMinutes = (ms: number) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function normaliseRules(r: any, base: GuardRules = GUARD_DEFAULTS): GuardRules {
  const o: any = { ...base, ...(r && typeof r === 'object' ? r : {}) };
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(o.startTime));
  let start = base.startTime;
  if (t) { const h = Math.min(15, Math.max(9, +t[1])), m = Math.min(59, Math.max(0, +t[2])); start = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }
  if (toMin(start) < toMin('09:15')) start = '09:15';
  return {
    enabled: !!o.enabled,
    startTime: start,
    maxTrades: Math.min(50, Math.max(1, Math.round(Number(o.maxTrades)) || base.maxTrades)),
    maxLoss: Math.min(1_000_000, Math.max(100, Math.round(Number(o.maxLoss)) || base.maxLoss)),
  };
}

// Split a requested change into what tightens (applies now) and what loosens
// (waits for the next trading day). Pure, so it is tested directly.
export function splitChange(active: GuardRules, want: GuardRules): { now: GuardRules; later: Partial<GuardRules> } {
  const now = { ...active }; const later: Partial<GuardRules> = {};
  if (want.enabled !== active.enabled) { if (want.enabled) now.enabled = true; else later.enabled = false; }
  if (want.startTime !== active.startTime) { if (toMin(want.startTime) > toMin(active.startTime)) now.startTime = want.startTime; else later.startTime = want.startTime; }
  if (want.maxTrades !== active.maxTrades) { if (want.maxTrades < active.maxTrades) now.maxTrades = want.maxTrades; else later.maxTrades = want.maxTrades; }
  if (want.maxLoss !== active.maxLoss) { if (want.maxLoss < active.maxLoss) now.maxLoss = want.maxLoss; else later.maxLoss = want.maxLoss; }
  return { now, later };
}

// The verdict for an entry right now. Pure.
export function verdict(rules: GuardRules, nowMs: number, entries: number | null, dayPnl: number | null, ignoreTime = false): string | null {
  if (!rules.enabled) return null;
  if (!ignoreTime && istMinutes(nowMs) < toMin(rules.startTime)) return `Your rule: no new trades before ${rules.startTime}. Exits are not affected.`;
  if (dayPnl !== null && dayPnl <= -rules.maxLoss) return `Your rule: day loss limit ₹${rules.maxLoss.toLocaleString('en-IN')} reached (today ₹${Math.round(dayPnl).toLocaleString('en-IN')}). No new trades today. Exits are not affected.`;
  if (entries !== null && entries >= rules.maxTrades) return `Your rule: ${rules.maxTrades} trades a day — already ${entries} today. Exits are not affected.`;
  return null;
}

type Deps = { db: any; getKiteClient: () => any };
let D: Deps | null = null;

function load(): Stored {
  const row: any = D!.db.prepare("SELECT value FROM trade_guard WHERE key = 'rules'").get();
  let s: Stored = { active: { ...GUARD_DEFAULTS }, pending: null, pendingFrom: null };
  if (row) { try { const j = JSON.parse(row.value); s = { active: normaliseRules(j.active), pending: j.pending || null, pendingFrom: j.pendingFrom || null }; } catch { } }
  // a relaxation saved yesterday (or earlier) becomes active today
  if (s.pending && s.pendingFrom && istDate(Date.now()) >= s.pendingFrom) {
    s = { active: normaliseRules({ ...s.active, ...s.pending }), pending: null, pendingFrom: null };
    save(s);
  }
  return s;
}
function save(s: Stored) {
  D!.db.prepare("INSERT INTO trade_guard (key, value) VALUES ('rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
}

function telegramOrderIds(day: string): Set<string> {
  try {
    const rows = D!.db.prepare(`SELECT t.order_id FROM signal_trades t LEFT JOIN signal_calls c ON c.id = t.call_id
      WHERE t.day = ? AND COALESCE(c.source, 'telegram') = 'telegram' AND t.order_id IS NOT NULL`).all(day) as any[];
    return new Set(rows.map(r => String(r.order_id)));
  } catch { return new Set(); }
}

// HOW MANY OF TODAY'S ORDERS OPENED A TRADE. Pure, so it is tested directly.
// Each contract's position is followed through the day, order by order in the
// order they FILLED, starting from what was carried in overnight:
//   • an order that takes the position away from flat, or further the way it
//     already stands, is an entry (so adding to a trade counts, as it always has);
//   • an order that only brings it back towards flat is an exit — never counted;
//   • an order bigger than the position it closes turns it over: an entry.
// Every filled order moves the position, the Telegram auto-trader's included —
// leave its buy out and its own exit would read as a short being opened — but
// its orders (`notHis`) are never counted. If the positions could not be read,
// every contract is taken to have started the day flat. If any fill has no time
// on it, the order book's own order (the order they were placed in) is used.
export function countEntries(orders: any[], net: any[] | null, notHis: Set<string> = new Set()): number {
  const pos = new Map<string, number>();
  for (const p of net || []) {
    const sym = String(p?.tradingsymbol || '').toUpperCase();
    const q = Number(p?.overnight_quantity) || 0;
    if (sym && q) pos.set(sym, (pos.get(sym) || 0) + q);
  }
  const when = (o: any): number | null => {
    const t = o?.exchange_update_timestamp ?? o?.exchange_timestamp ?? o?.order_timestamp;
    const ms = t instanceof Date ? t.getTime() : Date.parse(String(t ?? '').replace(' ', 'T'));
    return Number.isFinite(ms) ? ms : null;
  };
  const fills = (orders || []).map((o, i) => ({ o, i, t: when(o) }))
    .filter(x => (x.o?.exchange === 'NFO' || x.o?.exchange === 'BFO') && Number(x.o?.filled_quantity) > 0);
  if (fills.every(x => x.t !== null)) fills.sort((a, b) => (a.t! - b.t!) || (a.i - b.i));
  let n = 0;
  for (const { o } of fills) {
    const sym = String(o.tradingsymbol || '').toUpperCase();
    const sign = String(o.transaction_type).toUpperCase() === 'SELL' ? -1 : 1;
    const before = pos.get(sym) || 0;
    const after = before + sign * (Number(o.filled_quantity) || 0);
    pos.set(sym, after);
    const opens = before === 0 || Math.sign(before) === sign || Math.sign(after) === sign;
    if (opens && !notHis.has(String(o.order_id))) n++;
  }
  return n;
}

// WHAT IS LEFT OUT OF THE COUNT AND THE DAY'S P&L (27 Nov 2026). A Jodi
// (server/jodi.ts) is a strategy he switches on by hand, and asked, he chose
// "Ignore Trade Guard" for it: not stopped by these rules and not counted by
// them. So its two buys are not entries here (like the Telegram trader's), and
// the profit or loss in its two contracts is not part of the day's loss that
// stops his other trading. Handed in by server.ts; with nothing handed in,
// nothing is left out.
type Exempt = (day: string) => { orderIds: Set<string>; symbols: Set<string> };
let exemptFn: Exempt | null = null;
export function setGuardExempt(fn: Exempt | null) { exemptFn = fn; cache = null; }
const exemptFor = (day: string) => { try { return exemptFn ? exemptFn(day) : null; } catch { return null; } };

// net: the account's net positions as the broker returned them (null when they
// could not be read) — what tells an armed order that opens from one that exits.
type Measured = { entries: number | null; dayPnl: number | null; errors: string[]; net: any[] | null };
let cache: { at: number; v: Measured } | null = null;
// ONE BROKER READ FOR POLLS THAT ARRIVE TOGETHER (16 Nov 2026). The 5 s cache
// below is only filled AFTER both Kite calls return, so status polls that landed
// together on a cold cache each made their own orders + positions read — six
// polls, twelve broker calls. Martin's phone did exactly that (the shield
// refetched on every window focus) and the app raised its "high frequency"
// warning for /api/guard/status. Polls now wait for the read already in flight.
// An ENTRY CHECK (force) is deliberately left out of this: it must never be
// answered from a read that started before the order it is judging, so it
// always makes its own.
let polling: Promise<Measured> | null = null;
async function measure(force = false): Promise<Measured> {
  if (force) return readBroker();
  if (cache && Date.now() - cache.at < 5000) return cache.v;
  if (!polling) polling = readBroker().finally(() => { polling = null; });
  return polling;
}
async function readBroker(): Promise<Measured> {
  const errors: string[] = [];
  let entries: number | null = null, dayPnl: number | null = null, netRows: any[] | null = null;
  const kc = D!.getKiteClient();
  if (!kc || !kc.access_token) errors.push('Zerodha not logged in');
  else {
    const day = istDate(Date.now());
    // The positions are read FIRST now: counting the entries needs to know what
    // each contract started the day with (see countEntries).
    try {
      const pos = await kc.getPositions();
      const net: any[] = (pos && pos.net) || [];
      netRows = net;
      const skip = exemptFor(day)?.symbols;
      dayPnl = Math.round(net.reduce((s, p) => {
        if (skip && skip.has(String(p.tradingsymbol))) return s;                 // a Jodi's contracts: see WHAT IS LEFT OUT
        const bv = Number(p.buy_value), sv = Number(p.sell_value);
        const ltp = Number(p.last_price) || Number(p.average_price) || 0;
        return s + ((isFinite(bv) && isFinite(sv)) ? (sv - bv) + (Number(p.quantity) || 0) * ltp * (Number(p.multiplier) || 1) : Number(p.pnl) || 0);
      }, 0));
    } catch (e: any) { errors.push(`positions: ${e?.message || e}`); }
    try {
      const orders: any[] = await kc.getOrders();
      const notHis = telegramOrderIds(day);
      for (const id of exemptFor(day)?.orderIds || []) notHis.add(id);
      entries = countEntries(orders, netRows, notHis);
    } catch (e: any) { errors.push(`orders: ${e?.message || e}`); }
  }
  cache = { at: Date.now(), v: { entries, dayPnl, errors, net: netRows } };
  return cache.v;
}

// Test hook: lets a test start from a cold cache without waiting out the 5 s.
export const __test = { forgetCache() { cache = null; } };

export async function guardStatus(force = false) {
  const s = load();
  const m = await measure(force);
  const block = verdict(s.active, Date.now(), m.entries, m.dayPnl);
  return { rules: s.active, pending: s.pending, pendingFrom: s.pendingFrom, entriesToday: m.entries, dayPnl: m.dayPnl, blocked: !!block, reason: block, errors: m.errors };
}

// Called right before an OPENING order. Returns a reason to refuse, or null.
// If Kite cannot be read the time rule still applies; the count/loss rules are
// skipped rather than blocking him on a broker hiccup.
export async function guardEntryBlock(opts: { ignoreTime?: boolean } = {}): Promise<string | null> {
  try {
    const s = load();
    if (!s.active.enabled) return null;
    const m = await measure(true);
    return verdict(s.active, Date.now(), m.entries, m.dayPnl, !!opts.ignoreTime);
  } catch (e) { console.error('[guard] check failed — entry allowed', e); return null; }
}

// DOES THIS ORDER OPEN A POSITION, OR CLOSE ONE? Pure. `held` is the net
// quantity of that contract in the account now (+ long, − short), or null when
// the positions could not be read.
//   BUY  — opens, unless a short in that contract is held (then it buys it back).
//   SELL — closes a long that is held; with nothing held, or a short held, it
//          opens (or adds to) a short.
// When the positions are unknown a BUY is taken as opening and a SELL as
// closing: the one mistake this must never make is to stop him getting out.
export function isOpeningOrder(side: 'BUY' | 'SELL', held: number | null): boolean {
  if (side === 'BUY') return !(held !== null && held < 0);
  return held !== null && held <= 0;
}
export function heldQty(net: any[] | null, tradingsymbol: string): number | null {
  if (!net) return null;
  const sym = String(tradingsymbol || '').toUpperCase();
  return net.reduce((q, p) => q + (String(p?.tradingsymbol || '').toUpperCase() === sym ? (Number(p?.quantity) || 0) : 0), 0);
}

// Called for an order whose side alone does not say whether it is an entry —
// an armed order. Returns a reason to refuse, or null. An order that closes is
// never refused; one that opens gets exactly the entry check above.
export async function guardOrderBlock(o: { tradingsymbol: string; side: string }, opts: { ignoreTime?: boolean } = {}): Promise<string | null> {
  try {
    const s = load();
    if (!s.active.enabled) return null;
    const m = await measure(true);
    const side = String(o.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    if (!isOpeningOrder(side, heldQty(m.net, o.tradingsymbol))) return null;
    return verdict(s.active, Date.now(), m.entries, m.dayPnl, !!opts.ignoreTime);
  } catch (e) { console.error('[guard] check failed — order allowed', e); return null; }
}

export function registerTradeGuard(app: any, express: any, deps: Deps) {
  D = deps;
  D.db.exec('CREATE TABLE IF NOT EXISTS trade_guard (key TEXT PRIMARY KEY, value TEXT)');
  app.get('/api/guard/status', async (_req: any, res: any) => {
    try { res.json({ success: true, ...(await guardStatus()) }); }
    catch (e: any) { res.status(500).json({ success: false, error: e?.message || String(e) }); }
  });
  app.post('/api/guard/settings', express.json(), async (req: any, res: any) => {
    try {
      const s = load();
      const want = normaliseRules(req.body, s.active);
      const { now, later } = splitChange(s.active, want);
      // A new relaxation replaces any earlier pending one for the same field;
      // tightening a field also cancels a pending relaxation of that field.
      const pending: any = { ...(s.pending || {}) };
      for (const k of Object.keys(now) as (keyof GuardRules)[]) if (now[k] !== s.active[k]) delete pending[k];
      Object.assign(pending, later);
      for (const k of Object.keys(pending) as (keyof GuardRules)[]) if (pending[k] === now[k]) delete pending[k];
      const hasPending = Object.keys(pending).length > 0;
      const tomorrow = istDate(Date.now() + 86400000);
      save({ active: now, pending: hasPending ? pending : null, pendingFrom: hasPending ? tomorrow : null });
      cache = null;
      res.json({ success: true, ...(await guardStatus(true)),
        note: Object.keys(later).length ? 'Stricter changes apply now. Relaxed ones start tomorrow — that is the point of the guard.' : 'Saved.' });
    } catch (e: any) { res.status(500).json({ success: false, error: e?.message || String(e) }); }
  });
  console.log('[guard] trade guard registered');
}
