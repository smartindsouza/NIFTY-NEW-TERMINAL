// End-to-end replay of the Expiry Skew engine on a recorded day — no network.
//   npx tsx server/expiry_skew.e2e.ts
//
// 9 Nov 2026 is played through server/expiry_skew.ts minute by minute with its own
// clock, a stand-in for Zerodha that serves that day's candles (and deliberately
// poisons the minute still forming), and a stand-in for Dhan. The engine must end
// the day with the same signal, the same option and the same rupee result the
// Python research has for that day — and must do the sensible thing when it is
// started late, not logged in, switched off, or has no history.
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import Database from 'better-sqlite3';

// kite_service opens its database at import; keep it out of the working folder.
process.env.KITE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skew-e2e-'));
const { initExpirySkew, __test, clock12 } = await import('./expiry_skew');
const { readingsForDay, atmOf, practicePnl, FEATS } = await import('./expiry_skew_calc');
const { FX, HIST, num, dhanLegs, vendorDay } = await import('./fixtures/expiry_skew_fx');

let n = 0; const ok = (name: string) => { n++; console.log('ok', name); };
const DAY: string = FX.day, at = (hhmmss: string, day = DAY) => Date.parse(`${day}T${hhmmss}+05:30`);
const dayStart = at('09:15:00');
let T = at('09:00:00');                                        // the clock the engine sees

