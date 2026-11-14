// Expiry Skew — the calculation against the research that it was ported from.
// Pure, no network.   npx tsx server/expiry_skew.test.ts
//
// The fixtures are real: fixtures/expiry_skew_day.json.gz is 9 Nov 2026 (a Monday
// expiry, because the 10th was a holiday) exactly as Dhan's expired-option feed
// returned it — 42 rolling series, 385 minutes each — with the readings, scores
// and the trade the Python research produced for that day. expiry_skew_hist.json.gz
// is the research's raw readings for the 62 trading days before it. If a number
// here stops matching, the app is no longer running the rule that was tested.
import assert from 'node:assert/strict';
import {
  pyRound, atmOf, ndtr, black, impliedVol, skewTime, kiteToDay, readingsForDay, readingAt, aggOf, refStats, scoreOf, signalSide,
  charges, practicePnl, weeklyExpiryFor, FEATS, MINUTES, FIRST_BAR, MinuteCandle,
} from './expiry_skew_calc';
import { FX, HIST, num, dhanLegs, vendorDay } from './fixtures/expiry_skew_fx';

let n = 0; const ok = (name: string, f: () => void) => { f(); n++; console.log('ok', name); };
const close = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

ok('ATM strike uses Python rounding: an exact half goes to the even strike', () => {
  assert.equal(pyRound(504.5), 504); assert.equal(pyRound(505.5), 506); assert.equal(pyRound(503.5), 504); assert.equal(pyRound(2.4999), 2);
  assert.equal(atmOf(25225), 25200); assert.equal(atmOf(25275), 25300); assert.equal(atmOf(25224.95), 25200); assert.equal(atmOf(25225.05), 25250);
});

ok('normal distribution matches reference values deep into the tail', () => {
  // scipy.special.ndtr
  for (const [x, v] of [[0, 0.5], [1, 0.8413447460685429], [-1, 0.15865525393145707], [-3, 0.0013498980316300946], [-4.2, 1.3345749015906309e-05], [-6, 9.865876450376946e-10], [2.5, 0.9937903346742238]] as [number, number][])
    assert.ok(Math.abs(ndtr(x) - v) <= 2e-13 * Math.max(v, 1e-3) + 1e-18, `ndtr(${x}) = ${ndtr(x)} vs ${v}`);
});

ok('implied volatility solves its own price back, calls and puts, hours from expiry', () => {
  const T = skewTime('2026-11-09', '2026-11-09', 196);            // 12:30 PM on expiry day
  close(T, 180 / (365 * 1440), 1e-15, 'minutes to 3:30 PM from the start of the 12:29 candle');
  for (const [K, v, call] of [[24800, 0.42, false], [25200, 0.31, true], [25000, 0.18, true]] as [number, number, boolean][]) {
    const F = 25010 * Math.exp(0.10 * T);
    close(impliedVol(black(F, K, T, v, call), F, K, T, call), v * 100, 1e-6, `IV K=${K}`);
  }
  assert.ok(Number.isNaN(impliedVol(0, 25000, 24800, T, false)), 'a price of zero has no volatility');
  assert.ok(Number.isNaN(impliedVol(5, 25000, 24800, 0, false)), 'no time left');
});

ok('weekly expiry for past days: Tuesday, or the trading day before when Tuesday is a holiday', () => {
  const hol = new Set(['2026-11-10', '2026-10-20']);
  const td = (d: string) => { const wd = new Date(d + 'T00:00:00Z').getUTCDay(); return wd !== 0 && wd !== 6 && !hol.has(d); };
  assert.equal(weeklyExpiryFor('2026-11-09', td), '2026-11-09');   // the fixture day: Monday expiry
  assert.equal(weeklyExpiryFor('2026-11-06', td), '2026-11-09');
  assert.equal(weeklyExpiryFor('2026-11-11', td), '2026-11-17');
  assert.equal(weeklyExpiryFor('2026-11-17', td), '2026-11-17');
  assert.equal(weeklyExpiryFor('2026-11-13', td), '2026-11-17');
  assert.equal(weeklyExpiryFor('2026-10-21', td), '2026-10-27');
  assert.equal(weeklyExpiryFor('2026-10-19', td), '2026-10-19');
  assert.equal(HIST.expiry['2026-11-06'], '2026-11-09'); assert.equal(FX.expiry, '2026-11-09');
  for (const d of HIST.days) assert.equal(weeklyExpiryFor(d, (x: string) => td(x) && (HIST.days.includes(x) || x > '2026-11-06')), HIST.expiry[d], `expiry of ${d}`);
});

