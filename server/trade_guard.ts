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
// ticket / Quick Trade (POST /api/orders with journal:true) and My Order
// entries. It NEVER blocks an exit, an SL/TP, Exit All or a square-off: a guard
// that could trap him in a losing position would be worse than no guard. The
// Telegram auto-trader and his wife's account are separate systems with their
// own limits and are not touched.
//
// LOOSENING WAITS UNTIL TOMORROW: the moment a rule bites is exactly when it is
// tempting to switch it off. So a change that makes a rule stricter applies at
// once, and a change that relaxes it (later start → earlier, more trades, bigger
// loss limit, guard off) is saved and only takes effect the next trading day.
//
// COUNTING: "entries today" are today's filled BUY orders on NFO/BFO from Kite's
// order book (so trades placed in the Kite app count too), minus the ones the
// Telegram auto-trader placed. "Day P&L" is the whole account's, using the same
// formula as the positions banner: (sell value − buy value) + qty × LTP.

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

let cache: { at: number; v: { entries: number | null; dayPnl: number | null; errors: string[] } } | null = null;
async function measure(force = false) {
  if (!force && cache && Date.now() - cache.at < 5000) return cache.v;
  const errors: string[] = [];
  let entries: number | null = null, dayPnl: number | null = null;
  const kc = D!.getKiteClient();
  if (!kc || !kc.access_token) errors.push('Zerodha not logged in');
  else {
    const day = istDate(Date.now());
    try {
      const orders: any[] = await kc.getOrders();
      const tg = telegramOrderIds(day);
      entries = orders.filter(o => o.transaction_type === 'BUY' && (o.exchange === 'NFO' || o.exchange === 'BFO')
        && Number(o.filled_quantity) > 0 && !tg.has(String(o.order_id))).length;
    } catch (e: any) { errors.push(`orders: ${e?.message || e}`); }
    try {
      const pos = await kc.getPositions();
      const net: any[] = (pos && pos.net) || [];
      dayPnl = Math.round(net.reduce((s, p) => {
        const bv = Number(p.buy_value), sv = Number(p.sell_value);
        const ltp = Number(p.last_price) || Number(p.average_price) || 0;
        return s + ((isFinite(bv) && isFinite(sv)) ? (sv - bv) + (Number(p.quantity) || 0) * ltp * (Number(p.multiplier) || 1) : Number(p.pnl) || 0);
      }, 0));
    } catch (e: any) { errors.push(`positions: ${e?.message || e}`); }
  }
  cache = { at: Date.now(), v: { entries, dayPnl, errors } };
  return cache.v;
}

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