// ---------- the recorded day as Zerodha would serve it ----------
const vd = vendorDay(FX, true);
const strikesOf = (side: 'CE' | 'PE') => [...(side === 'CE' ? vd.ce : vd.pe).keys()].sort((a, b) => a - b);
const instruments: any[] = []; const byToken = new Map<number, { side: 'CE' | 'PE'; strike: number }>(), bySymbol = new Map<string, number>();
let tok = 500000;
for (const side of ['CE', 'PE'] as const) for (const k of strikesOf(side)) {
  const sym = `NIFTY26N09${k}${side}`; instruments.push({ name: 'NIFTY', instrument_type: side, strike: k, expiry: FX.expiry, instrument_token: ++tok, tradingsymbol: sym, lot_size: 65 });
  byToken.set(tok, { side, strike: k }); bySymbol.set(sym, tok);
}
// a later expiry must be ignored (nearest expiry only)
instruments.push({ name: 'NIFTY', instrument_type: 'CE', strike: 25000, expiry: '2026-11-17', instrument_token: 999001, tradingsymbol: 'NIFTY26N1725000CE', lot_size: 65 });
// per (side, strike): minute -> the vendor row (only while the strike was inside the vendor's window)
const rows = new Map<string, Map<number, { o: number; c: number; v: number; oi: number }>>();
for (const l of dhanLegs(FX)) for (let i = 0; i < l.leg.timestamp.length; i++) {
  const m = Math.round((l.leg.timestamp[i] * 1000 - dayStart) / 60000); if (m < 0 || m >= 375) continue;
  const key = `${l.side}:${l.leg.strike[i]}`; let mm = rows.get(key); if (!mm) { mm = new Map(); rows.set(key, mm); }
  if (!mm.has(m)) mm.set(m, { o: l.leg.open[i], c: l.leg.close[i], v: l.leg.volume[i], oi: l.leg.oi[i] });
}
let kiteUp = true, histCalls = 0, failToken = 0, kiteBroken = false;
const kc: any = {
  access_token: 'x',
  async getHistoricalData(token: number, interval: string, _from: string, to: string, _c: boolean, oi: boolean) {
    assert.equal(interval, 'minute'); histCalls++;
    if (kiteBroken) throw new Error('Too many requests');
    if (token === failToken) throw new Error('simulated candle failure');
    const toMs = Date.parse(to.replace(' ', 'T') + '+05:30'), out: any[] = [];
    if (_from.slice(0, 10) !== DAY) return out;                // any other day: the market was shut, no candles
    for (let m = 0; m < 375; m++) {
      const t = dayStart + m * 60000; if (t > toMs) break;
      const forming = toMs < t + 60000;                        // Zerodha returns the minute still printing — the engine must not use it
      if (token === 256265) { const o = num(FX.spotOpen[m]), c = num(FX.spotClose[m]); out.push({ date: new Date(t), open: forming ? 1 : o, high: 0, low: 0, close: forming ? 1 : c, volume: 0 }); continue; }
      const id = byToken.get(token)!, r = rows.get(`${id.side}:${id.strike}`)?.get(m); if (!r) continue;
      out.push({ date: new Date(t), open: forming ? 77777 : r.o, high: 0, low: 0, close: forming ? 77777 : r.c, volume: forming ? 1e9 : r.v, ...(oi ? { oi: forming ? 1 : r.oi } : {}) });
    }
    return out;
  },
  async getLTP(keys: string[]) {                               // live price = that minute's first trade
    const o: any = {}, m = Math.floor((T - dayStart) / 60000);
    for (const k of keys) { const id = byToken.get(bySymbol.get(k.split(':')[1])!); const r = id && rows.get(`${id.side}:${id.strike}`)?.get(m); if (r) o[k] = { last_price: r.o }; }
    return o;
  },
};
// ---------- Dhan stand-in: the recorded day, nothing for any other date ----------
const legOf = new Map(dhanLegs(FX).map(l => [`${l.side === 'CE' ? 'CALL' : 'PUT'}:${l.offset}`, l.leg]));
let dhanCalls = 0;
const rolling = async (body: any) => {
  dhanCalls++; assert.equal(body.expiryCode, 1); assert.equal(body.interval, '1');
  const leg = body.fromDate === DAY || body.toDate === DAY ? legOf.get(`${body.drvOptionType}:${body.strike}`) : null;
  return { data: { [body.drvOptionType === 'CALL' ? 'ce' : 'pe']: leg || { timestamp: [] } } };
};
// THE CALENDAR HERE KNOWS NO HOLIDAYS — every weekday is a trading day — because
// that is what the live app's calendar amounted to when this was written. What
// really traded comes from the daily-candle list (Dhan), as in production.
const tradingDay = (d: string) => { const wd = new Date(d + 'T00:00:00Z').getUTCDay(); return wd !== 0 && wd !== 6; };
const REAL_DAYS: string[] = [...HIST.days, DAY, '2026-11-11', '2026-11-12', '2026-11-13'];      // 14 Sep, 20 Oct and 10 Nov were holidays
let openDaysCalls = 0, openDaysDown = false;
const openDays = async () => { openDaysCalls++; if (openDaysDown) throw new Error('daily candles unavailable'); return REAL_DAYS; };
const notes: string[] = [];
const world = (db: any) => ({ db, notify: (t: string) => { notes.push(t); }, now: () => T, kite: () => (kiteUp ? kc : null), instruments: async () => instruments, rolling,
  dhanReady: () => true, tradingDay, openDays, tick: (token: number) => (token === 256265 ? { ltp: num(FX.spotOpen[Math.floor((T - dayStart) / 60000)]), ts: T } : undefined), paceMs: 0 });
const seedHistory = (days: string[] = HIST.days) => { for (const d of days) __test.storeHistDay(d, HIST.expiry[d], HIST.rows[d].map((r: number[]) => ({ b: r[0], spot: NaN, atm: NaN, skew: num(r[1]), oi_imb30: num(r[2]), oi_imb_day: num(r[3]), vol_imb30: num(r[4]) })), 'dhan'); };
const fresh = (): any => { const db = new Database(':memory:'); initExpirySkew(world(db)); notes.length = 0; kiteUp = true; failToken = 0; kiteBroken = false; openDaysDown = false; return db; };
const barTime = (b: number, sec = 8) => dayStart + (b + 1) * 5 * 60000 + sec * 1000;
// SKEW_DUMP_DIR=<folder> also writes what the page would be sent at three moments of the day (for looking at the page offline).
const dump = async (name: string) => { if (process.env.SKEW_DUMP_DIR) fs.writeFileSync(path.join(process.env.SKEW_DUMP_DIR, `status_${name}.json`), JSON.stringify(await __test.status())); };