ok('9 Nov 2026 from the vendor rows: every reading equals the research value (55 bars × 4)', () => {
  const rows = readingsForDay(vendorDay(FX, true));
  assert.equal(rows.length, 55); assert.deepEqual(rows.map(r => r.b), FX.bars);
  rows.forEach((r, i) => { for (const f of FEATS) { const e = num(FX.expect[f][i]), g = (r as any)[f]; assert.equal(e === e, g === g, `${f} bar ${r.b} present`); if (e === e) close(g, e, f === 'skew' ? 2e-5 : 2e-6, `${f} bar ${r.b}`); } });
});

ok('a reading never uses a later minute: garbling everything after the bar leaves it unchanged', () => {
  const a = vendorDay(FX, true), b = vendorDay(FX, true), bar = 38, m = (bar + 1) * 5;
  for (let q = m; q < MINUTES; q++) b.spotClose[q] = 99999;
  for (const leg of [b.ce, b.pe]) for (const s of leg.values()) { for (let q = m; q < MINUTES; q++) { s.c[q] = 1e6; s.o[q] = 1e6; } for (let q = bar + 1; q < 75; q++) { s.vol5[q] = 1e12; s.oi5[q] = 1e12; } }
  assert.deepEqual(readingAt(b, bar), readingAt(a, bar));
  assert.notDeepEqual(readingAt(b, bar + 1), readingAt(a, bar + 1));    // and the garbling does bite later
});

ok('Zerodha-style candles give the same day: gaps carried forward, strikes outside the vendor window dropped', () => {
  const per = new Map<string, MinuteCandle[]>();
  for (const l of dhanLegs(FX)) for (let i = 0; i < l.leg.timestamp.length; i++) {
    const key = `${l.side}:${l.leg.strike[i]}`; let a = per.get(key); if (!a) { a = []; per.set(key, a); }
    a.push({ t: l.leg.timestamp[i] * 1000, open: l.leg.open[i], close: l.leg.close[i], volume: l.leg.volume[i], oi: l.leg.oi[i] });
  }
  const t0 = FX.t0 * 1000, spot = FX.legs[0].spot as number[];
  const index: MinuteCandle[] = spot.map((s, i) => ({ t: t0 + i * 60000, open: s, close: s }));
  const legs = [...per.entries()].map(([key, cs]) => {
    const [side, k] = key.split(':'); const have = new Set(cs.map(c => c.t)); const all = [...cs];
    // Zerodha has a candle for every strike all day; the vendor only while it is within 10 strikes of the money.
    for (let i = 0; i < 375; i++) if (!have.has(t0 + i * 60000)) all.push({ t: t0 + i * 60000, open: 4321, close: 4321, volume: 999999, oi: 88888888 });
    return { side: side as 'CE' | 'PE', strike: Number(k), candles: all.sort((a, b) => a.t - b.t) };
  });
  const k = kiteToDay(FX.day, FX.expiry, index, legs); k.spotClose = Float64Array.from(FX.spotClose.map(num));
  const want = readingsForDay(vendorDay(FX, true)), got = readingsForDay(k);
  got.forEach((r, i) => { for (const f of FEATS) { const e = (want[i] as any)[f], g = (r as any)[f]; assert.equal(e === e, g === g, `${f} bar ${r.b}`); if (e === e) close(g, e, 1e-9, `${f} bar ${r.b}`); } });
});

