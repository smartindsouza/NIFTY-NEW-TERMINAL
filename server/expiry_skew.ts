// EXPIRY SKEW — live engine, PRACTICE ONLY (14 Nov 2026, Martin).
//
// The reading and the rule are in server/expiry_skew_calc.ts (a line-for-line
// port of the research code, checked against its output). This file only moves
// data: it keeps 60 trading days of the reading, computes today's every five
// minutes, and when the frozen rule fires it writes down a practice trade and its
// 3:15 PM result. NOTHING HERE CAN PLACE AN ORDER. It imports no order function,
// is handed none, and reads prices only. Martin asked for exactly that: the rule
// passed one out-of-sample test with real caveats (the test years were kind to
// trend-following; a tight stop kills it; profit comes in bursts), so it has to
// prove itself on days nobody has seen before any money goes on it.
//
// WHERE THE NUMBERS COME FROM, AND WHY TWO SOURCES.
//   History (the 60 days each reading is scored against): Dhan's expired-option
//   feed — the same files the backtest was built on, so the yardstick is the
//   tested yardstick. A day is loaded once, after it is over.
//   Today: Zerodha minute candles with open interest, for the 11 strikes each side
//   of the money. Zerodha is where the app is logged in during the session; Dhan's
//   feed is a history product. The candles are reshaped to look exactly like a
//   Dhan day (kiteToDay) so both sources go through one calculation.
//   At 3:50 PM today is also stored from Zerodha as tomorrow's newest history day,
//   and replaced by Dhan's version when that arrives — so a Dhan outage costs
//   nothing, and the long-run history is still Dhan's.
//
// TIMING. Bar b closes at minute (b + 1) * 5 after 09:15. A few seconds later the
// last minute's candles are out; the reading is computed and, on a signal, the
// practice entry is the option's live price at that moment plus a point of
// slippage. The backtest entered at the next minute's open; entering one, two or
// five minutes late made no measurable difference there, so a 10–20 second lag is
// inside what was tested. A signal bar that could not be computed within four
// minutes (app down, not logged in) is recorded as MISSED and not traded late:
// a trade the backtest would not have taken proves nothing about the backtest.

import express from 'express';
import { getKiteClient, getNfoInstruments, activeBroker } from './kite_service';
import { getLatestTick } from './ticker_service';
import { dhanRolling, dhanConfigured, dhanCall } from './dhan_service';
import { isTradingDay } from './calendar_service';
import {
  FIRST_BAR, LAST_BAR, EXIT_MINUTE, ITM_POINTS, THRESHOLD, WINDOW_DAYS, MIN_DAYS, STEP, SPAN, FEATS, SLIP_POINTS,
  DayBuilder, DayData, DayAgg, Ref, Reading, MinuteCandle, DhanLeg,
  addDhanLeg, kiteToDay, readingAt, readingsForDay, aggOf, refStats, scoreOf, signalSide, atmOf, practicePnl, weeklyExpiryFor,
} from './expiry_skew_calc';

/** Only `db` and `notify` are passed in production. The rest default to the real
 *  services and exist so the end-to-end test (expiry_skew.e2e.ts) can replay a
 *  recorded day through this exact code with its own clock, a stand-in for
 *  Zerodha and a stand-in for Dhan. */
export type SkewDeps = {
  db: any; notify: (text: string) => Promise<any> | void;
  now?: () => number;
  kite?: () => any | null;
  instruments?: () => Promise<any[]>;
  rolling?: (body: any) => Promise<any>;
  dhanReady?: () => boolean;
  tradingDay?: (d: string) => boolean;
  openDays?: () => Promise<string[]>;
  tick?: (token: number) => { ltp: number; ts: number } | undefined;
  paceMs?: number;
};
let D: SkewDeps;