// ================= 1) the whole day, bar by bar =================
{
  const db = fresh(); seedHistory();
  T = at('09:50:00'); await __test.liveCycle();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 0); ok('before 10:00 AM nothing is computed');

  T = barTime(8, 3); await __test.liveCycle();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 0); ok('3 seconds after the bar closes it waits for the candles to land');

  let worst = 0, firstSig: any = null;
  for (let b = 8; b <= 62; b++) {
    T = barTime(b); await __test.liveCycle();
    const r: any = db.prepare('SELECT * FROM skew_live WHERE day = ? AND b = ?').get(DAY, b); assert.ok(r, `bar ${b} stored`);
    const i = b - 8, e = num(FX.expect.comp[i]);
    assert.equal(r.comp !== null, e === e, `bar ${b} scored`); if (e === e) worst = Math.max(worst, Math.abs(r.comp - e));
    for (const f of FEATS) { const want = num(FX.expect[f][i]); if (want === want) assert.ok(Math.abs(r[f] - want) < (f === 'skew' ? 2e-4 : 2e-5), `${f} bar ${b}: ${r[f]} vs ${want}`); }
    assert.equal(r.hist_days, 60); assert.ok(r.late_sec >= 6 && r.late_sec <= 10);
    if (!firstSig && Math.abs(r.comp) >= 1.5) firstSig = { b, comp: r.comp };
    const trade: any = db.prepare('SELECT * FROM skew_trades WHERE day = ?').get(DAY);
    assert.equal(!!trade, b >= FX.trade.b, `trade exists only from the signal bar on (bar ${b})`);
    if (b === 20) await dump('watching'); if (b === 50) await dump('open');
  }
  assert.ok(worst < 1e-4, `signal within 0.0001 of the research on all 55 bars (worst ${worst})`);
  ok(`all 55 bars computed live through the Zerodha path; signal equals the research to ${worst.toExponential(1)}`);
  assert.equal(firstSig.b, 38); assert.equal(clock12((38 + 1) * 5), '12:30 PM');

  let t: any = db.prepare('SELECT * FROM skew_trades WHERE day = ?').get(DAY);
  const mE = (FX.trade.b + 1) * 5, strike = atmOf(num(FX.spotOpen[mE])) + 200, entryRaw = FX.trade.entry_with_slip - 1;
  assert.equal(t.status, 'OPEN'); assert.equal(t.b, 38); assert.equal(t.side, -1); assert.equal(t.option_type, 'PE'); assert.equal(t.strike, strike);
  assert.equal(t.tradingsymbol, `NIFTY26N09${strike}PE`); assert.equal(t.lot, 65); assert.equal(t.expiry, '2026-11-09'); assert.equal(t.tdte, 0);
  assert.equal(t.entry_px, entryRaw); assert.equal(t.entry_src, 'quote'); assert.equal(t.entry_ref, entryRaw, 'reference = the entry minute\'s candle open');
  ok(`12:30 PM signal → practice buy ${t.tradingsymbol} @ ${t.entry_px} (the research's own entry)`);
  assert.equal(notes.length, 1); assert.match(notes[0], /PRACTICE/); assert.match(notes[0], /12:30 PM/); assert.match(notes[0], /No order placed/); assert.match(notes[0], /NIFTY26N0925250PE|NIFTY26N09\d+PE/);
  ok('one alert, marked PRACTICE, 12-hour time, says no order was placed');

  let st: any = await __test.status();
  assert.equal(st.state, 'open'); assert.equal(st.today.status, 'OPEN'); assert.ok(typeof st.today.running === 'number'); assert.equal(st.practiceOnly, true); assert.equal(st.tdte, 0); assert.equal(st.expiry, '2026-11-09');
  ok('status shows the open practice trade with a running result');

  T = at('15:14:40'); await __test.liveCycle(); assert.equal(db.prepare('SELECT status FROM skew_trades WHERE day = ?').get(DAY).status, 'OPEN'); ok('still open at 3:14 PM');
  T = at('15:15:06'); await __test.liveCycle();
  t = db.prepare('SELECT * FROM skew_trades WHERE day = ?').get(DAY);
  const exitRaw = FX.trade.entry_with_slip + FX.trade.pts + 1;
  assert.equal(t.status, 'CLOSED'); assert.equal(t.exit_px, +exitRaw.toFixed(2)); assert.equal(t.exit_src, 'quote');
  assert.ok(Math.abs(t.pnl - FX.trade.pnl) < 0.011, `P&L ${t.pnl} vs research ${FX.trade.pnl}`); assert.ok(Math.abs(t.pts - FX.trade.pts) < 0.006);
  ok(`3:15 PM exit @ ${t.exit_px} → ₹${t.pnl} — the research figure for this day to the paisa`);
  assert.equal(notes.length, 2); assert.match(notes[1], /closed/); assert.match(notes[1], /−₹9,677/);
  T = at('15:20:00'); await __test.liveCycle(); assert.equal(notes.length, 2); ok('closed once: no second exit, no second alert');

  st = await __test.status();
  assert.equal(st.state, 'done-trade'); assert.deepEqual([st.record.closed, st.record.total, st.record.wins, st.record.missed], [1, -9677, 0, 0]); assert.equal(st.bars.length, 55);
  ok('status after the close: one closed practice trade in the record'); await dump('done');

  // 3:50 PM: today kept as history from Zerodha, then replaced by Dhan's version next morning
  T = at('15:50:00'); const r1 = await __test.storeTodayAsHistory(); assert.equal(r1.stored, DAY);
  assert.equal(db.prepare('SELECT src, status FROM skew_days WHERE day = ?').get(DAY).src, 'kite');
  const want = readingsForDay(vendorDay(FX, true)), got: any[] = db.prepare('SELECT * FROM skew_hist WHERE day = ? ORDER BY b').all(DAY);
  got.forEach((g, i) => { for (const f of FEATS) { const w = (want[i] as any)[f]; if (w === w) assert.ok(Math.abs(g[f] - w) < (f === 'skew' ? 2e-4 : 2e-5), `hist ${f} bar ${g.b}`); else assert.equal(g[f], null); } });
  ok('3:50 PM: the day is stored as history from Zerodha, equal to the vendor-path readings');
  T = at('08:30:00', '2026-11-11'); assert.ok(__test.missingDays().includes(DAY), 'a Zerodha-stored day is still wanted from Dhan');
  dhanCalls = 0; await __test.runBackfill('test');
  assert.equal(db.prepare('SELECT src FROM skew_days WHERE day = ?').get(DAY).src, 'dhan');
  t = db.prepare('SELECT * FROM skew_trades WHERE day = ?').get(DAY); assert.equal(t.exit_ref, +exitRaw.toFixed(2)); assert.equal(t.status, 'CLOSED'); assert.ok(Math.abs(t.pnl - FX.trade.pnl) < 0.011);
  ok(`next morning Dhan's file replaces it (${dhanCalls} calls) and stamps the backtest's own exit price on the trade`);
  const before = dhanCalls; await __test.runBackfill('again'); assert.equal(dhanCalls, before); ok('nothing is asked for twice');
}