ok('scores against the previous 60 days equal the research, and the first signal is 12:30 PM, put side', () => {
  const aggs = HIST.days.map((d: string) => aggOf(d, HIST.rows[d].map((r: number[]) => ({ skew: r[1], oi_imb30: r[2], oi_imb_day: r[3], vol_imb30: r[4] }))));
  const ref = refStats(aggs, FX.day)!;
  assert.equal(ref.days, 60); assert.equal(ref.to, '2026-11-06'); assert.equal(ref.from, HIST.days[2]);
  const rows = readingsForDay(vendorDay(FX, true)); let first: any = null;
  rows.forEach((r, i) => {
    const s = scoreOf(r, ref);
    for (const [k, tol] of [['z_skew', 1e-5], ['flow', 1e-5], ['comp', 1e-5]] as [keyof typeof s, number][]) { const e = num(FX.expect[k][i]); assert.equal(e === e, s[k] === s[k]); if (e === e) close(s[k], e, tol, `${k} bar ${r.b}`); }
    if (!first && signalSide(s.comp) !== 0) first = { b: r.b, side: signalSide(s.comp), comp: s.comp };
  });
  assert.equal(first.b, FX.trade.b); assert.equal(first.side, FX.trade.side); assert.equal(first.b, 38);
  assert.equal(refStats(aggs.slice(-19), FX.day), null, 'fewer than 20 days of history: no score');
  assert.equal(refStats(aggs, HIST.days[5]), null, 'only earlier days count');
  assert.ok(Number.isNaN(scoreOf({ skew: 3, oi_imb30: null, oi_imb_day: 0.1, vol_imb30: 0.1 }, ref).comp), 'one missing reading: no signal');
  assert.equal(signalSide(1.4999), 0); assert.equal(signalSide(1.5), 1); assert.equal(signalSide(-1.5), -1); assert.equal(signalSide(NaN), 0);
  assert.equal(scoreOf({ skew: 1e6, oi_imb30: 0, oi_imb_day: 0, vol_imb30: 0 }, ref).z_skew, 4, 'clipped at 4');
});

ok('the practice trade arithmetic reproduces the research P&L for that day to the paisa', () => {
  // research: entry = open + 1, exit = open at 3:15 PM − 1, charges on both values, lot 65
  const entryRaw = FX.trade.entry_with_slip - 1, exitRaw = FX.trade.entry_with_slip + FX.trade.pts + 1;
  const r = practicePnl(entryRaw, exitRaw, 65);
  close(r.pts, FX.trade.pts, 0.005, 'points'); close(r.pnl, FX.trade.pnl, 0.01, 'P&L');
  // charges on ₹14,560 bought and ₹4,946.50 sold, by hand: 40 + 7.42 + 6.93 + 0.02 + 0.44 + 18% of 46.95
  close(charges(14560, 4946.5), 40 + 0.0015 * 4946.5 + 0.0003553 * 19506.5 + 19506.5 * 10 / 1e7 + 0.00003 * 14560 + 0.18 * (40 + 0.0003553 * 19506.5 + 19506.5 * 10 / 1e7), 1e-9, 'charges');
  // and the strike and prices the research traded are in the vendor rows
  const d = vendorDay(FX, true), mEntry = (FX.trade.b + 1) * 5, strike = atmOf(num(FX.spotOpen[mEntry])) + 200;
  const leg = d.pe.get(strike)!; close(leg.o[mEntry], entryRaw, 1e-9, 'entry open'); close(leg.o[360], exitRaw, 1e-9, '3:15 PM open');
});

ok('first decision bar is 10:00 AM and needs the 09:30 open-interest bar', () => {
  assert.equal(FIRST_BAR, 8); const d = vendorDay(FX, true); const r = readingAt(d, 8);
  close(r.oi_imb30, r.oi_imb_day, 1e-12, 'at 10:00 AM the 30-minute and since-09:30 readings are the same number');
  assert.ok(Number.isNaN(readingAt(d, 5).skew), 'bars before the first lookback are not computed');
});

console.log(`\n${n} passed`);
