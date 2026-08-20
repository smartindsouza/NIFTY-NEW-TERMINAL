// H-levels — reverse-engineering the undisclosed formula.
//
// Martin receives six levels each morning from a person and enters them in the
// chart; the journal has been storing them dated since 23 Jul. This asks the only
// two questions that matter, in the right order:
//
//   1. ARE THEY EVEN RECOMPUTED DAILY? If the same numbers come back day after
//      day, there is no formula to find — they are hand-drawn rays that get
//      redrawn occasionally. A previous investigation into a similar system ended
//      exactly there, so this is checked FIRST and cheaply.
//   2. IF THEY DO CHANGE, WHICH FAMILY FITS? Every standard family is computed
//      from the PREVIOUS day's OHLC and each stored level is matched to its
//      nearest candidate. A real formula matches to within a point or two on
//      almost every day; a coincidence does not.
//
// The honest answer may be "none of these". That is a result, not a failure — it
// tells Martin what he actually depends on.

import express from 'express';
import { getKiteClient } from './kite_service';

const IST_MS = 5.5 * 3600 * 1000;

export type Daily = { date: string; open: number; high: number; low: number; close: number };

// ---------------------------------------------------------------- families
/** Every candidate set is built from the PREVIOUS session's OHLC (+ today's open
 *  where a family genuinely uses it). Nothing here may peek at today's range. */
export function candidateLevels(prev: Daily, todayOpen?: number): Record<string, number[]> {
  const { high: H, low: L, close: C } = prev;
  const R = H - L;
  const out: Record<string, number[]> = {};

  const P = (H + L + C) / 3;
  out.classicPivot = [P, 2 * P - L, 2 * P - H, P + R, P - R, H + 2 * (P - L), L - 2 * (H - P)];

  const w = (H + L + 2 * C) / 4;
  out.woodie = [w, 2 * w - L, 2 * w - H, w + R, w - R];

  out.camarilla = [
    C + R * 1.1 / 12, C - R * 1.1 / 12,
    C + R * 1.1 / 6, C - R * 1.1 / 6,
    C + R * 1.1 / 4, C - R * 1.1 / 4,
    C + R * 1.1 / 2, C - R * 1.1 / 2,
  ];

  out.fibPivot = [P, P + 0.382 * R, P - 0.382 * R, P + 0.618 * R, P - 0.618 * R, P + R, P - R];

  const bc = (H + L) / 2, tc = 2 * P - bc;
  out.cpr = [P, bc, tc, 2 * P - L, 2 * P - H, P + R, P - R];

  out.prevDayLevels = [H, L, C, (H + L) / 2, (H + C) / 2, (L + C) / 2];

  out.pctOfClose = [0.25, 0.5, 0.75, 1.0].flatMap(p => [C * (1 + p / 100), C * (1 - p / 100)]);

  out.roundHundreds = (() => {
    const lo = Math.floor((L - 200) / 100) * 100, hi = Math.ceil((H + 200) / 100) * 100;
    const a: number[] = []; for (let x = lo; x <= hi; x += 100) a.push(x);
    return a;
  })();

  if (todayOpen && isFinite(todayOpen)) {
    out.fromTodayOpen = [0.25, 0.5, 0.75, 1.0].flatMap(p => [todayOpen * (1 + p / 100), todayOpen * (1 - p / 100)]);
  }
  return out;
}

/** Distance from each stored level to its nearest candidate.
 *  MEAN is reported for completeness but MEDIAN is what the verdict uses: if the
 *  person derives five levels from a formula and draws the sixth by hand, one bad
 *  level drags the mean far enough to hide a real match, while the median shrugs
 *  it off. That case is likely enough to design for. */
export function fitErrors(stored: number[], candidates: number[]): { mean: number; median: number; worst: number } | null {
  if (!stored.length || !candidates.length) return null;
  const dists = stored.map(s => {
    let best = Infinity;
    for (const c of candidates) { const d = Math.abs(s - c); if (d < best) best = d; }
    return best;
  }).sort((a, b) => a - b);
  const mean = dists.reduce((a, d) => a + d, 0) / dists.length;
  return {
    mean: +mean.toFixed(2),
    median: +dists[Math.floor(dists.length / 2)].toFixed(2),
    worst: +dists[dists.length - 1].toFixed(2),
  };
}
export function fitError(stored: number[], candidates: number[]): number | null {
  const r = fitErrors(stored, candidates);
  return r ? r.mean : null;
}

/** How much a day's levels moved versus the previous journaled day. */
export function dayToDayShift(a: number[], b: number[]): { identical: number; meanShift: number } {
  const n = Math.min(a.length, b.length);
  if (!n) return { identical: 0, meanShift: 0 };
  let same = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d < 1) same++;
    sum += d;
  }
  return { identical: same, meanShift: +(sum / n).toFixed(2) };
}

// ---------------------------------------------------------------- data
async function dailyCandles(days: number): Promise<Daily[]> {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) throw new Error('no Kite session — log in to Zerodha first');
  const istStr = (ms: number) => {
    const x = new Date(ms + IST_MS);
    return x.toISOString().slice(0, 10) + ' ' + x.toISOString().slice(11, 19);
  };
  const raw = await kc.getHistoricalData(256265, 'day', istStr(Date.now() - days * 86400000), istStr(Date.now()));
  return (raw || []).map((c: any) => {
    const x = new Date(new Date(c.date).getTime() + IST_MS);
    return {
      date: `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`,
      open: c.open, high: c.high, low: c.low, close: c.close,
    };
  });
}

