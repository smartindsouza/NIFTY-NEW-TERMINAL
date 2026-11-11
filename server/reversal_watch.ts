// REVERSAL WATCH (11 Nov 2026). Martin: "whenever an active trade card appears,
// start watching it" — and alert him when the market structure turns against the
// trade, so he can exit. ALERT ONLY: this never places, modifies or exits an
// order; his SL/TP engine keeps running exactly as before.
//
// HOW IT READS A REVERSAL
// For each open option position the trade's direction on the underlying is:
//   long CE / short PE → bullish trade;  long PE / short CE → bearish trade.
// Every 5 minutes, right after a 5-min candle closes, it reads today's 5-min
// candles of the underlying (NIFTY, and GIFT NIFTY alongside it for NIFTY
// options) and finds the last confirmed swing:
//   bullish trade → the last swing LOW (the last higher low);
//   bearish trade → the last swing HIGH (the last lower high).
// A completed 5-min candle CLOSING beyond that level — on NIFTY or on GIFT — is
// the reversal (change of character) and sends one push. A wick through does
// not count. Before the first swing of the day exists, the level is the range
// of the candles up to the entry. As the trade runs, new swings form and the
// level trails behind them by itself.
//
// Alerts go out through the same Telegram bot as the auto-trade alerts, times in
// 12-hour format (his request). One alert per level per position.
//
// STRUCTURE SL (11 Nov 2026, his rule, switchable): "the reversal triggers above
// 25,262 — put my SL there." When on, the underlying's swing level IS the trade's
// SL: a completed 5-min candle of the underlying (NIFTY / Bank Nifty / SENSEX —
// not GIFT, whose break stays an alert) CLOSING beyond it exits the whole
// position. The level only ever tightens as new swings form, and each move is
// announced. The option-premium SL/TP keep running as a backstop, and Telegram
// auto-trades (their own ladder) are never touched. A wick through does not exit.
//
// TIMEFRAME (11 Nov 2026, his choice of the two): the Structure SL reads 5-min or
// 15-min swings. Backtest the same evening — his 56 real entries: 5-min −489 pts,
// 15-min +1,442 (his actual exits −176); 2 years of momentum entries: 5-min +849,
// 15-min +3,325, positive in both years. 15-min is the default; the SL sits
// further away (typically ~30–60 NIFTY points), so each loss is bigger.

type C = { t: number; o: number; h: number; l: number; c: number };   // t = candle start, ms
export type Dir = 'bull' | 'bear';

const IST = 5.5 * 3600e3;
export const time12 = (ms: number) => {
  const d = new Date(ms + IST); let h = d.getUTCHours(); const m = d.getUTCMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
};
const fmt = (x: number) => Math.round(x).toLocaleString('en-IN');

export function tradeDir(tradingsymbol: string, qty: number): Dir | null {
  const m = /(CE|PE)$/i.exec(String(tradingsymbol || ''));
  if (!m || !qty) return null;
  const ce = m[1].toUpperCase() === 'CE';
  return (ce === qty > 0) ? 'bull' : 'bear';
}

// Swing points confirmed by `L` candles on each side.
export function swings(c: C[], L = 2) {
  const highs: { i: number; p: number }[] = [], lows: { i: number; p: number }[] = [];
  for (let k = L; k < c.length - L; k++) {
    let hi = true, lo = true;
    for (let j = k - L; j <= k + L; j++) {
      if (j === k) continue;
      if (c[j].h >= c[k].h) hi = false;
      if (c[j].l <= c[k].l) lo = false;
    }
    if (hi) highs.push({ i: k, p: c[k].h });
    if (lo) lows.push({ i: k, p: c[k].l });
  }
  return { highs, lows };
}

