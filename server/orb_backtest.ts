// Opening Range Breakout — pre-registered backtest + fake-breakout variants.
//
// PRIMARY (pre-registered 2026-07-22, the ONE strategy facing the bar):
//   OR = first three 5-min candles (09:15-09:30) high/low. Enter on the FIRST
//   5-min close beyond the range between 09:30-11:00, in the break direction.
//   Stop = range midpoint. Target = entry ± 2R (R = |entry − midpoint|).
//   Force-exit on the close of the first candle from 15:00. Costs 3 pts.
//   One trade/day. Conservative fills: stop first when both touch in a candle.
//   BAR (set before looking): n ≥ 60, positive after costs, walk-forward test
//   half positive, max drawdown < one year's profit.
//
// EXPLORATORY VARIANTS (secondary analyses — labeled, not the bar):
//   buffered  — entry requires a close beyond edge ± 10% of range width
//               (filters marginal pokes).
//   retest    — after a confirmed close outside, wait for price to pull back
//               and TOUCH the broken edge, then enter on the next close beyond
//               it (within 8 candles). Same midpoint stop.
//   reverseOnFail — when a CONFIRMED breakout later closes back INSIDE the
//               range (the true "fake breakout"), enter the OPPOSITE way at
//               that close; stop = the failed extreme ± 2; target 2R; EOD.
//   Context split: performance above/below the median OR width (chop filter
//               evidence, reported not ruled).

import express from 'express';
import { kiteFiveMin } from './sweep_reclaim';
import type { DayCandle } from './gap_backtest';