// ================= 2) started late: the signal is recorded as MISSED, not traded =================
{
  const db = fresh(); seedHistory();
  T = at('12:50:08'); await __test.liveCycle();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live WHERE day = ?').get(DAY).c, 35, 'bars 8…42 caught up in one pass');
  const t: any = db.prepare('SELECT * FROM skew_trades WHERE day = ?').get(DAY);
  assert.equal(t.status, 'MISSED'); assert.equal(t.b, 38); assert.equal(t.entry_px, null); assert.match(t.note, /12:30 PM/); assert.match(notes[0], /too late/);
  for (let b = 43; b <= 62; b++) { T = barTime(b); await __test.liveCycle(); }
  T = at('15:15:10'); await __test.liveCycle();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_trades').get().c, 1); assert.equal(db.prepare('SELECT status FROM skew_trades').get().status, 'MISSED');
  const st: any = await __test.status(); assert.deepEqual([st.record.closed, st.record.missed, st.state], [0, 1, 'no-trade']);
  ok('app started at 12:50 PM: the 12:30 PM signal is logged as missed and no later bar is traded instead');
}

// ================= 3) a failed candle fetch is retried, then stored honestly =================
{
  const db = fresh(); seedHistory();
  failToken = bySymbol.get(`NIFTY26N09${atmOf(num(FX.spotClose[44]))}CE`)!;
  T = barTime(8); await __test.liveCycle(); assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 0, 'not stored while a retry is still possible');
  failToken = 0; T = barTime(8, 20); await __test.liveCycle();
  const r: any = db.prepare('SELECT * FROM skew_live WHERE b = 8').get(); assert.ok(r && Math.abs(r.comp - num(FX.expect.comp[0])) < 1e-4); assert.equal(r.src, 'kite');
  ok('one contract failing to load delays the bar instead of storing a reading with a hole in it');
}

