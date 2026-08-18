// Systematic price-action search — the honest version of "find me an entry".
//
// WHY THIS EXISTS. Five hand-picked strategies were tested and all five failed.
// Picking a sixth by hand and testing it has a nasty property: keep doing it and
// something eventually passes BY LUCK, and that fluke is then traded with real
// money. So instead of guessing one rule, this enumerates a large PRE-DECLARED
// universe of price-action rules and evaluates them under a protocol designed to
// tell a real edge apart from the luckiest coin in a bag of coins.
//
// THE PROTOCOL (fixed before any result is seen):
//   1. Days are split chronologically: the first 60% is TRAIN, the last 40% TEST.
//      TEST is never looked at while choosing.
//   2. Every rule is scored on TRAIN only. The winner is chosen there.
//   3. The winner is then evaluated ONCE on TEST. That number is the verdict.
//   4. A "was the whole test period just easy?" guard: the winner must also beat
//      the 90th percentile of ALL rules on TEST. If every rule looks good on the
//      test half, the winner proved nothing.
//   5. Significance is reported raw AND Bonferroni-adjusted for the number of
//      rules searched, because searching N rules is N chances to be fooled.
//
// COSTS ARE CHARGED AT THE OPTION LEVEL, not in index points. A 15-point index
// edge can be entirely eaten by the bid-ask spread and time decay of the contract
// actually traded. Modelled for the DEEP-ITM contracts this terminal recommends:
//   option P&L (in index-point equivalents) = delta x index move
//                                             - spread - theta x hours held
// These three numbers are assumptions, stated here so they can be argued with and
// changed; they are deliberately pessimistic rather than flattering.

import express from 'express';
import { kiteFiveMin } from './sweep_reclaim';
import type { DayCandle } from './gap_backtest';

const IST_MS = 5.5 * 3600 * 1000;
const minOfDay = (t: number) => { const x = new Date(t + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const dayKey = (t: number) => { const x = new Date(t + IST_MS); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };

export const PA_COST = {
  delta: 0.85,          // deep-ITM contract moves ~85% of the index
  spreadPts: 3.0,       // crossing the bid-ask once; deep-ITM contracts are thinly
                        // quoted and 1.5 flattered the results — a 5-point index move
                        // should be roughly break-even, not a winner
  thetaPtsPerHour: 0.6, // decay while the position is held
  brokeragePts: 1.0,    // brokerage + taxes, index-point equivalents
};

// Option-level P&L from an index move, in index-point equivalents.
export function optionPnl(indexMove: number, minutesHeld: number): number {
  const gross = PA_COST.delta * indexMove;
  const decay = PA_COST.thetaPtsPerHour * (Math.max(0, minutesHeld) / 60);
  return +(gross - PA_COST.spreadPts - PA_COST.brokeragePts - decay).toFixed(2);
}

// ---------------------------------------------------------------- rule universe
export const TRIGGERS = ['engulf', 'pin', 'insideBreak', 'momentum', 'twoBar', 'closeBeyondPrior'] as const;
export const LOCATIONS = ['none', 'nearPD', 'nearOR', 'nearRound'] as const;
export const TRENDS = ['none', 'with', 'against'] as const;
export const WINDOWS = ['all', 'am', 'mid', 'pm'] as const;
export const STOPS = ['priorBar', 'atr'] as const;
export const TARGETS = ['1R', '2R', 'eod'] as const;

export type Rule = {
  trigger: typeof TRIGGERS[number]; location: typeof LOCATIONS[number];
  trend: typeof TRENDS[number]; window: typeof WINDOWS[number];
  stop: typeof STOPS[number]; target: typeof TARGETS[number];
};

export function buildRuleUniverse(): Rule[] {
  const out: Rule[] = [];
  for (const trigger of TRIGGERS) for (const location of LOCATIONS) for (const trend of TRENDS)
    for (const w of WINDOWS) for (const stop of STOPS) for (const target of TARGETS)
      out.push({ trigger, location, trend, window: w, stop, target });
  return out;
}

// ---------------------------------------------------------------- features
type Bar = DayCandle & {
  i: number; min: number; body: number; range: number; bull: boolean;
  upWick: number; dnWick: number; ema20: number; ema20Prev: number; atr: number;
  avgBody20: number; medRange: number;
};
type Day = { date: string; bars: Bar[]; pdh: number; pdl: number; pdc: number; orh: number; orl: number };

function buildDays(c5: DayCandle[]): Day[] {
  const byDay = new Map<string, DayCandle[]>();
  for (const c of c5) { const k = dayKey(c.t); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k)!.push(c); }
  const keys = [...byDay.keys()].sort();
  const days: Day[] = [];
  for (let d = 1; d < keys.length; d++) {
    const raw = byDay.get(keys[d])!, prev = byDay.get(keys[d - 1])!;
    if (raw.length < 12 || prev.length < 12) continue;
    const or3 = raw.filter(c => { const m = minOfDay(c.t); return m >= 555 && m < 570; });
    if (or3.length < 3) continue;

    let ema = raw[0].close; const k = 2 / 21;
    let atr = raw[0].high - raw[0].low;
    const ranges = raw.map(c => c.high - c.low).sort((a, b) => a - b);
    const medRange = ranges[Math.floor(ranges.length / 2)] || 1;
    const bars: Bar[] = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      const prevEma = ema;
      ema = i === 0 ? c.close : c.close * k + ema * (1 - k);
      const tr = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - raw[i - 1].close), Math.abs(c.low - raw[i - 1].close));
      atr = i === 0 ? tr : (atr * 13 + tr) / 14;
      const body = Math.abs(c.close - c.open);
      const from = Math.max(0, i - 20);
      let sumBody = 0; for (let j = from; j < i; j++) sumBody += Math.abs(raw[j].close - raw[j].open);
      bars.push({
        ...c, i, min: minOfDay(c.t), body, range: c.high - c.low, bull: c.close >= c.open,
        upWick: c.high - Math.max(c.open, c.close), dnWick: Math.min(c.open, c.close) - c.low,
        ema20: ema, ema20Prev: prevEma, atr, avgBody20: i > from ? sumBody / (i - from) : body, medRange,
      });
    }
    days.push({
      date: keys[d], bars,
      pdh: Math.max(...prev.map(c => c.high)), pdl: Math.min(...prev.map(c => c.low)),
      pdc: prev[prev.length - 1].close,
      orh: Math.max(...or3.map(c => c.high)), orl: Math.min(...or3.map(c => c.low)),
    });
  }
  return days;
}