const IST_MS = 5.5 * 3600 * 1000;
const minOfDay = (t: number) => { const x = new Date(t + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };

export const ORB_CFG = {
  entryFromMin: 570,   // 09:30 candle start
  entryToMin: 655,     // last entry candle starts 10:55
  rMultiple: 2,
  costsPts: 3,
  bufferFrac: 0.10,    // buffered variant: 10% of range width
  retestWithin: 8,     // candles after confirmation to complete a retest
  forceExitFromMin: 900,
  stopPad: 2,
};

type Trade = { date: string; dir: 'LONG' | 'SHORT'; entry: number; stop: number; target: number; entryIdx: number };
type Result = Trade & { exit: number; exitReason: 'TARGET' | 'STOP' | 'EOD'; pnlPts: number; rMultiple: number; rangeW: number };

function settle(t: Trade, candles: DayCandle[], rangeW: number): Result {
  const long = t.dir === 'LONG';
  for (let m = t.entryIdx + 1; m < candles.length; m++) {
    const c = candles[m];
    const stopHit = long ? c.low <= t.stop : c.high >= t.stop;
    const tgtHit = long ? c.high >= t.target : c.low <= t.target;
    if (stopHit) { const p = (long ? t.stop - t.entry : t.entry - t.stop) - ORB_CFG.costsPts; return { ...t, exit: t.stop, exitReason: 'STOP', pnlPts: +p.toFixed(1), rMultiple: +(p / Math.abs(t.entry - t.stop)).toFixed(2), rangeW }; }
    if (tgtHit) { const p = (long ? t.target - t.entry : t.entry - t.target) - ORB_CFG.costsPts; return { ...t, exit: t.target, exitReason: 'TARGET', pnlPts: +p.toFixed(1), rMultiple: +(p / Math.abs(t.entry - t.stop)).toFixed(2), rangeW }; }
    if (minOfDay(c.t) >= ORB_CFG.forceExitFromMin) { const p = (long ? c.close - t.entry : t.entry - c.close) - ORB_CFG.costsPts; return { ...t, exit: c.close, exitReason: 'EOD', pnlPts: +p.toFixed(1), rMultiple: +(p / Math.abs(t.entry - t.stop)).toFixed(2), rangeW }; }
  }
  const last = candles[candles.length - 1];
  const p = (t.dir === 'LONG' ? last.close - t.entry : t.entry - last.close) - ORB_CFG.costsPts;
  return { ...t, exit: last.close, exitReason: 'EOD', pnlPts: +p.toFixed(1), rMultiple: +(p / Math.abs(t.entry - t.stop)).toFixed(2), rangeW };
}

// One day → results for primary + each variant (any may be null = no setup).
export function orbDay(date: string, candles: DayCandle[]) {
  const cfg = ORB_CFG;
  if (candles.length < 6) return null;
  const or3 = candles.filter(c => { const m = minOfDay(c.t); return m >= 555 && m < 570; });
  if (or3.length < 3) return null;
  const orh = Math.max(...or3.map(c => c.high));
  const orl = Math.min(...or3.map(c => c.low));
  const mid = (orh + orl) / 2;
  const W = orh - orl;
  if (!(W > 0)) return null;

  const inEntryWindow = (i: number) => { const m = minOfDay(candles[i].t); return m >= cfg.entryFromMin && m <= cfg.entryToMin; };
  const mk = (dir: 'LONG' | 'SHORT', entry: number, i: number, stop: number): Trade => ({
    date, dir, entry, stop,
    target: dir === 'LONG' ? entry + cfg.rMultiple * (entry - stop) : entry - cfg.rMultiple * (stop - entry),
    entryIdx: i,
  });

  // ---- primary: first close beyond the range
  let primary: Result | null = null;
  let confirmIdx = -1; let confirmDir: 'LONG' | 'SHORT' | null = null;
  for (let i = 0; i < candles.length; i++) {
    if (!inEntryWindow(i)) continue;
    if (candles[i].close > orh) { confirmIdx = i; confirmDir = 'LONG'; primary = settle(mk('LONG', candles[i].close, i, mid), candles, W); break; }
    if (candles[i].close < orl) { confirmIdx = i; confirmDir = 'SHORT'; primary = settle(mk('SHORT', candles[i].close, i, mid), candles, W); break; }
  }

  // ---- buffered: first close beyond edge ± 10% of width
  let buffered: Result | null = null;
  for (let i = 0; i < candles.length; i++) {
    if (!inEntryWindow(i)) continue;
    if (candles[i].close > orh + cfg.bufferFrac * W) { buffered = settle(mk('LONG', candles[i].close, i, mid), candles, W); break; }
    if (candles[i].close < orl - cfg.bufferFrac * W) { buffered = settle(mk('SHORT', candles[i].close, i, mid), candles, W); break; }
  }

  // ---- retest: after primary confirmation, pull back to touch the edge, then
  //      enter on the next close beyond it (within N candles of confirmation)
  let retest: Result | null = null;
  if (confirmIdx >= 0 && confirmDir) {
    const edge = confirmDir === 'LONG' ? orh : orl;
    let touched = false;
    for (let k = confirmIdx + 1; k < Math.min(candles.length, confirmIdx + 1 + cfg.retestWithin); k++) {
      const c = candles[k];
      if (confirmDir === 'LONG') {
        if (c.low <= mid) break; // idea dead before retest completed
        if (!touched && c.low <= edge) touched = true;
        if (touched && c.close > edge) { retest = settle(mk('LONG', c.close, k, mid), candles, W); break; }
      } else {
        if (c.high >= mid) break;
        if (!touched && c.high >= edge) touched = true;
        if (touched && c.close < edge) { retest = settle(mk('SHORT', c.close, k, mid), candles, W); break; }
      }
    }
  }

  // ---- reverseOnFail: a CONFIRMED breakout that closes back inside the range
  let reverseOnFail: Result | null = null;
  if (confirmIdx >= 0 && confirmDir) {
    let extreme = confirmDir === 'LONG' ? candles[confirmIdx].high : candles[confirmIdx].low;
    for (let k = confirmIdx + 1; k < candles.length; k++) {
      const c = candles[k];
      if (minOfDay(c.t) >= cfg.forceExitFromMin) break;
      if (confirmDir === 'LONG') {
        extreme = Math.max(extreme, c.high);
        if (c.close < orh) { reverseOnFail = settle(mk('SHORT', c.close, k, extreme + cfg.stopPad), candles, W); break; }
        if (c.high >= candles[confirmIdx].close + cfg.rMultiple * (candles[confirmIdx].close - mid)) break; // breakout reached 2R — no failure trade
      } else {
        extreme = Math.min(extreme, c.low);
        if (c.close > orl) { reverseOnFail = settle(mk('LONG', c.close, k, extreme - cfg.stopPad), candles, W); break; }
        if (c.low <= candles[confirmIdx].close - cfg.rMultiple * (mid - candles[confirmIdx].close)) break;
      }
    }
  }

  return { date, rangeW: +W.toFixed(1), primary, buffered, retest, reverseOnFail };
}

// ---------------------------------------------------------------- job
const job: { status: string; startedAt: number | null; progress: string; error: string | null } =
  { status: 'idle', startedAt: null, progress: '', error: null };

function agg(list: Result[]) {
  const n = list.length;
  const wins = list.filter(o => o.pnlPts > 0).length;
  const tot = +list.reduce((a, o) => a + o.pnlPts, 0).toFixed(1);
  let eq = 0, peak = 0, mdd = 0;
  for (const o of list) { eq += o.pnlPts; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
  return {
    n, winRate: n ? +(wins / n * 100).toFixed(1) : null, totalPts: tot,
    avgPts: n ? +(tot / n).toFixed(2) : null,
    avgR: n ? +(list.reduce((a, o) => a + o.rMultiple, 0) / n).toFixed(2) : null,
    maxDrawdownPts: +mdd.toFixed(1),
  };
}

async function runOrbBacktest(db: any, days: number) {
  job.status = 'running'; job.startedAt = Date.now(); job.error = null;
  try {
    job.progress = 'fetching NIFTY 5-min history…';
    const n5 = await kiteFiveMin(256265, days);
    const dayKey = (t: number) => { const x = new Date(t + IST_MS); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };
    const byDay = new Map<string, DayCandle[]>();
    for (const c of n5) { const k = dayKey(c.t); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k)!.push(c); }
    const daysList = [...byDay.keys()].sort();
    job.progress = `evaluating ${daysList.length} days…`;

    const primary: Result[] = [], buffered: Result[] = [], retest: Result[] = [], reverseOnFail: Result[] = [];
    const ranges: number[] = [];
    for (const d of daysList) {
      const r = orbDay(d, byDay.get(d)!);
      if (!r) continue;
      ranges.push(r.rangeW);
      if (r.primary) primary.push(r.primary);
      if (r.buffered) buffered.push(r.buffered);
      if (r.retest) retest.push(r.retest);
      if (r.reverseOnFail) reverseOnFail.push(r.reverseOnFail);
    }
    const medW = ranges.length ? [...ranges].sort((a, b) => a - b)[Math.floor(ranges.length / 2)] : 0;
    const cut = Math.floor(primary.length * 0.6);
    const annualProfitApprox = primary.length ? +(primary.reduce((a, o) => a + o.pnlPts, 0) / (daysList.length / 250)).toFixed(1) : 0;
    const primaryAgg = agg(primary);
    const wfTest = agg(primary.slice(cut));
    const barMet = primaryAgg.n >= 60 && (primaryAgg.totalPts as number) > 0 && (wfTest.totalPts as number) > 0
      && Math.abs(primaryAgg.maxDrawdownPts as number) < Math.abs(annualProfitApprox);

    const result = {
      generatedAt: Date.now(), daysAnalyzed: daysList.length,
      firstDay: daysList[0], lastDay: daysList[daysList.length - 1],
      rules: ORB_CFG,
      preRegisteredBar: 'n>=60, totalPts>0, walk-forward test half >0, |maxDD| < one year profit',
      barMet,
      conservativeFills: 'stop assumed first when stop+target touch in one candle',
      primary: { ...primaryAgg, walkForward: { train: agg(primary.slice(0, cut)), test: wfTest }, annualProfitApprox,
        byDirection: { long: agg(primary.filter(o => o.dir === 'LONG')), short: agg(primary.filter(o => o.dir === 'SHORT')) },
        byExit: { target: primary.filter(o => o.exitReason === 'TARGET').length, stop: primary.filter(o => o.exitReason === 'STOP').length, eod: primary.filter(o => o.exitReason === 'EOD').length },
        byRangeWidth: { belowMedian: agg(primary.filter(o => o.rangeW < medW)), aboveMedian: agg(primary.filter(o => o.rangeW >= medW)) },
        medianRangeW: medW },
      exploratory: {
        note: 'secondary analyses — NOT the pre-registered bar',
        buffered: agg(buffered),
        retest: agg(retest),
        reverseOnFail: { ...agg(reverseOnFail), meaning: 'trading the TRUE fake breakout: confirmed break that closed back inside' },
      },
      equityPrimaryLast120: (() => { let eq = 0; return primary.slice(-120).map(o => ({ date: o.date, eq: +(eq += o.pnlPts).toFixed(1) })); })(),
    };
    db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run('orb_backtest', JSON.stringify(result), Date.now());
    job.status = 'done'; job.progress = `done: ${primary.length} primary trades over ${daysList.length} days`;
  } catch (e: any) {
    job.status = 'error'; job.error = e?.message || String(e);
    console.error('[orb-backtest] failed:', e);
  }
}

export function registerOrb(app: any, db: any, guard: any) {
  app.post('/api/orb/backtest/start', express.json(), guard, (req: any, res: any) => {
    if (job.status === 'running') return res.json({ started: false, job });
    runOrbBacktest(db, Math.min(730, parseInt(String(req.body?.days || '730'), 10) || 730));
    res.json({ started: true, note: 'poll /api/orb/backtest/status' });
  });
  app.get('/api/orb/backtest/start', guard, (_req: any, res: any) => {
    if (job.status === 'running') return res.json({ started: false, job });
    runOrbBacktest(db, 730);
    res.json({ started: true, note: 'poll /api/orb/backtest/status' });
  });
  app.get('/api/orb/backtest/status', (_req: any, res: any) => {
    const r: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('orb_backtest');
    res.json({ job, result: r ? JSON.parse(r.json) : null });
  });
  console.log('[orb] ORB backtest registered');
}

// deploy retrigger 2026-07-22