// The level a reversal must close beyond, using only candles BEFORE the last
// closed one (so the candle being judged cannot set its own level).
export function structureLevel(c: C[], dir: Dir, entryMs: number, L = 2): number | null {
  if (c.length < 2) return null;
  const prior = c.slice(0, -1);
  const sw = swings(prior, L);
  // Only a swing on the trade's side of price at entry counts. A CE bought at
  // 12:45 while NIFTY already sat below the morning's swing low must not be
  // "reversed" by that old level on its very first candle (seen replaying
  // 11 Nov). Reference = the last close at or before the entry.
  const atEntry = [...prior].reverse().find(x => x.t <= entryMs) || prior[0];
  const ref = atEntry.c;
  const pts = (dir === 'bull' ? sw.lows.filter(x => x.p < ref || prior[x.i].t > entryMs) : sw.highs.filter(x => x.p > ref || prior[x.i].t > entryMs));
  if (pts.length) return pts[pts.length - 1].p;
  const upto = prior.filter(x => x.t <= entryMs);
  const base = upto.length ? upto : prior.slice(0, 1);
  return dir === 'bull' ? Math.min(...base.map(x => x.l)) : Math.max(...base.map(x => x.h));
}

export function reversalHit(c: C[], dir: Dir, entryMs: number): { level: number; close: number; at: number } | null {
  const level = structureLevel(c, dir, entryMs);
  if (level === null) return null;
  const last = c[c.length - 1];
  if (last.t + 5 * 60000 <= entryMs) return null;          // a candle that closed before the trade began
  const hit = dir === 'bull' ? last.c < level : last.c > level;
  return hit ? { level, close: last.c, at: last.t } : null;
}

type Deps = {
  db?: any;
  exitPosition?: (sym: string, reason: string) => Promise<{ ok: boolean; error?: string; alreadyClosed?: boolean }>;
  isAutoTrade?: (sym: string) => boolean;
  getKiteClient: () => any;
  getGift: () => Promise<{ token: number } | null>;
  getBseIndexToken: (name: string) => Promise<number | null>;
  notify: (text: string) => Promise<any> | any;
};
type Watched = { sym: string; qty: number; dir: Dir; under: 'NIFTY' | 'BANKNIFTY' | 'SENSEX'; since: number; alerted: Set<string>; announced: boolean; slLevel: number | null; slOn: boolean; slTf: 5 | 15; exiting: boolean };
const watched = new Map<string, Watched>();
let lastCandleCheck = 0;
let lastStatus: any = { running: false, watching: [] };