// ---------------------------------------------------------------- rule evaluation
function triggerFires(t: Rule['trigger'], b: Bar, p: Bar, pp: Bar | undefined): 1 | -1 | 0 {
  switch (t) {
    case 'engulf':
      if (b.bull && !p.bull && b.close > p.open && b.open < p.close) return 1;
      if (!b.bull && p.bull && b.close < p.open && b.open > p.close) return -1;
      return 0;
    case 'pin':
      if (b.dnWick >= 2 * b.body && b.dnWick > b.upWick && b.body > 0) return 1;
      if (b.upWick >= 2 * b.body && b.upWick > b.dnWick && b.body > 0) return -1;
      return 0;
    case 'insideBreak':
      if (!pp) return 0;
      if (!(p.high <= pp.high && p.low >= pp.low)) return 0;
      if (b.close > p.high) return 1;
      if (b.close < p.low) return -1;
      return 0;
    case 'momentum':
      if (b.body < 1.5 * b.avgBody20 || b.avgBody20 <= 0) return 0;
      return b.bull ? 1 : -1;
    case 'twoBar':
      if (b.bull && p.bull && b.close > p.close && p.close > p.open) return 1;
      if (!b.bull && !p.bull && b.close < p.close && p.close < p.open) return -1;
      return 0;
    case 'closeBeyondPrior':
      if (b.close > p.high) return 1;
      if (b.close < p.low) return -1;
      return 0;
  }
  return 0;
}

function locationOk(loc: Rule['location'], b: Bar, d: Day): boolean {
  if (loc === 'none') return true;
  const near = (lvl: number) => Math.abs(b.close - lvl) <= Math.max(12, b.close * 0.0012);
  if (loc === 'nearPD') return near(d.pdh) || near(d.pdl) || near(d.pdc);
  if (loc === 'nearOR') return near(d.orh) || near(d.orl);
  if (loc === 'nearRound') return Math.abs(b.close - Math.round(b.close / 100) * 100) <= 15;
  return true;
}

function trendOk(tr: Rule['trend'], dir: 1 | -1, b: Bar): boolean {
  if (tr === 'none') return true;
  const rising = b.ema20 > b.ema20Prev;
  const withTrend = dir === 1 ? rising : !rising;
  return tr === 'with' ? withTrend : !withTrend;
}

