// Sweep & Reclaim — mechanical detector + 2-year backtest (Stage A).
//
// STRATEGY UNDER TEST (exact rules, no discretion):
//   Levels mapped per day with NO lookahead: prev-day high/low/close, opening
//   range (first three 5-min candles, 09:15-09:30), and round-100 levels.
//   LONG: a 5-min candle pierces a level from above (fresh break, depth capped),
//   then a candle CLOSES back above it within 3 candles, inside an allowed time
//   window (09:30-11:00 or 13:45-14:45 IST). Entry = reclaim close. Stop = sweep
//   extreme − buffer. Target = nearest mapped level above (2R fallback). Force
//   exit at 15:00+. SHORT is the mirror. Max 2 signals/day, no overlap.
//   Bias filter (evaluated as a VARIANT, not baked in): previous day's
//   reconstructed Gap-Scorecard score — longs need ≥ 0, shorts ≤ 0.
//
// HONEST EXCLUSIONS (also emitted in the result): max-OI strike levels (no
// historical option-chain archive exists) and RSI confirmation (not computed in
// v1). FVG presence is RECORDED and reported as a split, not required.
// Conservative fills: if stop and target are touchable in the same candle, the
// STOP is assumed to have hit first.

import express from 'express';
import { getKiteClient } from './kite_service';
import { istDateStr, toISTString } from './gap_scorecard';
import { scoreDay, yahooHourly, kiteFifteenMin, type DayCandle, type Series } from './gap_backtest';
import { GAP_CONFIG } from './config/gapScorecard';

const IST_MS = 5.5 * 3600 * 1000;

export const SWEEP_CFG = {
  windowsMin: [[570, 655], [825, 880]] as Array<[number, number]>, // candle START minutes IST: 09:30-10:55, 13:45-14:40
  reclaimWithinCandles: 3,
  maxSweepDepthPts: 30,
  minSweepDepthPts: 8,   // a real stop-run, not a wick-graze — filters noise pokes
  stopBufferPts: 2,
  minRiskPts: 8,
  costsPts: GAP_CONFIG.costsPts,
  maxSignalsPerDay: 1,  // v1: one trade per day — no overlap management needed
  forceExitFromMin: 900,   // exit on close of first candle starting at/after 15:00 IST
  roundStep: 100,
};

// ---------------------------------------------------------------- pure logic (exported for the harness)
export type Level = { price: number; type: string };
export type Signal = {
  date: string; dir: 'LONG' | 'SHORT'; levelType: string; level: number;
  entryIdx: number; entry: number; stop: number; target: number; targetType: string;
  riskPts: number; fvg: boolean; window: 'AM' | 'PM';
};
export type Outcome = Signal & { exit: number; exitReason: 'TARGET' | 'STOP' | 'EOD'; pnlPts: number; rMultiple: number; biasScore: number | null };