// ---------------------------------------------------------------- the hunt
export async function runHunt(db: any) {
  const rows: any[] = db.prepare('SELECT date, levels FROM h_levels ORDER BY date').all();
  const journal = rows
    .map(r => { try { return { date: r.date, levels: (JSON.parse(r.levels) || []).map(Number).filter((v: number) => isFinite(v) && v > 0) }; } catch (e) { return null; } })
    .filter((x: any) => x && x.levels.length) as { date: string; levels: number[] }[];

  if (journal.length < 2) {
    return { daysCollected: journal.length, verdict: 'not enough journal days yet — keep saving the morning levels' };
  }

  // ---- Question 1: do they change at all?
  const shifts: any[] = [];
  for (let i = 1; i < journal.length; i++) {
    const s = dayToDayShift(journal[i].levels, journal[i - 1].levels);
    shifts.push({ date: journal[i].date, ...s, of: journal[i].levels.length });
  }
  const totalPairs = shifts.reduce((a, s) => a + s.of, 0);
  const identicalPairs = shifts.reduce((a, s) => a + s.identical, 0);
  const pctIdentical = totalPairs ? +(identicalPairs / totalPairs * 100).toFixed(1) : 0;
  const medianShift = (() => {
    const v = shifts.map(s => s.meanShift).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  })();

  // ---- Question 2: which family fits?
  let daily: Daily[] = [];
  let dataError: string | null = null;
  try { daily = await dailyCandles(120); } catch (e: any) { dataError = e?.message || String(e); }
  const byDate = new Map(daily.map(d => [d.date, d]));
  const ordered = daily.map(d => d.date);

  const familyErrors: Record<string, number[]> = {};
  const familyMedians: Record<string, number[]> = {};
  let daysFitted = 0;
  for (const j of journal) {
    const idx = ordered.indexOf(j.date);
    if (idx < 1) continue;                       // need the PREVIOUS session
    const prev = byDate.get(ordered[idx - 1])!;
    const today = byDate.get(j.date);
    if (!prev) continue;
    daysFitted++;
    const cands = candidateLevels(prev, today?.open);
    for (const [name, arr] of Object.entries(cands)) {
      const e = fitErrors(j.levels, arr);
      if (e) { (familyErrors[name] ||= []).push(e.mean); (familyMedians[name] ||= []).push(e.median); }
    }
  }

  const summary = Object.entries(familyErrors).map(([name, errs]) => {
    const sorted = [...errs].sort((a, b) => a - b);
    const meds = [...(familyMedians[name] || [])].sort((a, b) => a - b);
    const typicalMedian = meds.length ? meds[Math.floor(meds.length / 2)] : null;
    return {
      family: name, days: errs.length,
      medianErrorPts: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
      // Robust to one hand-drawn level in an otherwise formulaic set.
      typicalLevelErrorPts: typicalMedian === null ? null : +typicalMedian.toFixed(2),
      bestDayPts: +sorted[0].toFixed(2),
      daysWithin2pts: errs.filter(e => e <= 2).length,
      daysTypicalWithin2pts: (familyMedians[name] || []).filter(e => e <= 2).length,
    };
  }).sort((a, b) => (a.typicalLevelErrorPts ?? 999) - (b.typicalLevelErrorPts ?? 999));

  const best = summary[0];
  // A real formula lands within a point or two nearly every day. Anything looser
  // is the nearest-neighbour effect, not a recipe.
  // Judged on the ROBUST measure, so a single discretionary level cannot mask a
  // formula that governs the rest.
  const looksLikeFormula = !!best && (best.typicalLevelErrorPts ?? 999) <= 2
    && best.daysTypicalWithin2pts >= Math.max(5, best.days * 0.7);
  const partialMatch = !!best && !looksLikeFormula && (best.typicalLevelErrorPts ?? 999) <= 2;

  return {
    daysCollected: journal.length,
    firstDay: journal[0].date, lastDay: journal[journal.length - 1].date,
    levelsPerDay: journal[journal.length - 1].levels.length,
    persistence: {
      pctLevelsIdenticalToPreviousDay: pctIdentical,
      medianDailyShiftPts: medianShift,
      reading: pctIdentical > 60
        ? 'MOSTLY STATIC — these look like hand-drawn rays that are redrawn occasionally, not a daily formula'
        : pctIdentical > 20
          ? 'PARTLY STATIC — some levels are fixed rays, others move daily'
          : 'RECOMPUTED DAILY — a formula is plausible',
    },
    formulaFit: dataError
      ? { error: dataError, note: 'could not fetch daily candles; persistence result above is still valid' }
      : { daysFitted, families: summary },
    verdict: journal.length < 30
      ? `${journal.length} days collected — the fit below is provisional; 30+ makes it trustworthy`
      : looksLikeFormula
        ? `LIKELY MATCH: ${best.family} — typical level lands within ${best.typicalLevelErrorPts} pts on ${best.daysTypicalWithin2pts}/${best.days} days`
        : partialMatch
          ? `PARTIAL MATCH: most levels look like ${best.family}, but not consistently enough to call it the recipe`
        : pctIdentical > 60
          ? 'No formula needed — the levels are largely static rays, redrawn by hand'
          : 'No standard family fits. The levels are either proprietary, hand-drawn, or built from data we do not have (order flow, options positioning)',
  };
}

export function registerHLevelsHunt(app: any, db: any, guard: any) {
  app.get('/api/h-levels/hunt', guard, async (_req: any, res: any) => {
    try { res.json(await runHunt(db)); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  console.log('[h-levels] formula hunt registered');
}