function windowOk(w: Rule['window'], m: number): boolean {
  if (w === 'all') return m >= 570 && m <= 885;
  if (w === 'am') return m >= 570 && m <= 660;
  if (w === 'mid') return m > 660 && m <= 810;
  return m > 810 && m <= 885;
}

type Trade = { date: string; pnl: number };

// One trade per day at most — same discipline as every earlier test here.
function runRule(rule: Rule, days: Day[]): Trade[] {
  const trades: Trade[] = [];
  for (const d of days) {
    const bars = d.bars;
    for (let i = 3; i < bars.length - 1; i++) {
      const b = bars[i];
      if (!windowOk(rule.window, b.min)) continue;
      const dir = triggerFires(rule.trigger, b, bars[i - 1], bars[i - 2]);
      if (!dir) continue;
      if (!locationOk(rule.location, b, d)) continue;
      if (!trendOk(rule.trend, dir, b)) continue;

      const entry = b.close;
      const stopPx = rule.stop === 'priorBar'
        ? (dir === 1 ? Math.min(b.low, bars[i - 1].low) - 2 : Math.max(b.high, bars[i - 1].high) + 2)
        : (dir === 1 ? entry - b.atr : entry + b.atr);
      const risk = Math.abs(entry - stopPx);
      if (!(risk >= 6) || !(risk <= 80)) continue;   // unusable or absurd risk
      const rMul = rule.target === '1R' ? 1 : rule.target === '2R' ? 2 : 0;
      const targetPx = rMul ? (dir === 1 ? entry + rMul * risk : entry - rMul * risk) : null;

      let exitPx: number | null = null, exitMin = b.min;
      for (let m = i + 1; m < bars.length; m++) {
        const c = bars[m];
        exitMin = c.min;
        const stopHit = dir === 1 ? c.low <= stopPx : c.high >= stopPx;
        const tgtHit = targetPx !== null && (dir === 1 ? c.high >= targetPx : c.low <= targetPx);
        if (stopHit) { exitPx = stopPx; break; }           // stop assumed first — conservative
        if (tgtHit) { exitPx = targetPx as number; break; }
        if (c.min >= 900) { exitPx = c.close; break; }
      }
      if (exitPx === null) { const last = bars[bars.length - 1]; exitPx = last.close; exitMin = last.min; }
      const move = dir === 1 ? exitPx - entry : entry - exitPx;
      trades.push({ date: d.date, pnl: optionPnl(move, exitMin - b.min) });
      break; // one trade per day
    }
  }
  return trades;
}

function stats(trades: Trade[]) {
  const n = trades.length;
  if (!n) return { n: 0, total: 0, avg: null as number | null, winRate: null as number | null, maxDD: 0, t: null as number | null, p: null as number | null };
  const total = trades.reduce((a, x) => a + x.pnl, 0);
  const avg = total / n;
  const sd = Math.sqrt(trades.reduce((a, x) => a + (x.pnl - avg) ** 2, 0) / Math.max(1, n - 1));
  const t = sd > 0 ? avg / (sd / Math.sqrt(n)) : 0;
  // two-sided normal approximation
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)));
  let eq = 0, peak = 0, mdd = 0;
  for (const x of trades) { eq += x.pnl; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
  return {
    n, total: +total.toFixed(1), avg: +avg.toFixed(2),
    winRate: +(trades.filter(x => x.pnl > 0).length / n * 100).toFixed(1),
    maxDD: +mdd.toFixed(1), t: +t.toFixed(2), p: +p.toExponential(2),
  };
}
function erf(x: number): number {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, pp = 0.3275911;
  const tt = 1 / (1 + pp * x);
  const y = 1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x);
  return s * y;
}

// ---------------------------------------------------------------- job
const job: { status: string; startedAt: number | null; progress: string; error: string | null } =
  { status: 'idle', startedAt: null, progress: '', error: null };