const minOfDayIST = (t: number) => { const x = new Date(t + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };

export function buildDayLevels(prev: DayCandle[], today: DayCandle[]): Level[] {
  if (!prev.length || today.length < 3) return [];
  const pdh = Math.max(...prev.map(c => c.high));
  const pdl = Math.min(...prev.map(c => c.low));
  const pdc = prev[prev.length - 1].close;
  const or3 = today.slice(0, 3);
  const orh = Math.max(...or3.map(c => c.high));
  const orl = Math.min(...or3.map(c => c.low));
  const levels: Level[] = [
    { price: pdh, type: 'PDH' }, { price: pdl, type: 'PDL' }, { price: pdc, type: 'PDC' },
    { price: orh, type: 'ORH' }, { price: orl, type: 'ORL' },
  ];
  const lo = Math.floor((pdl - 50) / SWEEP_CFG.roundStep) * SWEEP_CFG.roundStep;
  const hi = Math.ceil((pdh + 50) / SWEEP_CFG.roundStep) * SWEEP_CFG.roundStep;
  for (let r = lo; r <= hi; r += SWEEP_CFG.roundStep) levels.push({ price: r, type: 'R100' });
  // de-dupe levels that sit within 2 pts of each other (named levels win over rounds)
  const out: Level[] = [];
  for (const L of levels) if (!out.some(o => Math.abs(o.price - L.price) < 2)) out.push(L);
  return out;
}

function hasFvg(c: DayCandle[], from: number, to: number, dir: 'LONG' | 'SHORT'): boolean {
  for (let k = Math.max(1, from); k <= Math.min(to, c.length - 2); k++) {
    if (dir === 'LONG' && c[k + 1].low > c[k - 1].high) return true;
    if (dir === 'SHORT' && c[k + 1].high < c[k - 1].low) return true;
  }
  return false;
}

export function detectDay(date: string, candles: DayCandle[], levels: Level[]): Signal[] {
  const cfg = SWEEP_CFG;
  const signals: Signal[] = [];
  if (candles.length < 6 || !levels.length) return signals;
  const inWindow = (idx: number) => {
    const m = minOfDayIST(candles[idx].t);
    return cfg.windowsMin.some(([a, b]) => m >= a && m <= b);
  };
  let busyUntil = -1;
  for (let i = 3; i < candles.length && signals.length < cfg.maxSignalsPerDay; i++) {
    if (i <= busyUntil || !inWindow(i)) continue;
    for (const L of levels) {
      // LONG: pierce below L (fresh), reclaim close above within N candles
      if (candles[i].low < L.price && candles[i - 1].low >= L.price) {
        let extreme = candles[i].low; let done = false;
        for (let j = i; j <= Math.min(i + cfg.reclaimWithinCandles, candles.length - 1) && !done; j++) {
          extreme = Math.min(extreme, candles[j].low);
          const depth = L.price - extreme;
          if (depth > cfg.maxSweepDepthPts) { done = true; break; }
          if (candles[j].close > L.price && inWindow(j)) {
            // Reclaim close. Only a deep-enough sweep is a signal; a shallow poke
            // keeps the setup pending — the market often grazes, THEN sweeps.
            if (depth >= cfg.minSweepDepthPts) {
              const entry = candles[j].close;
              const stop = extreme - cfg.stopBufferPts;
              const risk = entry - stop;
              if (risk >= cfg.minRiskPts) {
                const above = levels.filter(x => x.price > entry + risk * 0.5).sort((a, b) => a.price - b.price)[0];
                const target = above ? above.price : entry + 2 * risk;
                signals.push({
                  date, dir: 'LONG', levelType: L.type, level: L.price, entryIdx: j, entry, stop,
                  target, targetType: above ? above.type : '2R', riskPts: +risk.toFixed(1),
                  fvg: hasFvg(candles, i, j + 1, 'LONG'), window: minOfDayIST(candles[j].t) < 720 ? 'AM' : 'PM',
                });
                busyUntil = candles.length;
              }
              done = true;
            }
          }
        }
        if (signals.length >= cfg.maxSignalsPerDay) break;
      }
      // SHORT mirror: pierce above L, reclaim close below
      if (candles[i].high > L.price && candles[i - 1].high <= L.price) {
        let extreme = candles[i].high; let done = false;
        for (let j = i; j <= Math.min(i + cfg.reclaimWithinCandles, candles.length - 1) && !done; j++) {
          extreme = Math.max(extreme, candles[j].high);
          const depth = extreme - L.price;
          if (depth > cfg.maxSweepDepthPts) { done = true; break; }
          if (candles[j].close < L.price && inWindow(j)) {
            if (depth >= cfg.minSweepDepthPts) {
              const entry = candles[j].close;
              const stop = extreme + cfg.stopBufferPts;
              const risk = stop - entry;
              if (risk >= cfg.minRiskPts) {
                const below = levels.filter(x => x.price < entry - risk * 0.5).sort((a, b) => b.price - a.price)[0];
                const target = below ? below.price : entry - 2 * risk;
                signals.push({
                  date, dir: 'SHORT', levelType: L.type, level: L.price, entryIdx: j, entry, stop,
                  target, targetType: below ? below.type : '2R', riskPts: +risk.toFixed(1),
                  fvg: hasFvg(candles, i, j + 1, 'SHORT'), window: minOfDayIST(candles[j].t) < 720 ? 'AM' : 'PM',
                });
                busyUntil = candles.length;
              }
              done = true;
            }
          }
        }
        if (signals.length >= cfg.maxSignalsPerDay) break;
      }
    }
  }
  return signals;
}

export function simulate(sig: Signal, candles: DayCandle[]): Omit<Outcome, 'biasScore'> {
  const cfg = SWEEP_CFG;
  for (let m = sig.entryIdx + 1; m < candles.length; m++) {
    const c = candles[m];
    const long = sig.dir === 'LONG';
    const stopHit = long ? c.low <= sig.stop : c.high >= sig.stop;
    const tgtHit = long ? c.high >= sig.target : c.low <= sig.target;
    if (stopHit) { // conservative: stop first when both touch
      const pnl = (long ? sig.stop - sig.entry : sig.entry - sig.stop) - cfg.costsPts;
      return { ...sig, exit: sig.stop, exitReason: 'STOP', pnlPts: +pnl.toFixed(1), rMultiple: +(pnl / sig.riskPts).toFixed(2) };
    }
    if (tgtHit) {
      const pnl = (long ? sig.target - sig.entry : sig.entry - sig.target) - cfg.costsPts;
      return { ...sig, exit: sig.target, exitReason: 'TARGET', pnlPts: +pnl.toFixed(1), rMultiple: +(pnl / sig.riskPts).toFixed(2) };
    }
    if (minOfDayIST(c.t) >= cfg.forceExitFromMin) {
      const pnl = (long ? c.close - sig.entry : sig.entry - c.close) - cfg.costsPts;
      return { ...sig, exit: c.close, exitReason: 'EOD', pnlPts: +pnl.toFixed(1), rMultiple: +(pnl / sig.riskPts).toFixed(2) };
    }
  }
  const last = candles[candles.length - 1];
  const pnl = (sig.dir === 'LONG' ? last.close - sig.entry : sig.entry - last.close) - cfg.costsPts;
  return { ...sig, exit: last.close, exitReason: 'EOD', pnlPts: +pnl.toFixed(1), rMultiple: +(pnl / sig.riskPts).toFixed(2) };
}

// ---------------------------------------------------------------- data + job
async function kiteFiveMin(token: number, days: number): Promise<DayCandle[]> {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) throw new Error('no Kite session');
  const out: DayCandle[] = [];
  const CHUNK = 90; // 5-minute interval limit ~100 days/request
  let to = Date.now(); let remaining = days;
  const chunks: Array<[number, number]> = [];
  while (remaining > 0) { const span = Math.min(CHUNK, remaining); chunks.unshift([to - span * 86400000, to]); to -= span * 86400000; remaining -= span; }
  for (const [f, t] of chunks) {
    const hist = await kc.getHistoricalData(token, '5minute', toISTString(f), toISTString(t));
    for (const c of hist || []) out.push({ t: new Date(c.date).getTime(), open: c.open, high: c.high, low: c.low, close: c.close });
    await new Promise(r => setTimeout(r, 400));
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((c, i) => i === 0 || c.t !== out[i - 1].t);
}

const job: { status: string; startedAt: number | null; progress: string; error: string | null } =
  { status: 'idle', startedAt: null, progress: '', error: null };

async function runSweepBacktest(db: any, days: number) {
  job.status = 'running'; job.startedAt = Date.now(); job.error = null;
  try {
    const dayKey = (t: number) => { const x = new Date(t + IST_MS); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };

    job.progress = 'fetching NIFTY 5-min history…';
    const n5 = await kiteFiveMin(256265, days);
    job.progress = 'fetching NIFTY + VIX 15-min (for bias reconstruction)…';
    const n15 = await kiteFifteenMin(256265, days);
    const v15 = await kiteFifteenMin(264969, days);
    job.progress = 'fetching external hourly series…';
    const ext: Record<string, Series> = {};
    for (const [k, sym] of Object.entries(GAP_CONFIG.yahooSymbols)) { ext[k] = await yahooHourly(sym); await new Promise(r => setTimeout(r, 300)); }

    // group by IST day (same glue as the gap backtest)
    const g5 = new Map<string, DayCandle[]>(); for (const c of n5) { const k = dayKey(c.t); if (!g5.has(k)) g5.set(k, []); g5.get(k)!.push(c); }
    const g15 = new Map<string, DayCandle[]>(); for (const c of n15) { const k = dayKey(c.t); if (!g15.has(k)) g15.set(k, []); g15.get(k)!.push(c); }
    const gv = new Map<string, DayCandle[]>(); for (const c of v15) { const k = dayKey(c.t); if (!gv.has(k)) gv.set(k, []); gv.get(k)!.push(c); }
    const daysList = [...g5.keys()].sort();

    // reconstruct previous-day bias score per day (tested scoreDay engine)
    job.progress = 'reconstructing daily bias scores…';
    const biasByDate = new Map<string, number>();
    const d15 = [...g15.keys()].sort();
    for (let i = 0; i < d15.length; i++) {
      const d = d15[i];
      const [y, m, dd] = d.split('-').map(Number);
      const prevV = i > 0 ? gv.get(d15[i - 1]) : null;
      const vArr = gv.get(d) || [];
      const v1500 = vArr.find(c => { const x = new Date(c.t + IST_MS); return x.getUTCHours() === 15 && x.getUTCMinutes() === 0; });
      try {
        const s = scoreDay({
          dayUtc0: Date.UTC(y, m - 1, dd), nifty: g15.get(d)!,
          vixPrevClose: prevV && prevV.length ? prevV[prevV.length - 1].close : null,
          vix1515: v1500 ? v1500.close : null,
          es: ext.es, nq: ext.nq, dax: ext.dax, ftse: ext.ftse, brent: ext.brent, usdinr: ext.usdinr,
        });
        biasByDate.set(d, s.score);
      } catch (e) { /* bias missing for this day → null later */ }
    }

    job.progress = `detecting setups over ${daysList.length} days…`;
    const outcomes: Outcome[] = [];
    for (let i = 1; i < daysList.length; i++) {
      const d = daysList[i]; const prevD = daysList[i - 1];
      const todays = g5.get(d)!; const prevs = g5.get(prevD)!;
      const levels = buildDayLevels(prevs, todays);
      const sigs = detectDay(d, todays, levels);
      const bias = biasByDate.has(prevD) ? (biasByDate.get(prevD) as number) : null;
      for (const s of sigs) outcomes.push({ ...simulate(s, todays), biasScore: bias });
    }

    // ---------------- evaluation
    const agg = (list: Outcome[]) => {
      const n = list.length;
      const wins = list.filter(o => o.pnlPts > 0).length;
      const tot = +list.reduce((a, o) => a + o.pnlPts, 0).toFixed(1);
      const avg = n ? +(tot / n).toFixed(2) : null;
      const avgR = n ? +(list.reduce((a, o) => a + o.rMultiple, 0) / n).toFixed(2) : null;
      let eq = 0, peak = 0, mdd = 0;
      for (const o of list) { eq += o.pnlPts; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
      return { n, winRate: n ? +(wins / n * 100).toFixed(1) : null, totalPts: tot, avgPts: avg, avgR, maxDrawdownPts: +mdd.toFixed(1) };
    };
    const aligned = outcomes.filter(o => o.biasScore !== null && ((o.dir === 'LONG' && (o.biasScore as number) >= 0) || (o.dir === 'SHORT' && (o.biasScore as number) <= 0)));
    const split = (f: (o: Outcome) => boolean) => agg(outcomes.filter(f));
    const cut = Math.floor(aligned.length * 0.6);
    const result = {
      generatedAt: Date.now(), daysAnalyzed: daysList.length - 1,
      firstDay: daysList[1], lastDay: daysList[daysList.length - 1],
      rules: SWEEP_CFG,
      excluded: ['max-OI strike levels (no historical option-chain archive)', 'RSI confirmation (not computed in v1)'],
      conservativeFills: 'stop assumed first when stop+target touch in one candle',
      all: agg(outcomes),
      biasAligned: agg(aligned),
      byDirection: { long: split(o => o.dir === 'LONG'), short: split(o => o.dir === 'SHORT') },
      byDirectionAligned: {
        long: agg(aligned.filter(o => o.dir === 'LONG')),
        short: agg(aligned.filter(o => o.dir === 'SHORT')),
      },
      byLevel: Object.fromEntries(['PDH', 'PDL', 'PDC', 'ORH', 'ORL', 'R100'].map(t => [t, split(o => o.levelType === t)])),
      byFvg: { withFvg: split(o => o.fvg), withoutFvg: split(o => !o.fvg) },
      byWindow: { am: split(o => o.window === 'AM'), pm: split(o => o.window === 'PM') },
      byExit: { target: outcomes.filter(o => o.exitReason === 'TARGET').length, stop: outcomes.filter(o => o.exitReason === 'STOP').length, eod: outcomes.filter(o => o.exitReason === 'EOD').length },
      walkForwardAligned: { train: agg(aligned.slice(0, cut)), test: agg(aligned.slice(cut)) },
      equityAlignedLast120: (() => { let eq = 0; return aligned.slice(-120).map(o => ({ date: o.date, eq: +(eq += o.pnlPts).toFixed(1) })); })(),
    };
    db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run('sweep_backtest', JSON.stringify(result), Date.now());
    job.status = 'done'; job.progress = `done: ${outcomes.length} signals over ${daysList.length - 1} days`;
    console.log('[sweep-backtest] complete:', outcomes.length, 'signals');
  } catch (e: any) {
    job.status = 'error'; job.error = e?.message || String(e);
    console.error('[sweep-backtest] failed:', e);
  }
}

export function registerSweepReclaim(app: any, db: any, guard: any) {
  app.post('/api/sweep/backtest/start', express.json(), guard, (req: any, res: any) => {
    if (job.status === 'running') return res.json({ started: false, job });
    const days = Math.min(730, parseInt(String(req.body?.days || '730'), 10) || 730);
    runSweepBacktest(db, days);
    res.json({ started: true, days, note: 'poll /api/sweep/backtest/status' });
  });
  // GET aliases: start is idempotent-guarded by the running check; status is read-only.
  app.get('/api/sweep/backtest/start', guard, (_req: any, res: any) => {
    if (job.status === 'running') return res.json({ started: false, job });
    runSweepBacktest(db, 730);
    res.json({ started: true, days: 730, note: 'poll /api/sweep/backtest/status' });
  });
  app.get('/api/sweep/backtest/status', (_req: any, res: any) => {
    const r: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('sweep_backtest');
    res.json({ job, result: r ? JSON.parse(r.json) : null });
  });
  console.log('[sweep] Sweep & Reclaim backtest registered');
}