// ================= 3b) Zerodha failing every call: stand back, then carry on =================
{
  const db = fresh(); seedHistory(); kiteBroken = true;
  T = barTime(8);
  for (let i = 0; i < 5; i++) { await __test.liveCycle(); T += 5000; }
  let calls = histCalls; assert.ok(__test.live.pausedUntil > T); assert.match(__test.live.note, /Paused for 1 minute/);
  for (let i = 0; i < 10; i++) { await __test.liveCycle(); T += 5000; }
  assert.equal(histCalls, calls, 'no calls during the one-minute pause');
  T = barTime(8, 100); for (let i = 0; i < 5; i++) { await __test.liveCycle(); T += 5000; }
  calls = histCalls; assert.match(__test.live.note, /Paused for 5 minutes/, 'still failing after the pause: five minutes this time');
  for (let i = 0; i < 40; i++) { await __test.liveCycle(); T += 5000; }
  assert.equal(histCalls, calls, 'no calls during the five-minute pause'); assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 0);
  kiteBroken = false; T = barTime(9, 200); await __test.liveCycle();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 2, 'bars 8 and 9 caught up once Zerodha answers again'); assert.equal((await __test.status()).live.pausedUntil, null);
  ok('repeated failures pause the engine (1 minute, then 5) instead of hammering Zerodha, and it catches up afterwards');

  // one bad burst must not cost the bar: back inside the four-minute limit, a signal is still traded
  const db2 = fresh(); seedHistory(); for (let b = 8; b <= 37; b++) { T = barTime(b); await __test.liveCycle(); }
  kiteBroken = true; T = barTime(38); for (let i = 0; i < 5; i++) { await __test.liveCycle(); T += 5000; }
  kiteBroken = false; T = barTime(38, 95); await __test.liveCycle();
  const t: any = db2.prepare('SELECT * FROM skew_trades WHERE day = ?').get(DAY); assert.equal(t.status, 'OPEN'); assert.equal(t.b, 38); assert.ok(t.late_sec > 90 && t.late_sec < 110);
  ok('a burst of errors exactly at the signal bar: the trade is still taken once the one-minute pause ends');
}