async function runSearch(db: any, days: number) {
  job.status = 'running'; job.startedAt = Date.now(); job.error = null;
  try {
    job.progress = 'fetching NIFTY 5-min history…';
    const c5 = await kiteFiveMin(256265, days);
    const allDays = buildDays(c5);
    if (allDays.length < 100) throw new Error(`only ${allDays.length} usable days`);
    const cut = Math.floor(allDays.length * 0.6);
    const train = allDays.slice(0, cut), test = allDays.slice(cut);

    const universe = buildRuleUniverse();
    job.progress = `scoring ${universe.length} rules on ${train.length} train days…`;

    const scored: Array<{ rule: Rule; tr: any; te: any }> = [];
    for (let i = 0; i < universe.length; i++) {
      const rule = universe[i];
      const trTrades = runRule(rule, train);
      const teTrades = runRule(rule, test);
      scored.push({ rule, tr: stats(trTrades), te: stats(teTrades) });
      if (i % 200 === 0) job.progress = `scoring rules… ${i}/${universe.length}`;
    }

    // Choose ONLY on train, and only from rules with enough train trades to mean anything.
    const eligible = scored.filter(s => s.tr.n >= 60);
    eligible.sort((a, b) => (b.tr.avg ?? -1e9) - (a.tr.avg ?? -1e9));
    const winner = eligible[0] || null;

    // "Was the test half just easy?" — the winner must beat most rules out of sample.
    const teAvgs = scored.filter(s => s.te.n >= 20).map(s => s.te.avg ?? 0).sort((a, b) => a - b);
    const pct90 = teAvgs.length ? teAvgs[Math.floor(teAvgs.length * 0.9)] : 0;
    const medianTe = teAvgs.length ? teAvgs[Math.floor(teAvgs.length * 0.5)] : 0;
    const winnerPercentile = winner && teAvgs.length
      ? +(teAvgs.filter(v => v < (winner.te.avg ?? 0)).length / teAvgs.length * 100).toFixed(1) : null;

    const bonferroni = winner && winner.te.p !== null ? Math.min(1, winner.te.p * eligible.length) : null;
    const barMet = !!(winner && winner.te.n >= 40 && (winner.te.avg ?? 0) > 0 && (winner.te.total ?? 0) > 0
      && (winner.te.p ?? 1) < 0.05 && (winner.te.avg ?? 0) > pct90
      && Math.abs(winner.te.maxDD) < (winner.te.total ?? 0));

    const result = {
      generatedAt: Date.now(),
      protocol: 'rules scored on TRAIN only; the train winner evaluated ONCE on TEST; winner must also beat the 90th percentile of all rules on TEST',
      costModel: { ...PA_COST, note: 'option-level costs in index-point equivalents — assumptions, deliberately pessimistic' },
      preRegisteredBar: 'test n>=40, test avg>0, test total>0, test p<0.05, test avg > 90th percentile of all rules, |maxDD| < total',
      barMet,
      universeSize: universe.length, eligibleOnTrain: eligible.length,
      days: { total: allDays.length, train: train.length, test: test.length, firstDay: allDays[0]?.date, lastDay: allDays[allDays.length - 1]?.date },
      winner: winner ? { rule: winner.rule, train: winner.tr, test: winner.te, testPercentile: winnerPercentile, pBonferroni: bonferroni } : null,
      contextTestAvgs: { median: +medianTe.toFixed(2), p90: +pct90.toFixed(2), rulesCounted: teAvgs.length },
      top10ByTrain: eligible.slice(0, 10).map(s => ({ rule: s.rule, trainAvg: s.tr.avg, trainN: s.tr.n, testAvg: s.te.avg, testN: s.te.n, testTotal: s.te.total })),
      howManyPositiveOnTest: scored.filter(s => (s.te.total ?? 0) > 0).length,
    };
    db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run('pa_search', JSON.stringify(result), Date.now());
    job.status = 'done';
    job.progress = `done: ${universe.length} rules, bar ${barMet ? 'MET' : 'NOT met'}`;
  } catch (e: any) {
    job.status = 'error'; job.error = e?.message || String(e);
    console.error('[pa-search] failed:', e);
  }
}

export function registerPaSearch(app: any, db: any, guard: any) {
  const start = (req: any, res: any) => {
    if (job.status === 'running') return res.json({ started: false, job });
    runSearch(db, Math.min(730, parseInt(String(req.body?.days || req.query?.days || '730'), 10) || 730));
    res.json({ started: true, note: 'poll /api/pa/search/status — takes a few minutes' });
  };
  app.post('/api/pa/search/start', express.json(), guard, start);
  app.get('/api/pa/search/start', guard, start);
  app.get('/api/pa/search/status', (_req: any, res: any) => {
    const r: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('pa_search');
    res.json({ job, result: r ? JSON.parse(r.json) : null });
  });
  console.log('[pa-search] price-action rule search registered');
}