// ---------------------------------------------------------------- time
const IST = 19800000, NIFTY_TOKEN = 256265;
const now = () => (D?.now ? D.now() : Date.now());
const istDay = (ms = now()) => new Date(ms + IST).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
/** Minutes after 09:15 IST, with fraction. */
const sessionMin = (ms = now()) => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 - 555; };
const kiteStamp = (ms: number) => new Date(ms + IST).toISOString().slice(0, 19).replace('T', ' ');
const minuteMs = (day: string, m: number) => Date.parse(`${day}T09:15:00+05:30`) + m * 60000;
/** 12-hour clock for a minute after 09:15 — Martin reads alerts as "2:55 PM". */
export const clock12 = (m: number) => { const t = 555 + Math.round(m), h = Math.floor(t / 60), mi = t % 60; return `${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const numOrNull = (v: number) => (v === v && Number.isFinite(v) ? v : null);
const kvGet = (k: string): string | null => { try { const r: any = D.db.prepare('SELECT value FROM skew_kv WHERE key = ?').get(k); return r ? String(r.value) : null; } catch { return null; } };
const kvSet = (k: string, v: string) => D.db.prepare('INSERT INTO skew_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

// ---------------------------------------------------------------- which days the market was open
// WHY THE HOLIDAY CALENDAR IS NOT ENOUGH. The first history load (v288) dated two
// weekly expiries on Tuesdays the market was shut — 20 Oct and 10 Nov 2026, when
// the contracts had really expired on the Monday — and asked Dhan for three
// holidays. The app's calendar comes from NSE's site, which refuses the server,
// so it had been running on a four-date fallback. A wrong expiry is not cosmetic
// here: the time to expiry goes straight into the implied volatility, and eight
// of 61 stored days came out with the wrong skew.
// So for the PAST the engine no longer asks a calendar what should have happened;
// it asks what did: one Dhan call returns NIFTY's daily candles, and a weekday
// with no candle was a holiday. The calendar (now carrying the full 2026 list) is
// used only for dates that have not happened yet. Stored once a day.
// The record ends at the last day that traded, so a holiday is only known for
// certain once a later day has traded; for the day or two in between the
// calendar still decides. If it gets that wrong, requeueWrongExpiries() below
// puts it right as soon as the record catches up.
let openCache: { from: string; to: string; set: Set<string>; fetchedDay: string } | null = null;
function openDays() {
  if (!openCache) { try { const raw = kvGet('open_days'); if (raw) { const o = JSON.parse(raw); openCache = { from: o.from, to: o.to, set: new Set<string>(o.days), fetchedDay: o.fetchedDay }; } } catch { } }
  return openCache;
}
async function dhanOpenDays(from: string, to: string): Promise<string[]> {
  const d = await dhanCall('POST', '/charts/historical', { securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', expiryCode: 0, oi: false, fromDate: from, toDate: to });
  // Daily candles are stamped at the day's start; six hours in is the same date whichever way the stamp leans.
  return ((d?.timestamp || []) as number[]).map(ts => istDay(Number(ts) * 1000 + 6 * 3600000));
}
async function refreshOpenDays(force = false) {
  const today = istDay(), cur = openDays();
  if (!force && cur && cur.fetchedDay === today) return;
  try {
    const got = D.openDays ? await D.openDays() : await dhanOpenDays(addDays(today, -170), today);
    // Never today: its candle may or may not exist yet, and today's own answer comes from the live feed.
    const list = [...new Set(got)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today).sort();
    if (list.length < 40) throw new Error(`only ${list.length} days came back`);
    kvSet('open_days', JSON.stringify({ from: list[0], to: list[list.length - 1], days: list, fetchedDay: today }));
    openCache = null; openDays();
  } catch (e: any) { console.error('[skew] trading-day list not refreshed:', e?.message || e); }
}
const calendarDay = (d: string) => (D?.tradingDay ? D.tradingDay(d) : isTradingDay(d));
/** Was / is the market open that day. Past: what happened. Future: the calendar. Weekends never (special sessions are not sessions this rule trades). */
const tradingDay = (d: string) => {
  const wd = new Date(d + 'T00:00:00Z').getUTCDay(); if (wd === 0 || wd === 6) return false;
  const o = D?.db ? openDays() : null;
  return o && d >= o.from && d <= o.to ? o.set.has(d) : calendarDay(d);
};
const nextTradingDay = (d: string) => { let x = d; for (let i = 0; i < 12; i++) { x = addDays(x, 1); if (tradingDay(x)) return x; } return x; };
const tdteOf = (day: string, expiry: string) => { let n = 0; for (let d = addDays(day, 1); d <= expiry; d = addDays(d, 1)) if (tradingDay(d)) n++; return n; };

// ---------------------------------------------------------------- settings
const enabled = () => kvGet('enabled') !== '0';

// ---------------------------------------------------------------- history (Dhan)
const OFFSETS = Array.from({ length: 21 }, (_, i) => { const k = i - 10; return k === 0 ? 'ATM' : `ATM${k > 0 ? '+' : '-'}${Math.abs(k)}`; });
const hist = { running: false, startedAt: 0, finishedAt: 0, total: 0, done: 0, current: '' as string, lastError: '' as string, calls: 0 };
let aggCache: { v: number; aggs: DayAgg[] } | null = null, histVersion = 0;

function histAggs(): DayAgg[] {
  if (aggCache && aggCache.v === histVersion) return aggCache.aggs;
  const rows: any[] = D.db.prepare(`SELECT h.day, h.skew, h.oi_imb30, h.oi_imb_day, h.vol_imb30 FROM skew_hist h
    JOIN skew_days d ON d.day = h.day AND d.status = 'ok' ORDER BY h.day, h.b`).all();
  const by = new Map<string, any[]>(); for (const r of rows) { let a = by.get(r.day); if (!a) { a = []; by.set(r.day, a); } a.push(r); }
  const aggs = [...by.entries()].map(([day, rs]) => aggOf(day, rs));
  aggCache = { v: histVersion, aggs }; return aggs;
}

function storeHistDay(day: string, expiry: string, rows: Reading[], src: 'dhan' | 'kite', expirySrc: 'zerodha' | 'rule' = src === 'kite' ? 'zerodha' : 'rule', note = '') {
  const ins = D.db.prepare('INSERT OR REPLACE INTO skew_hist (day, b, skew, oi_imb30, oi_imb_day, vol_imb30) VALUES (?,?,?,?,?,?)');
  const tx = D.db.transaction(() => {
    D.db.prepare('DELETE FROM skew_hist WHERE day = ?').run(day);
    for (const r of rows) ins.run(day, r.b, numOrNull(r.skew), numOrNull(r.oi_imb30), numOrNull(r.oi_imb_day), numOrNull(r.vol_imb30));
    D.db.prepare(`INSERT INTO skew_days (day, status, src, expiry, expiry_src, bars, fetched_at, note) VALUES (?, 'ok', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET status='ok', src=excluded.src, expiry=excluded.expiry, expiry_src=excluded.expiry_src, bars=excluded.bars, fetched_at=excluded.fetched_at, note=excluded.note`)
      .run(day, src, expiry, expirySrc, rows.filter(r => r.skew === r.skew).length, now(), note);
  });
  tx(); histVersion++;
}

/** The last WINDOW_DAYS (plus a small margin) trading days before today. */
function targetDays(today = istDay()): string[] {
  const out: string[] = []; let d = addDays(today, -1);
  for (let i = 0; i < 140 && out.length < WINDOW_DAYS + 4; i++, d = addDays(d, -1)) if (tradingDay(d)) out.push(d);
  return out.reverse();
}
function missingDays(): string[] {
  const have = new Map<string, any>((D.db.prepare('SELECT day, status, src, tried_at FROM skew_days').all() as any[]).map(r => [r.day, r]));
  // A day stored from Zerodha is good enough to score against, but Dhan's version
  // replaces it once it exists — the long-run history should be the tested feed.
  // Not every 20 minutes, though: a day Dhan has not published (or a holiday the
  // calendar missed) costs 42 calls per look, so it is asked for again only after
  // two hours.
  const due = (h: any) => !h.tried_at || now() - Number(h.tried_at) > 2 * 3600000;
  return targetDays().filter(d => { const h = have.get(d); return !h || ((h.status === 'pending' || (h.status === 'ok' && h.src === 'kite')) && due(h)); });
}

/** The expiry a past day's contract had. If that day was stored from Zerodha, the
 *  expiry written then came from the listed contracts and is the authority;
 *  otherwise the Tuesday rule on the days the market was really open. */
function expiryForPast(day: string): { expiry: string; src: 'zerodha' | 'rule' } {
  const kept: any = D.db.prepare("SELECT expiry FROM skew_days WHERE day = ? AND expiry_src = 'zerodha' AND expiry IS NOT NULL").get(day);
  return kept?.expiry ? { expiry: String(kept.expiry), src: 'zerodha' } : { expiry: weeklyExpiryFor(day, tradingDay), src: 'rule' };
}
/** A day stored with an expiry the Tuesday rule no longer agrees with — a holiday
 *  learnt after the fact — is put back in the queue. Only once the expiry date is
 *  itself in the past (inside the known record), so the answer cannot flip again. */
function requeueWrongExpiries() {
  const o = openDays(); if (!o) return 0; let n = 0;
  for (const r of D.db.prepare("SELECT day, expiry FROM skew_days WHERE status = 'ok' AND src = 'dhan' AND COALESCE(expiry_src, 'rule') = 'rule'").all() as any[]) {
    const want = weeklyExpiryFor(r.day, tradingDay);
    if (want <= o.to && r.expiry !== want) {
      D.db.prepare("UPDATE skew_days SET status = 'pending', tried_at = NULL, note = ? WHERE day = ?").run(`expiry was stored as ${r.expiry}, the contract expired ${want}`, r.day); n++;
    }
  }
  if (n) { histVersion++; console.log(`[skew] ${n} stored day(s) had the wrong expiry date and will be loaded again`); }
  return n;
}

/** Both days of a calendar pair (Dhan answers a one-day span with two days). */
async function dhanPair(first: string, wanted: Set<string>): Promise<Map<string, DayBuilder>> {
  const days = new Map<string, DayBuilder>();
  const expiryOf = (d: string) => expiryForPast(d).expiry;
  const call = D.rolling || dhanRolling;
  for (const side of ['CALL', 'PUT'] as const) {
    for (const off of OFFSETS) {
      const body = { exchangeSegment: 'NSE_FNO', interval: '1', securityId: 13, instrument: 'OPTIDX', expiryFlag: 'WEEK', expiryCode: 1,
        strike: off, drvOptionType: side, requiredData: ['open', 'high', 'low', 'close', 'iv', 'volume', 'oi', 'strike', 'spot'], fromDate: first, toDate: addDays(first, 1) };
      let resp: any = null, err: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { resp = await call(body); err = null; break; }
        catch (e: any) { err = e; if (e?.status === 400) break; await sleep(D.paceMs === 0 ? 0 : 1500 * (attempt + 1)); }
      }
      hist.calls++;
      if (err) throw new Error(`${first} ${side} ${off}: ${err?.message || err}`);
      const leg: DhanLeg | undefined = resp?.data?.[side === 'CALL' ? 'ce' : 'pe'];
      if (leg?.timestamp?.length) addDhanLeg(days, side === 'CALL' ? 'CE' : 'PE', leg, expiryOf, wanted);
    }
  }
  return days;
}
/** A day worth keeping as history: the index through the decision hours and
 *  enough strikes. A Dhan day carries 21 or more a side; a day rebuilt from
 *  Zerodha only the 11 around the money plus however far the index travelled. */
const dayLooksWhole = (d: DayData, minStrikes = 15) => {
  let spotMin = 0; for (let m = 45; m < 320; m++) if (d.spotClose[m] === d.spotClose[m]) spotMin++;
  return spotMin >= 260 && d.ce.size >= minStrikes && d.pe.size >= minStrikes;
};

async function runBackfill(reason: string) {
  if (hist.running) return;
  if (!(D.dhanReady ? D.dhanReady() : dhanConfigured())) { hist.lastError = 'Dhan is not set up, so the 60-day history cannot be loaded'; return; }
  hist.running = true;
  let todo: string[] = [];
  try { await refreshOpenDays(); requeueWrongExpiries(); todo = missingDays(); }
  catch (e: any) { hist.lastError = e?.message || String(e); }
  if (!todo.length) { hist.running = false; return; } hist.startedAt = now(); hist.total = todo.length; hist.done = 0; hist.lastError = ''; hist.calls = 0;
  console.log(`[skew] history load (${reason}): ${todo.length} day(s) ${todo[0]} … ${todo[todo.length - 1]}`);
  try {
    for (let i = 0; i < todo.length;) {
      const first = todo[i], second = todo[i + 1] === addDays(first, 1) ? todo[i + 1] : null;
      const wanted = new Set(second ? [first, second] : [first]); hist.current = first;
      let got: Map<string, DayBuilder>;
      try { got = await dhanPair(first, wanted); }
      catch (e: any) { hist.lastError = e?.message || String(e); console.error('[skew] history load stopped:', hist.lastError); break; }
      for (const day of wanted) {
        const b = got.get(day), data = b && b.rows > 0 ? b.finish() : null;
        if (data && dayLooksWhole(data)) {
          storeHistDay(day, data.expiry, readingsForDay(data), 'dhan', expiryForPast(day).src);
          gradeFromDayData(data);
        } else {
          // No rows: a holiday the calendar does not know, or a day Dhan has not
          // published yet. Only an OLD empty day is written off; a recent one is
          // asked for again, or yesterday would be lost to an early-morning load.
          const old = Date.parse(istDay() + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z') > 4 * 86400000;
          const kept: any = D.db.prepare("SELECT src FROM skew_days WHERE day = ? AND status = 'ok'").get(day);
          if (!kept) D.db.prepare(`INSERT INTO skew_days (day, status, src, fetched_at, note) VALUES (?, ?, 'dhan', ?, ?)
            ON CONFLICT(day) DO UPDATE SET status=excluded.status, fetched_at=excluded.fetched_at, note=excluded.note`)
            .run(day, old ? 'empty' : 'pending', now(), data ? 'incomplete day from Dhan' : 'no rows from Dhan');
        }
        D.db.prepare('UPDATE skew_days SET tried_at = ? WHERE day = ?').run(now(), day);
        hist.done++;
      }
      i += wanted.size;
    }
  } finally {
    hist.running = false; hist.finishedAt = now(); hist.current = '';
    console.log(`[skew] history load finished: ${hist.done}/${hist.total} day(s), ${hist.calls} calls${hist.lastError ? ', stopped on: ' + hist.lastError : ''}`);
  }
}

// ---------------------------------------------------------------- today (Zerodha)
type Contract = { token: number; tradingsymbol: string; lot: number };
type Chain = { expiry: string; by: Map<string, Contract> };
const dateStr = (d: any): string => d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
let chainCache: { day: string; forDay: string; chain: Chain } | null = null;

/** NIFTY option contracts of the nearest expiry on or after `day`, from Zerodha's
 *  contract file. Today's expiry is taken from here, never from the calendar rule:
 *  the contract file is what is actually listed. */
async function chainFor(day: string): Promise<Chain | null> {
  if (chainCache && chainCache.day === istDay() && chainCache.forDay === day) return chainCache.chain;
  const all = await (D.instruments ? D.instruments() : getNfoInstruments());
  const opts = (all || []).filter((i: any) => i.name === 'NIFTY' && (i.instrument_type === 'CE' || i.instrument_type === 'PE'));
  let expiry = ''; for (const i of opts) { const e = dateStr(i.expiry); if (e >= day && (!expiry || e < expiry)) expiry = e; }
  if (!expiry) return null;
  const by = new Map<string, Contract>();
  for (const i of opts) if (dateStr(i.expiry) === expiry) by.set(`${i.instrument_type}:${Number(i.strike)}`, { token: Number(i.instrument_token), tradingsymbol: String(i.tradingsymbol), lot: Number(i.lot_size) || 0 });
  const chain = { expiry, by }; chainCache = { day: istDay(), forDay: day, chain }; return chain;
}

function kite(): any | null {
  if (D.kite) return D.kite();
  if (activeBroker() !== 'kite') return null;                // today's candles need Zerodha's history API
  const kc: any = getKiteClient(); return kc && kc.access_token ? kc : null;
}
const tickOf = (token: number) => (D.tick ? D.tick(token) : getLatestTick(token));
const candleCache = new Map<string, { at: number; candles: MinuteCandle[] }>();
let lastKiteCall = 0;
/** Minute candles of one instrument for one day. Calls are spaced 400 ms apart:
 *  Zerodha allows three history requests a second and the charts use the same
 *  allowance — a burst here would show up as a chart that fails to load. */
async function candles(kc: any, token: number, day: string, withOi: boolean, maxAgeMs = 50000): Promise<MinuteCandle[]> {
  const key = `${token}:${day}`, hit = candleCache.get(key);
  if (hit && now() - hit.at >= 0 && now() - hit.at < maxAgeMs) return hit.candles;
  const pace = D.paceMs ?? 400, wait = lastKiteCall + pace - Date.now(); if (wait > 0) await sleep(wait);
  lastKiteCall = Date.now();
  const to = Math.min(now(), minuteMs(day, 385));
  const raw = await kc.getHistoricalData(token, 'minute', kiteStamp(minuteMs(day, 0)), kiteStamp(to), false, withOi);
  const out: MinuteCandle[] = (raw || []).map((c: any) => ({ t: new Date(c.date).getTime(), open: +c.open, close: +c.close, volume: +c.volume || 0, oi: c.oi === undefined || c.oi === null ? undefined : +c.oi }));
  candleCache.set(key, { at: now(), candles: out });
  if (candleCache.size > 400) for (const k of [...candleCache.keys()].slice(0, 200)) candleCache.delete(k);
  return out;
}

const live = { busy: false, lastCycleAt: 0, lastBarAt: 0, lastError: '', note: '', cycles: 0, errors: 0, trips: 0, pausedUntil: 0 };

/** One day rebuilt from Zerodha for the given bars. `failed` counts contracts
 *  whose candles could not be fetched — the caller decides whether to retry. */
async function dayFromKite(day: string, bars: number[], uptoMinute: number): Promise<{ data: DayData; chain: Chain; failed: number; legs: number } | null> {
  const kc = kite(); if (!kc) return null;
  const chain = await chainFor(day); if (!chain) return null;
  const index = await candles(kc, NIFTY_TOKEN, day, false, 4000);
  const closeAt = new Map<number, number>();
  for (const c of index) { const m = Math.round((c.t - minuteMs(day, 0)) / 60000); if (m >= 0 && m < 375) closeAt.set(m, c.close); }
  const strikes = new Set<number>();
  for (const b of bars) { const sp = closeAt.get((b + 1) * 5 - 1); if (sp === undefined || !(sp > 0)) continue; const K = atmOf(sp); for (let j = -SPAN; j <= SPAN; j++) strikes.add(K + STEP * j); }
  const legs: { side: 'CE' | 'PE'; strike: number; candles: MinuteCandle[] }[] = []; let failed = 0;
  for (const k of [...strikes].sort((a, b) => a - b)) for (const side of ['CE', 'PE'] as const) {
    const c = chain.by.get(`${side}:${k}`); if (!c) continue;
    try { legs.push({ side, strike: k, candles: await candles(kc, c.token, day, true) }); }
    catch (e: any) { failed++; live.lastError = `candles ${c.tradingsymbol}: ${e?.message || e}`; }
  }
  return { data: kiteToDay(day, chain.expiry, index, legs, uptoMinute), chain, failed, legs: legs.length };
}

function storeLive(day: string, r: Reading, ref: Ref | null, lateSec: number, src: string) {
  const s = scoreOf(r, ref);
  D.db.prepare(`INSERT OR REPLACE INTO skew_live (day, b, at, late_sec, spot, atm, skew, oi_imb30, oi_imb_day, vol_imb30, z_skew, z_oi_imb30, z_oi_imb_day, z_vol_imb30, flow, comp, hist_days, src)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(day, r.b, now(), Math.round(lateSec), numOrNull(r.spot), numOrNull(r.atm), numOrNull(r.skew), numOrNull(r.oi_imb30), numOrNull(r.oi_imb_day), numOrNull(r.vol_imb30),
      numOrNull(s.z_skew), numOrNull(s.z_oi_imb30), numOrNull(s.z_oi_imb_day), numOrNull(s.z_vol_imb30), numOrNull(s.flow), numOrNull(s.comp), ref ? ref.days : 0, src);
  return s;
}

async function ltpOf(kc: any, c: { token: number; tradingsymbol: string }): Promise<{ px: number; src: string } | null> {
  try { const q = await kc.getLTP([`NFO:${c.tradingsymbol}`]); const px = Number(q?.[`NFO:${c.tradingsymbol}`]?.last_price); if (px > 0) return { px, src: 'quote' }; } catch (e) { }
  const t = tickOf(Number(c.token)); if (t && t.ltp > 0 && now() - t.ts < 15000) return { px: t.ltp, src: 'tick' };
  return null;
}
const signed = (v: any) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;

/** The frozen rule on today's stored bars: the FIRST bar with |signal| ≥ 1.5. */
async function actOnSignal(day: string, chain: Chain) {
  if (D.db.prepare('SELECT 1 FROM skew_trades WHERE day = ?').get(day)) return;
  const rows: any[] = D.db.prepare('SELECT * FROM skew_live WHERE day = ? AND b BETWEEN ? AND ? ORDER BY b').all(day, FIRST_BAR, LAST_BAR);
  const first = rows.find(r => r.comp !== null && signalSide(r.comp) !== 0); if (!first) return;
  const side = signalSide(first.comp), decisionMin = (first.b + 1) * 5, lateSec = sessionMin() * 60 - decisionMin * 60;
  const base = { day, b: first.b, fired_at: now(), late_sec: Math.round(lateSec), side, comp: first.comp, z_skew: first.z_skew, flow: first.flow, expiry: chain.expiry, tdte: tdteOf(day, chain.expiry) };
  const put = (o: any) => {
    const r: any = { ...base, ...o, created_at: now(), updated_at: now() }, cols = Object.keys(r);
    D.db.prepare(`INSERT OR IGNORE INTO skew_trades (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => r[c]));
  };
  if (lateSec > 240) {
    put({ status: 'MISSED', note: `The ${clock12(decisionMin)} signal was computed ${Math.round(lateSec / 60)} min late (app not running or not logged in), so it was not traded.` });
    await D.notify(`🧪 PRACTICE — Expiry Skew: today's signal (${clock12(decisionMin)}, score ${signed(first.comp)}) was seen too late to count. Not traded.`);
    return;
  }
  const kc = kite(); if (!kc) return;
  // Strike from the index NOW (the backtest used the next minute's open), 200 points in the money.
  const tick = tickOf(NIFTY_TOKEN), spot = tick && tick.ltp > 0 && now() - tick.ts < 20000 ? tick.ltp : Number(first.spot);
  const strike = atmOf(spot) - side * ITM_POINTS, type = side > 0 ? 'CE' : 'PE', c = chain.by.get(`${type}:${strike}`);
  if (!c) { put({ status: 'NO_PRICE', spot, strike, option_type: type, note: 'That strike is not listed.' }); return; }
  const px = await ltpOf(kc, c);
  if (!px) { put({ status: 'NO_PRICE', spot, strike, option_type: type, tradingsymbol: c.tradingsymbol, token: c.token, lot: c.lot, note: 'No live price for the option at the signal.' }); return; }
  put({ status: 'OPEN', spot, strike, option_type: type, tradingsymbol: c.tradingsymbol, token: c.token, lot: c.lot, entry_px: px.px, entry_src: px.src });
  console.log(`[skew] PRACTICE signal ${day} bar ${first.b}: ${type} ${strike} @ ${px.px} (score ${Number(first.comp).toFixed(2)}) — no order placed`);
  await D.notify(`🧪 PRACTICE — Expiry Skew signal at ${clock12(decisionMin)}: score ${signed(first.comp)} (skew ${signed(first.z_skew)}, flow ${signed(first.flow)}).\n` +
    `Practice buy ${c.tradingsymbol} @ ₹${px.px.toFixed(2)}, 1 lot (${c.lot}), held to 3:15 PM, no stop.\nNo order placed — this rule is on test.`);
}

function closeTrade(t: any, exitPx: number, src: string) {
  const r = practicePnl(Number(t.entry_px), exitPx, Number(t.lot) || 65);
  const ch = D.db.prepare("UPDATE skew_trades SET status='CLOSED', exit_px=?, exit_src=?, exit_at=?, pts=?, fee=?, pnl=?, updated_at=? WHERE day=? AND status='OPEN'")
    .run(exitPx, src, now(), r.pts, r.fee, r.pnl, now(), t.day);
  if (ch.changes) void D.notify(`🧪 PRACTICE — Expiry Skew closed ${t.tradingsymbol} @ ₹${exitPx.toFixed(2)} (bought ₹${Number(t.entry_px).toFixed(2)}): ${r.pnl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(r.pnl)).toLocaleString('en-IN')} after charges and ${SLIP_POINTS} point slippage each way. No order was placed.`);
  return ch.changes;
}

/** 3:15 PM exit. Live price inside the first two minutes; after that the 3:15
 *  candle's open from Zerodha (the backtest's own definition), so a restart at
 *  3:14 PM still closes the trade at the right price. A trade left open after its
 *  contract has gone from Zerodha is closed from Dhan's file by the history loader. */
async function exitDue() {
  const open: any[] = D.db.prepare("SELECT * FROM skew_trades WHERE status = 'OPEN'").all(); if (!open.length) return;
  const today = istDay(), m = sessionMin(), kc = kite();
  for (const t of open) {
    if (t.day === today && m < EXIT_MINUTE) continue;
    if (!kc) continue;
    try {
      if (t.day === today && m < EXIT_MINUTE + 2) { const px = await ltpOf(kc, t); if (px) { closeTrade(t, px.px, px.src); continue; } }
      const cs = await candles(kc, Number(t.token), t.day, false, 20000), at = minuteMs(t.day, EXIT_MINUTE);
      const exact = cs.find(x => x.t === at);
      if (exact) { closeTrade(t, exact.open, 'candle 3:15 PM'); continue; }
      // No trade in the 3:15 minute: the last price before it, as the backtest
      // did — but only once that minute is certainly over.
      const before = [...cs].reverse().find(x => x.t < at);
      if (before && (t.day !== today || m >= EXIT_MINUTE + 3)) closeTrade(t, before.close, 'last price before 3:15 PM');
    } catch (e: any) { live.lastError = `exit ${t.tradingsymbol}: ${e?.message || e}`; }
  }
}
/** Dhan's (or Zerodha's end-of-day) file has every strike's minute opens. Used to
 *  write down the backtest's own entry and exit prices next to the live ones, and
 *  as the last resort for a trade still open on a past day. */
function gradeFromDayData(d: DayData) {
  const t: any = D.db.prepare("SELECT * FROM skew_trades WHERE day = ? AND status IN ('OPEN','CLOSED')").get(d.day); if (!t || !t.strike) return;
  const s = (t.option_type === 'CE' ? d.ce : d.pe).get(Number(t.strike)); if (!s) return;
  const eRef = s.o[(t.b + 1) * 5], xRef = s.o[EXIT_MINUTE];
  D.db.prepare('UPDATE skew_trades SET entry_ref = COALESCE(?, entry_ref), exit_ref = COALESCE(?, exit_ref), updated_at = ? WHERE day = ?').run(numOrNull(eRef), numOrNull(xRef), now(), d.day);
  if (t.status === 'OPEN' && xRef === xRef && d.day < istDay()) closeTrade(t, xRef, 'day file 3:15 PM');
}

async function liveCycle() {
  if (live.busy || !enabled()) return;
  const day = istDay(), m = sessionMin();
  if (!tradingDay(day) || now() < live.pausedUntil) return;
  live.busy = true; live.lastCycleAt = now(); live.cycles++;
  try {
    await exitDue();
    if (m < (FIRST_BAR + 1) * 5 + 0.1 || m > 372) return;
    const latest = Math.min(LAST_BAR, Math.floor(m / 5) - 1);
    const have = new Set<number>((D.db.prepare('SELECT b FROM skew_live WHERE day = ?').all(day) as any[]).map(r => r.b));
    const due: number[] = []; for (let b = FIRST_BAR; b <= latest; b++) if (!have.has(b)) due.push(b);
    if (!due.length) return;
    if (!kite()) { live.note = !D.kite && activeBroker() !== 'kite' ? 'Today\'s readings need Zerodha as the broker' : 'Zerodha is not logged in today'; return; }
    const sinceClose = (m - (latest + 1) * 5) * 60;
    if (due.length === 1 && sinceClose < 6) return;                       // give the last minute's candles a moment to land
    const got = await dayFromKite(day, due, (latest + 1) * 5 - 1);
    if (!got) { live.note = 'No NIFTY option contracts found in Zerodha\'s list'; return; }
    // The newest bar needs its last minute. Until 90 s after the close, wait for
    // it rather than store a reading with a hole in it.
    const lastM = (latest + 1) * 5 - 1, haveLast = got.data.spotClose[lastM] === got.data.spotClose[lastM];
    // Not one NIFTY candle since 09:15: the market is shut (a holiday the
    // calendar does not know). Storing 55 empty bars would put a day that never
    // happened on the page and in the log.
    let anySpot = false; for (let q = 0; q <= lastM && !anySpot; q++) anySpot = got.data.spotClose[q] === got.data.spotClose[q];
    if (!anySpot) { live.note = 'No NIFTY candles today — the market looks closed'; return; }
    if ((!haveLast || got.failed > 0) && due.includes(latest) && sinceClose < 90) { live.note = haveLast ? `${got.failed} contract(s) failed to load — retrying` : 'Waiting for the last minute\'s candle'; return; }
    const ref = refStats(histAggs(), day);
    for (const b of due) storeLive(day, readingAt(got.data, b), ref, (m - (b + 1) * 5) * 60, got.failed ? `kite, ${got.failed} missing` : 'kite');
    live.lastBarAt = now(); live.errors = 0; live.trips = 0; live.note = ref ? '' : `History has fewer than ${MIN_DAYS} days — readings are stored but cannot be scored yet`;
    if (ref) await actOnSignal(day, got.chain);
    // For the record: the entry minute's candle open (the backtest's entry price).
    const t: any = D.db.prepare("SELECT * FROM skew_trades WHERE day = ? AND status = 'OPEN' AND entry_ref IS NULL").get(day);
    if (t && m > (t.b + 1) * 5 + 1.2) {
      const kc = kite(); const cs = kc ? await candles(kc, Number(t.token), day, false, 20000) : [];
      const c = cs.find(x => x.t === minuteMs(day, (t.b + 1) * 5)); if (c) D.db.prepare('UPDATE skew_trades SET entry_ref = ? WHERE day = ?').run(c.open, day);
    }
  } catch (e: any) {
    live.lastError = e?.message || String(e); console.error('[skew] live cycle:', live.lastError);
    // A cycle runs every five seconds. Something that fails every time (Zerodha
    // refusing history calls, a contract list in an unexpected shape) would
    // otherwise be retried all day against the same three-a-second allowance the
    // charts depend on. Five failures in a row and it stands back: one minute the
    // first time — short enough that a signal on that bar is still inside the
    // four-minute limit when it comes back — and five minutes each time after,
    // until a bar is stored again.
    if (++live.errors >= 5) {
      const mins = live.trips === 0 ? 1 : 5; live.errors = 0; live.trips++; live.pausedUntil = now() + mins * 60000;
      live.note = `Paused for ${mins} minute${mins > 1 ? 's' : ''} after repeated errors: ${live.lastError}`;
    }
  }
  finally { live.busy = false; }
}

/** 3:50 PM: today, whole, from Zerodha — tomorrow's newest history day even if
 *  Dhan is late or down. Dhan's version replaces it when it arrives. */
async function storeTodayAsHistory(day = istDay()) {
  if (!tradingDay(day)) return { skipped: 'not a trading day' };
  const done: any = D.db.prepare("SELECT src FROM skew_days WHERE day = ? AND status = 'ok'").get(day); if (done) return { skipped: `already stored from ${done.src}` };
  const bars: number[] = []; for (let b = FIRST_BAR; b <= LAST_BAR; b++) bars.push(b);
  const got = await dayFromKite(day, bars, 374); if (!got) return { skipped: 'Zerodha not available' };
  if (got.failed || !dayLooksWhole(got.data, 11)) return { skipped: `incomplete (${got.failed} contracts failed, ${got.legs} loaded)` };
  storeHistDay(day, got.chain.expiry, readingsForDay(got.data), 'kite'); gradeFromDayData(got.data);
  return { stored: day, legs: got.legs };
}

// ---------------------------------------------------------------- what the page reads
const BACKTEST = {
  note: 'Per lot of 65, after charges and 1 point slippage each way, with the signal computed by the app\'s own formula.',
  test: { period: 'Nov 2020 – Nov 2022', label: 'Two years it had never seen', trades: 147, total: 154177, perTrade: 1049, winPct: 59, worst: -10754, drawdown: -51012 },
  fit: { period: 'Nov 2022 – Nov 2026', label: 'Four years it was fitted on', trades: 249, total: 248478, perTrade: 998, winPct: 53, worst: -13990, drawdown: -52179 },
  tradesPerYear: 66, avgWin: 4813, avgLoss: -3729, longestFlatDays: 516, tradesToJudge: 100,
  byYear: [{ y: 2021, pnl: 13927 }, { y: 2022, pnl: 150389 }, { y: 2023, pnl: 28021 }, { y: 2024, pnl: 120449 }, { y: 2025, pnl: -3551 }, { y: 2026, pnl: 80431 }],
};
const liveLtp = new Map<number, { at: number; px: number }>();

async function status() {
  const day = istDay(), m = sessionMin(), trading = tradingDay(day), session = trading ? day : nextTradingDay(day);
  const ref = refStats(histAggs(), session);
  const bars: any[] = D.db.prepare('SELECT b, at, late_sec, spot, atm, skew, oi_imb30, oi_imb_day, vol_imb30, z_skew, z_oi_imb30, z_oi_imb_day, z_vol_imb30, flow, comp, hist_days FROM skew_live WHERE day = ? ORDER BY b').all(day)
    .map((r: any) => ({ ...r, time: clock12((r.b + 1) * 5) }));
  const trades: any[] = D.db.prepare('SELECT * FROM skew_trades ORDER BY day DESC LIMIT 200').all().map((t: any) => ({ ...t, time: clock12((t.b + 1) * 5) }));
  const today = trades.find(t => t.day === day) || null;
  if (today?.status === 'OPEN' && trading && m >= 0 && m < 386) {
    const hit = liveLtp.get(today.token);
    if (!hit || now() - hit.at > 15000) { const kc = kite(); const px = kc ? await ltpOf(kc, today) : null; if (px) liveLtp.set(today.token, { at: now(), px: px.px }); }
    const px = liveLtp.get(today.token)?.px;
    if (px) { today.ltp = px; today.running = practicePnl(Number(today.entry_px), px, Number(today.lot) || 65).pnl; }
  }
  const closed = trades.filter(t => t.status === 'CLOSED' && t.pnl !== null).reverse();
  let eq = 0, peak = 0, dd = 0; for (const t of closed) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const wins = closed.filter(t => t.pnl > 0);
  // The listed contracts say when the next expiry is; the Tuesday rule is only the fallback (it is as good as the calendar behind it).
  let expiry: string | null = null; try { expiry = kite() ? (await chainFor(session))?.expiry || null : null; } catch { }
  if (!expiry) expiry = weeklyExpiryFor(session, tradingDay);
  const daysRow: any = D.db.prepare("SELECT COUNT(*) n, MIN(day) a, MAX(day) b, COALESCE(SUM(src = 'kite'), 0) k FROM skew_days WHERE status = 'ok'").get();
  const last = bars.length ? bars[bars.length - 1] : null;
  const state = !enabled() ? 'off' : !trading ? 'closed-day' : today?.status === 'OPEN' ? 'open' : today?.status === 'CLOSED' ? 'done-trade' : today ? 'no-trade'
    : !ref ? 'no-history' : m < (FIRST_BAR + 1) * 5 ? 'before' : m <= (LAST_BAR + 1) * 5 + 2 ? 'watching' : 'no-signal';
  return {
    ok: true, practiceOnly: true, enabled: enabled(), state, day, trading, minute: Math.floor(m), session,
    rule: { threshold: THRESHOLD, window: '10:00 AM – 2:30 PM', exit: '3:15 PM', itm: ITM_POINTS, slip: SLIP_POINTS, frozenOn: '2026-11-14' },
    expiry, tdte: tdteOf(session, expiry),
    latest: last, bars, today,
    history: { days: daysRow?.n || 0, from: daysRow?.a || null, to: daysRow?.b || null, fromZerodha: daysRow?.k || 0, usable: !!ref, refDays: ref?.days || 0, refFrom: ref?.from || null, refTo: ref?.to || null, needed: MIN_DAYS, window: WINDOW_DAYS,
      loading: hist.running, loaded: hist.done, toLoad: hist.total, current: hist.current, lastError: hist.lastError || null, dhan: D.dhanReady ? D.dhanReady() : dhanConfigured(),
      marketDaysKnown: openDays() ? { from: openDays()!.from, to: openDays()!.to, days: openDays()!.set.size } : null },
    live: { lastCycleAt: live.lastCycleAt || null, lastBarAt: live.lastBarAt || null, note: live.note || null, lastError: live.lastError || null, zerodha: !!kite(), pausedUntil: live.pausedUntil > now() ? live.pausedUntil : null },
    record: { closed: closed.length, total: Math.round(eq), perTrade: closed.length ? Math.round(eq / closed.length) : null, wins: wins.length, winPct: closed.length ? Math.round(100 * wins.length / closed.length) : null,
      worst: closed.length ? Math.round(Math.min(...closed.map(t => t.pnl))) : null, drawdown: Math.round(dd), missed: trades.filter(t => t.status === 'MISSED').length, noPrice: trades.filter(t => t.status === 'NO_PRICE').length, since: kvGet('started') },
    trades: trades.slice(0, 120), backtest: BACKTEST,
  };
}

// ---------------------------------------------------------------- wiring
/** Tables and dependencies only — no timers, no routes (the test stops here). */
export function initExpirySkew(deps: SkewDeps) {
  D = deps; aggCache = null; chainCache = null; openCache = null; candleCache.clear(); liveLtp.clear(); live.errors = 0; live.trips = 0; live.pausedUntil = 0; live.note = ''; live.lastError = '';
  D.db.exec(`
    CREATE TABLE IF NOT EXISTS skew_kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS skew_days (day TEXT PRIMARY KEY, status TEXT, src TEXT, expiry TEXT, bars INTEGER, fetched_at INTEGER, note TEXT, tried_at INTEGER);
    CREATE TABLE IF NOT EXISTS skew_hist (day TEXT, b INTEGER, skew REAL, oi_imb30 REAL, oi_imb_day REAL, vol_imb30 REAL, PRIMARY KEY (day, b));
    CREATE TABLE IF NOT EXISTS skew_live (day TEXT, b INTEGER, at INTEGER, late_sec INTEGER, spot REAL, atm REAL, skew REAL, oi_imb30 REAL, oi_imb_day REAL, vol_imb30 REAL,
      z_skew REAL, z_oi_imb30 REAL, z_oi_imb_day REAL, z_vol_imb30 REAL, flow REAL, comp REAL, hist_days INTEGER, src TEXT, PRIMARY KEY (day, b));
    CREATE TABLE IF NOT EXISTS skew_trades (day TEXT PRIMARY KEY, b INTEGER, fired_at INTEGER, late_sec INTEGER, side INTEGER, comp REAL, z_skew REAL, flow REAL,
      spot REAL, strike INTEGER, option_type TEXT, tradingsymbol TEXT, token INTEGER, lot INTEGER, expiry TEXT, tdte INTEGER,
      entry_px REAL, entry_src TEXT, entry_ref REAL, exit_px REAL, exit_src TEXT, exit_at INTEGER, exit_ref REAL, pts REAL, fee REAL, pnl REAL,
      status TEXT, note TEXT, created_at INTEGER, updated_at INTEGER);
  `);
  // v288 created skew_days without this column.
  try { D.db.exec('ALTER TABLE skew_days ADD COLUMN expiry_src TEXT'); } catch { }
  if (!kvGet('started')) kvSet('started', istDay());
}

export function registerExpirySkew(app: any, deps: SkewDeps) {
  initExpirySkew(deps);

  // Admin guard for the manual trigger: same key as the other research routes,
  // enforced only when it is set (the app has no login).
  const guard = (req: any, res: any, next: any) => {
    const key = process.env.GAP_ADMIN_KEY;
    if (!key || req.headers['x-admin-key'] === key || req.query.adminKey === key) return next();
    return res.status(403).json({ error: 'admin key required' });
  };

  // History: shortly after boot, then every 20 minutes while anything is missing.
  // It is a few minutes of spaced Dhan calls the first time and one day's worth
  // (about ten seconds) each morning after that.
  setTimeout(() => { void runBackfill('startup'); }, 25000);
  setInterval(() => { if (!hist.running && (missingDays().length || openDays()?.fetchedDay !== istDay())) void runBackfill('scheduled'); }, 20 * 60000);
  // Today: look every five seconds; a cycle only does work when a bar has closed.
  setInterval(() => { void liveCycle(); }, 5000);
  // 3:50 PM: keep today as history (from Zerodha) so tomorrow never starts a day short.
  setInterval(() => {
    const m = sessionMin(); if (m < 395 || m > 480 || !enabled()) return;
    const day = istDay(); if (!tradingDay(day) || D.db.prepare("SELECT 1 FROM skew_days WHERE day = ? AND status = 'ok'").get(day)) return;
    void storeTodayAsHistory(day).then(r => console.log('[skew] today as history:', JSON.stringify(r))).catch(e => console.error('[skew] today as history failed', e?.message || e));
  }, 5 * 60000);

  app.get('/api/skew/status', async (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await status()); } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });
  // On/off needs no PIN: nothing here can spend money, in either position.
  app.post('/api/skew/settings', express.json({ limit: '4kb' }), (req: any, res: any) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled must be true or false' });
    kvSet('enabled', req.body.enabled ? '1' : '0');
    console.log(`[skew] practice ${enabled() ? 'ON' : 'OFF'}`);
    res.json({ ok: true, enabled: enabled() });
  });
  // The stored numbers for one day — used to check the server against the research.
  app.get('/api/skew/day', (req: any, res: any) => {
    const day = String(req.query.day || istDay()); if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day=YYYY-MM-DD' });
    const ref = refStats(histAggs(), day);
    const h: any[] = D.db.prepare('SELECT b, skew, oi_imb30, oi_imb_day, vol_imb30 FROM skew_hist WHERE day = ? ORDER BY b').all(day);
    res.json({ ok: true, day, info: D.db.prepare('SELECT * FROM skew_days WHERE day = ?').get(day) || null, ref,
      hist: h.map(r => ({ ...r, ...scoreOf(r, ref) })), live: D.db.prepare('SELECT * FROM skew_live WHERE day = ? ORDER BY b').all(day) });
  });
  app.get('/api/skew/days', (_req: any, res: any) => { const o = openDays(); res.json({ ok: true, days: D.db.prepare('SELECT * FROM skew_days ORDER BY day').all(), missing: missingDays(), loader: hist,
    marketDays: o ? { from: o.from, to: o.to, fetchedDay: o.fetchedDay, days: [...o.set].sort() } : null }); });
  app.post('/api/skew/backfill', guard, (_req: any, res: any) => { if (hist.running) return res.json({ ok: true, started: false, running: true }); void runBackfill('manual'); res.json({ ok: true, started: true, missing: missingDays().length }); });
  // One past day built BOTH ways (Zerodha candles and Dhan's file) — the check that
  // the live path and the tested path give the same reading on a real day. Works
  // for days of a contract Zerodha still lists (the current expiry week).
  // Read-only, so it takes no key; but it costs about 80 spaced calls, so one at
  // a time and at most one a minute.
  let comparing = false, lastCompare = 0;
  app.get('/api/skew/compare', async (req: any, res: any) => {
    const day = String(req.query.day || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= istDay() || !tradingDay(day)) return res.status(400).json({ error: 'day=YYYY-MM-DD, a past trading day' });
    if (comparing || hist.running || Date.now() - lastCompare < 60000) return res.status(429).json({ error: 'busy — the history loader or another compare is running, or one ran in the last minute' });
    comparing = true; lastCompare = Date.now();
    try {
      const bars: number[] = []; for (let b = FIRST_BAR; b <= LAST_BAR; b++) bars.push(b);
      const k = await dayFromKite(day, bars, 374); if (!k) return res.status(503).json({ error: 'Zerodha is not logged in (or not the broker)' });
      const dm = await dhanPair(day, new Set([day])); const db_ = dm.get(day); if (!db_ || !db_.rows) return res.status(404).json({ error: 'Dhan has no rows for that day' });
      const dd = db_.finish(); const rk = readingsForDay(k.data), rd = readingsForDay(dd), ref = refStats(histAggs(), day);
      const diff: any = {}; let atmDiff = 0;
      rk.forEach((a, i) => { if (a.atm !== rd[i].atm) atmDiff++; for (const f of FEATS) { const x = (a as any)[f], y = (rd[i] as any)[f]; if (x === x && y === y) { const d = Math.abs(x - y); diff[f] = diff[f] || { max: 0, sum: 0, n: 0 }; diff[f].max = Math.max(diff[f].max, d); diff[f].sum += d; diff[f].n++; } else if ((x === x) !== (y === y)) diff[f + '_onlyOne'] = (diff[f + '_onlyOne'] || 0) + 1; } });
      for (const f of FEATS) if (diff[f]) diff[f] = { max: +diff[f].max.toFixed(5), mean: +(diff[f].sum / diff[f].n).toFixed(5), n: diff[f].n };
      let compMax = 0, compN = 0, verdictDiff = 0;
      const rows = rk.map((a, i) => { const ck = scoreOf(a, ref).comp, cd = scoreOf(rd[i], ref).comp; if (ck === ck && cd === cd) { compMax = Math.max(compMax, Math.abs(ck - cd)); compN++; if (signalSide(ck) !== signalSide(cd)) verdictDiff++; }
        return { b: a.b, time: clock12((a.b + 1) * 5), zerodha: { ...a, comp: numOrNull(ck) }, dhan: { ...rd[i], comp: numOrNull(cd) } }; });
      res.json({ ok: true, day, expiry: { zerodha: k.chain.expiry, calendarRule: dd.expiry }, contractsFromZerodha: k.legs, failed: k.failed, atmStrikeDiffers: atmDiff, diff,
        signal: { bars: compN, largestDifference: +compMax.toFixed(4), barsWhereVerdictDiffers: verdictDiff }, rows });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
    finally { comparing = false; }
  });
  console.log('[skew] Expiry Skew registered — PRACTICE ONLY: logs signals and practice trades, never places an order');
}

export const __test = { status, liveCycle, runBackfill, storeTodayAsHistory, targetDays, missingDays, histAggs, storeHistDay, exitDue, refreshOpenDays, tradingDay, live, hist };