// ================= 4) no history, not logged in, switched off =================
{
  let db = fresh(); seedHistory(HIST.days.slice(-19));
  T = barTime(8); await __test.liveCycle();
  let r: any = db.prepare('SELECT * FROM skew_live WHERE b = 8').get(); assert.ok(r && r.comp === null && r.skew !== null); assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_trades').get().c, 0);
  assert.equal((await __test.status()).state, 'no-history'); ok('fewer than 20 days of history: readings are stored, nothing is scored or traded');

  db = fresh(); seedHistory(); kiteUp = false;
  T = barTime(8); await __test.liveCycle(); assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 0); assert.match(__test.live.note, /not logged in/);
  ok('Zerodha not logged in: nothing is stored and the reason is shown');

  db = fresh(); seedHistory(); db.prepare("INSERT INTO skew_kv (key, value) VALUES ('enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  T = barTime(8); const calls = histCalls; await __test.liveCycle(); assert.equal(histCalls, calls); assert.equal((await __test.status()).state, 'off'); ok('switched off: no calls at all');

  db = fresh(); seedHistory(); T = at('11:00:08', '2026-11-08'); await __test.liveCycle(); assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 0);
  const st: any = await __test.status(); assert.equal(st.state, 'closed-day'); assert.equal(st.session, '2026-11-09'); assert.equal(st.expiry, '2026-11-09'); assert.equal(st.history.usable, true);
  ok('on a Sunday it does nothing and the status points at Monday\'s session and expiry');
}

// ================= 5) the history loader on an empty database, with a calendar that knows no holidays =================
{
  const db = fresh(); T = at('08:00:00', '2026-11-12'); dhanCalls = 0;
  assert.equal(__test.tradingDay('2026-11-10'), true, 'before the record is loaded the calendar is all there is, and it is wrong about the 10th');
  await __test.refreshOpenDays();
  for (const h of ['2026-11-10', '2026-10-20', '2026-09-14']) assert.equal(__test.tradingDay(h), false, `${h} was a holiday: no daily candle`);
  assert.equal(__test.tradingDay('2026-11-09'), true); assert.equal(__test.tradingDay('2026-11-08'), false); assert.equal(__test.tradingDay('2026-11-17'), true, 'a date not yet in the record falls back to the calendar');
  const targets = __test.targetDays(); assert.equal(targets.length, 64); assert.equal(targets[targets.length - 1], '2026-11-11'); assert.ok(targets.includes(DAY));
  assert.ok(!targets.includes('2026-11-10') && !targets.includes('2026-10-20') && !targets.includes('2026-09-14'), 'holidays are not asked for');
  await __test.runBackfill('test');
  const days: any[] = db.prepare('SELECT * FROM skew_days ORDER BY day').all(), good = days.filter(d => d.status === 'ok');
  assert.equal(good.length, 1); assert.equal(good[0].day, DAY); assert.equal(good[0].expiry, '2026-11-09', 'Monday expiry, although the calendar thinks Tuesday the 10th was open'); assert.equal(good[0].expiry_src, 'rule');
  assert.equal(days.filter(d => d.status === 'empty').length, 62); assert.deepEqual(days.filter(d => d.status === 'pending').map(d => d.day), ['2026-11-11'], 'yesterday with no rows yet is kept for another look, not written off');
  assert.equal(dhanCalls % 42, 0);
  const want = readingsForDay(vendorDay(FX, false)), got: any[] = db.prepare('SELECT * FROM skew_hist WHERE day = ? ORDER BY b').all(DAY); assert.equal(got.length, 55);
  got.forEach((g, i) => { for (const f of FEATS) { const w = (want[i] as any)[f]; if (w === w) assert.ok(Math.abs(g[f] - w) < 1e-9); else assert.equal(g[f], null); } });
  ok(`history loader: ${dhanCalls} calls for 64 days; holidays are never asked for; the expiry is right without the calendar's help`);
  assert.deepEqual(__test.missingDays(), []); const calls = openDaysCalls, dc = dhanCalls; await __test.runBackfill('again'); assert.equal(openDaysCalls, calls); assert.equal(dhanCalls, dc);
  ok('…nothing is asked for again straight away, and the list of market days is fetched once a day');
  T += 3 * 3600000; assert.deepEqual(__test.missingDays(), ['2026-11-11']); ok('…but yesterday is asked for again two hours later');
}