const istParts = (ms: number) => { const d = new Date(ms + IST); return { day: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), date: d.toISOString().slice(0, 10) }; };
const kiteTime = (ms: number) => { const d = new Date(ms + IST); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`; };
function underlyingOf(sym: string): Watched['under'] | null {
  if (/^BANKNIFTY/i.test(sym)) return 'BANKNIFTY';
  if (/^NIFTY/i.test(sym)) return 'NIFTY';
  if (/^SENSEX/i.test(sym)) return 'SENSEX';
  return null;
}

async function candlesToday(kc: any, token: number, now: number, tf: 5 | 15 = 5): Promise<C[]> {
  const { date } = istParts(now);
  const open = Date.parse(`${date}T09:15:00+05:30`);
  const raw: any[] = (await kc.getHistoricalData(token, tf === 15 ? '15minute' : '5minute', kiteTime(open), kiteTime(now))) || [];
  return raw.map(r => ({ t: new Date(r.date).getTime(), o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
    .filter(x => x.t >= open && x.t + tf * 60000 <= now);                 // completed candles only
}

async function tick(D: Deps) {
  const now = Date.now();
  const { day, mins } = istParts(now);
  if (day === 0 || day === 6 || mins < 9 * 60 + 15 || mins > 15 * 60 + 35) { lastStatus = { running: true, market: 'closed', structureSl: lastSetting, timeframe: lastTf, watching: [] }; return; }
  const kc = D.getKiteClient();
  if (!kc || !kc.access_token) { lastStatus = { running: true, error: 'Zerodha not logged in', structureSl: lastSetting, timeframe: lastTf, watching: [] }; return; }

  // 1) Which positions are open — the same ones the active trade card shows.
  const pos: any[] = ((await kc.getPositions())?.net || []).filter((p: any) => Number(p.quantity) !== 0 && (p.exchange === 'NFO' || p.exchange === 'BFO'));
  const live = new Set<string>();
  for (const p of pos) {
    const sym = String(p.tradingsymbol), qty = Number(p.quantity);
    const dir = tradeDir(sym, qty), under = underlyingOf(sym);
    if (!dir || !under) continue;
    const key = `${sym}|${dir}`;
    live.add(key);
    if (!watched.has(key)) watched.set(key, { sym, qty, dir, under, since: now, alerted: new Set(), announced: false, slLevel: null, slOn: structureSlEnabled(D) && !(D.isAutoTrade?.(sym)), slTf: lastTf, exiting: false });
    else watched.get(key)!.qty = qty;
  }
  for (const k of [...watched.keys()]) if (!live.has(k)) watched.delete(k);   // closed → stop watching

  // 2) Structure check once per closed 5-min candle (a few seconds after it closes),
  //    and straight away for a position seen for the first time.
  const slot = Math.floor(now / 300000);
  const fresh = [...watched.values()].some(w => !w.announced);
  if (!fresh && (slot === lastCandleCheck || (now % 300000) < 8000)) { publish(); return; }
  lastCandleCheck = slot;

  const tokens: Record<string, number | null> = { NIFTY: 256265, BANKNIFTY: 260105, SENSEX: null };
  if ([...watched.values()].some(w => w.under === 'SENSEX')) tokens.SENSEX = await D.getBseIndexToken('SENSEX').catch(() => null);
  const gift = [...watched.values()].some(w => w.under === 'NIFTY') ? await D.getGift().catch(() => null) : null;
  const cache = new Map<string, C[]>();
  const get = async (t: number, tf: 5 | 15 = 5) => { const k = `${t}|${tf}`; if (!cache.has(k)) cache.set(k, await candlesToday(kc, t, now, tf).catch(() => [])); return cache.get(k)!; };

  for (const w of watched.values()) {
    const charts: { name: string; c: C[] }[] = [];
    const ut = tokens[w.under];
    // The underlying's own chart: on the Structure SL's timeframe when that is on
    // (5 or 15 min), else 5-min like the alerts. GIFT stays on 5-min alerts.
    const mainTf: 5 | 15 = w.slOn ? w.slTf : 5;
    if (ut) charts.push({ name: w.under === 'NIFTY' ? 'NIFTY' : w.under === 'BANKNIFTY' ? 'BANK NIFTY' : 'SENSEX', c: await get(ut, mainTf) });
    if (w.under === 'NIFTY' && gift?.token) charts.push({ name: 'GIFT NIFTY', c: await get(gift.token) });
    const against = w.dir === 'bull' ? 'below' : 'above';

    // Structure SL: tighten the level from the underlying's own chart, then check
    // the candle that just closed against it.
    const main = charts[0];
    if (w.slOn && main && main.c.length >= 2 && !w.exiting) {
      const nl = structureLevel(main.c, w.dir, w.since);
      if (nl !== null) {
        const tighter = w.slLevel === null || (w.dir === 'bull' ? nl > w.slLevel : nl < w.slLevel);
        if (tighter) {
          const was = w.slLevel; w.slLevel = nl;
          if (was !== null && Math.abs(nl - was) >= 5) await D.notify(`🔁 Structure SL for ${w.sym} moved ${fmt(was)} → ${fmt(nl)} (new swing ${w.dir === 'bull' ? 'low' : 'high'} on ${main.name}). Exits if a ${w.slTf}-min candle closes ${against} it.`);
        }
      }
      const last = main.c[main.c.length - 1];
      if (w.slLevel !== null && last.t + w.slTf * 60000 > w.since && (w.dir === 'bull' ? last.c < w.slLevel : last.c > w.slLevel)) {
        w.exiting = true;
        const r = D.exitPosition ? await D.exitPosition(w.sym, 'STRUCTURE_SL') : { ok: false, error: 'exit not wired' };
        await D.notify(r.ok
          ? `🛑 Structure SL hit — sold ${w.sym}. ${main.name} ${w.slTf}-min candle ${time12(last.t)}–${time12(last.t + w.slTf * 60000)} closed ${fmt(last.c)}, ${against} the SL level ${fmt(w.slLevel)}.`
          : r.alreadyClosed ? `Structure SL for ${w.sym}: position already closed.`
          : `❗ Structure SL hit on ${w.sym} (${main.name} closed ${fmt(last.c)} ${against} ${fmt(w.slLevel)}) but the exit FAILED: ${r.error}. Exit it yourself now.`);
        if (!r.ok && !r.alreadyClosed) w.exiting = false;
        continue;
      }
    }

    if (!w.announced) {
      const lv = charts.filter(ch => !(w.slOn && ch === main)).map(ch => { const l = structureLevel([...ch.c, ch.c[ch.c.length - 1] || { t: now, o: 0, h: 0, l: 0, c: 0 }], w.dir, now); return l !== null ? `${ch.name} ${fmt(l)}` : null; }).filter(Boolean);
      const slNote = w.slOn
        ? (w.slLevel !== null ? ` Structure SL ON: the position is SOLD if a ${charts[0]?.name} ${w.slTf}-min candle closes ${against} ${fmt(w.slLevel)} (trails as new swings form; your option SL stays as a backstop).` : ' Structure SL ON — level set once the chart has enough candles.')
        : ' Alert only — your SL/TP are unchanged.';
      await D.notify(`👀 Watching ${w.sym} (${w.dir === 'bull' ? 'bullish' : 'bearish'} trade). ${lv.length ? `Reversal alert if a 5-min candle closes ${against} the last swing ${w.dir === 'bull' ? 'low' : 'high'}: ${lv.join(', ')}.` : ''}${slNote}`);
      w.announced = true;
    }
    for (const ch of charts) {
      if (w.slOn && ch === main) continue;            // the Structure SL above handles (and exits on) this chart
      const hit = reversalHit(ch.c, w.dir, w.since);
      if (!hit) continue;
      const k = `${ch.name}|${hit.level}`;
      if (w.alerted.has(k)) continue;
      w.alerted.add(k);
      await D.notify(`⚠️ REVERSAL vs your ${w.sym}: ${ch.name} 5-min candle ${time12(hit.at)}–${time12(hit.at + 300000)} closed ${fmt(hit.close)}, ${against} its last swing ${w.dir === 'bull' ? 'low' : 'high'} ${fmt(hit.level)}. Structure has turned against the trade — consider exiting. (Alert only; nothing was sold.)`);
    }
  }
  publish();
}

function publish() {
  lastStatus = { running: true, at: Date.now(), structureSl: lastSetting, timeframe: lastTf, watching: [...watched.values()].map(w => ({ sym: w.sym, dir: w.dir, under: w.under, since: w.since, alerts: [...w.alerted], structureSl: w.slOn, slTf: w.slTf, slLevel: w.slLevel })) };
}

let lastSetting = true;
let lastTf: 5 | 15 = 15;
function structureSlEnabled(D: Deps): boolean {
  try {
    const r: any = D.db?.prepare("SELECT value FROM reversal_watch_kv WHERE key = 'structure_sl'").get();
    lastSetting = r ? r.value === '1' : true;        // on by default — he asked for it
    const t: any = D.db?.prepare("SELECT value FROM reversal_watch_kv WHERE key = 'structure_sl_tf'").get();
    lastTf = t && t.value === '5' ? 5 : 15;          // 15-min by default (backtest above)
  } catch { }
  return lastSetting;
}

export function registerReversalWatch(app: any, express: any, deps: Deps) {
  let busy = false;
  try { deps.db?.exec('CREATE TABLE IF NOT EXISTS reversal_watch_kv (key TEXT PRIMARY KEY, value TEXT)'); } catch { }
  structureSlEnabled(deps);
  app.post('/api/reversal-watch/settings', express.json(), (req: any, res: any) => {
    try {
      const up = (k: string, v: string) => deps.db.prepare("INSERT INTO reversal_watch_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
      if (req.body?.structureSl !== undefined) { lastSetting = !!req.body.structureSl; up('structure_sl', lastSetting ? '1' : '0'); }
      if (req.body?.timeframe !== undefined) { lastTf = Number(req.body.timeframe) === 5 ? 5 : 15; up('structure_sl_tf', String(lastTf)); }
      // applies to positions opened from now on; ones already watched keep what they started with
      res.json({ success: true, structureSl: lastSetting, timeframe: lastTf });
    } catch (e: any) { res.status(500).json({ success: false, error: e?.message || String(e) }); }
  });
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await tick(deps); } catch (e: any) { lastStatus = { ...lastStatus, error: e?.message || String(e) }; }
    finally { busy = false; }
  }, 30000);
  app.get('/api/reversal-watch/status', (_req: any, res: any) => res.json({ ...lastStatus, structureSl: lastSetting, timeframe: lastTf }));
  console.log('[reversal-watch] registered (alert only)');
}

export const __test = { tick, watched, reset() { watched.clear(); lastCandleCheck = 0; } };