// ================= 6) a day stored with the wrong expiry (what v288 did) is found and loaded again =================
{
  const db = fresh(); seedHistory(); T = at('08:00:00', '2026-11-12');
  // v288's mistake: the 9th stored as if its contract expired on the 10th, a holiday
  const wrong = vendorDay(FX, false); wrong.expiry = '2026-11-10';
  __test.storeHistDay(DAY, '2026-11-10', readingsForDay(wrong), 'dhan');
  db.prepare("UPDATE skew_days SET expiry_src = NULL WHERE day = ?").run(DAY);                    // as rows written before the column existed
  const bad: any[] = db.prepare('SELECT skew FROM skew_hist WHERE day = ? ORDER BY b').all(DAY), right = readingsForDay(vendorDay(FX, false));
  assert.ok(Math.abs(bad[30].skew - right[30].skew) > 0.5, 'a day more to expiry visibly changes the skew');
  dhanCalls = 0; await __test.runBackfill('test');
  const row: any = db.prepare('SELECT * FROM skew_days WHERE day = ?').get(DAY); assert.equal(row.status, 'ok'); assert.equal(row.expiry, '2026-11-09'); assert.equal(row.expiry_src, 'rule');
  const fixed: any[] = db.prepare('SELECT skew FROM skew_hist WHERE day = ? ORDER BY b').all(DAY); fixed.forEach((g, i) => { if (right[i].skew === right[i].skew) assert.ok(Math.abs(g.skew - right[i].skew) < 1e-9); });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM skew_days WHERE status = 'ok'").get().c, 63, 'the 62 days that were right are untouched');
  ok(`a stored day whose expiry fell on a holiday is reloaded with the real expiry (${dhanCalls} calls); correct days are left alone`);

  // the expiry Zerodha's contract list gave is never second-guessed by the rule
  __test.storeHistDay(DAY, '2026-11-09', right, 'kite'); db.prepare("UPDATE skew_days SET expiry = '2026-11-12' WHERE day = ?").run(DAY);   // pretend the listed contracts said the 12th
  T += 3 * 3600000; await __test.runBackfill('test');
  const z: any = db.prepare('SELECT * FROM skew_days WHERE day = ?').get(DAY); assert.equal(z.src, 'dhan'); assert.equal(z.expiry, '2026-11-12'); assert.equal(z.expiry_src, 'zerodha');
  T += 3 * 3600000; await __test.runBackfill('again'); assert.equal(db.prepare('SELECT status FROM skew_days WHERE day = ?').get(DAY).status, 'ok');
  ok('when Dhan replaces a day stored from Zerodha it keeps the expiry the listed contracts gave, and does not re-queue it');

  // Dhan's daily candles unavailable: carry on with the calendar rather than stop
  const db3 = fresh(); openDaysDown = true; T = at('08:00:00', '2026-11-12'); await __test.runBackfill('test');
  assert.ok(db3.prepare("SELECT COUNT(*) c FROM skew_days").get().c > 0); ok('if the list of market days cannot be fetched the loader still runs on the calendar');
}

// ================= 7) a holiday the calendar does not know: no candles, nothing stored =================
{
  const db = fresh(); seedHistory(); T = at('10:00:08', '2026-11-10');
  await __test.liveCycle(); T += 100000; await __test.liveCycle();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM skew_live').get().c, 0); assert.match(__test.live.note, /market looks closed/);
  T = at('15:55:00', '2026-11-10'); const r: any = await __test.storeTodayAsHistory('2026-11-10'); assert.ok(r.skipped);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM skew_days WHERE day = '2026-11-10'").get().c, 0);
  ok('on a holiday the calendar missed, an empty day is not written to the log or the history');
}

console.log(`\n${n} passed`);
