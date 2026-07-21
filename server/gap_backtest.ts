// Overnight Gap Scorecard — historical backtest (admin-triggered async job).
//
// Reconstructs a 15:15 IST snapshot for each trading day over ~2 years using
// ONLY data timestamped ≤ 15:15 IST of that day (no lookahead), scores it with
// the SAME thresholds/weights as the live engine (imported from the shared
// config), and evaluates against the next day's actual opening gap.
//
// DOCUMENTED APPROXIMATIONS (also emitted in the result):
// - External symbols use Yahoo 60-minute bars (hourly history caps near 730
//   days): each reading is the nearest bar at/just before the reference time.
// - "Prior US settlement" ≈ last hourly bar at/before 20:00 UTC of the prior
//   calendar day (real settlement is 17:00 ET; ±1h across DST).
// - Europe "since own open" ≈ change from the first hourly bar at/after 07:00
//   UTC of the day.
// - Equity curve entries use the 15:00-15:15 IST candle close (proxy for the
//   prompt's 15:25 futures fill) and exit at the close of the next day's first
//   15-min candle (proxy for 09:20), minus the configured 3-pt round-trip.
// - EXCLUDED SIGNALS: futures **basis** (Kite cannot serve historical candles
//   for expired monthly futures) and **breadth** (50 constituents × 2y of
//   15-min candles; optional per the spec and skipped by default). Max
//   composite is therefore ±7, not ±9 — bucket labels account for this.

import axios from 'axios';
import express from 'express';
import { getKiteClient } from './kite_service';
import { GAP_CONFIG } from './config/gapScorecard';
import { toISTString, istDateStr } from './gap_scorecard';

const IST_MS = 5.5 * 3600 * 1000;
type Series = Array<[number, number]>; // [epochMs, price] ascending

// ---------------------------------------------------------------- pure helpers (exported for the test harness)
export function priceAtOrBefore(s: Series, t: number): number | null {
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m][0] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? s[ans][1] : null;
}
export function priceAtOrAfter(s: Series, t: number, notAfter: number): number | null {
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m][0] >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans >= 0 && s[ans][0] <= notAfter ? s[ans][1] : null;
}
const pct = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0) ? ((a - b) / b) * 100 : null;

export type DayCandle = { t: number; open: number; high: number; low: number; close: number };

// Score one historical day from pre-15:15 data only. Pure — fully harness-testable.
export function scoreDay(args: {
  dayUtc0: number;                    // UTC midnight of the IST calendar day
  nifty: DayCandle[];                 // that day's 15-min candles (IST session)
  vixPrevClose: number | null;        // previous trading day's last VIX candle close
  vix1515: number | null;             // VIX close of the 15:00 IST candle
  es: Series; nq: Series; dax: Series; ftse: Series; brent: Series; usdinr: Series;
}) {
  const C = GAP_CONFIG; const W = C.weights;
  const t1515 = args.dayUtc0 + (15 * 60 + 15) * 60000 - IST_MS; // 15:15 IST in UTC epoch
  const tEurOpen = args.dayUtc0 + 7 * 3600 * 1000;              // 07:00 UTC
  const tPrevSettle = args.dayUtc0 - 4 * 3600 * 1000;           // 20:00 UTC previous day
  const sig: Record<string, { raw: any; score: number }> = {};

  // US futures (weight 2)
  const esPct = pct(priceAtOrBefore(args.es, t1515), priceAtOrBefore(args.es, tPrevSettle));
  const nqPct = pct(priceAtOrBefore(args.nq, t1515), priceAtOrBefore(args.nq, tPrevSettle));
  const usVals = [esPct, nqPct].filter((v): v is number => v !== null);
  const usAvg = usVals.length ? usVals.reduce((a, b) => a + b, 0) / usVals.length : null;
  sig.usFutures = { raw: usAvg, score: usAvg === null ? 0 : usAvg > C.usFuturesPct ? 1 : usAvg < -C.usFuturesPct ? -1 : 0 };

  // Europe (weight 1) — since own open
  const daxPct = pct(priceAtOrBefore(args.dax, t1515), priceAtOrAfter(args.dax, tEurOpen, t1515));
  const ftsePct = pct(priceAtOrBefore(args.ftse, t1515), priceAtOrAfter(args.ftse, tEurOpen, t1515));
  sig.europe = { raw: { dax: daxPct, ftse: ftsePct }, score: (daxPct === null || ftsePct === null) ? 0 : (daxPct > 0 && ftsePct > 0) ? 1 : (daxPct < 0 && ftsePct < 0) ? -1 : 0 };

  // Macro (weight 1)
  const brentPct = pct(priceAtOrBefore(args.brent, t1515), priceAtOrBefore(args.brent, tPrevSettle));
  const inrPct = pct(priceAtOrBefore(args.usdinr, t1515), priceAtOrBefore(args.usdinr, tPrevSettle));
  let macroScore = 0;
  if (brentPct !== null && inrPct !== null) {
    if (brentPct < -C.brentPct && inrPct <= 0) macroScore = 1;
    else if (brentPct > C.brentPct || inrPct > C.rupeeWeakPct) macroScore = -1;
  }
  sig.macro = { raw: { brent: brentPct, usdinr: inrPct }, score: macroScore };

  // NIFTY-derived: CLV + last hour, using candles up to and incl. the 15:00 bar
  const upTo1515 = args.nifty.filter(c => c.t + 15 * 60000 <= t1515 + 60000);
  const c1400 = args.nifty.find(c => new Date(c.t + IST_MS).getUTCHours() === 14 && new Date(c.t + IST_MS).getUTCMinutes() === 0);
  const c1500 = args.nifty.find(c => new Date(c.t + IST_MS).getUTCHours() === 15 && new Date(c.t + IST_MS).getUTCMinutes() === 0);
  if (upTo1515.length && c1500) {
    const hi = Math.max(...upTo1515.map(c => c.high));
    const lo = Math.min(...upTo1515.map(c => c.low));
    const ltp = c1500.close;
    const clv = hi > lo ? (ltp - lo) / (hi - lo) : null;
    sig.clv = { raw: clv, score: clv === null ? 0 : clv > C.clvHigh ? 1 : clv < C.clvLow ? -1 : 0 };
    const lh = c1400 && c1400.close > 0 ? ((c1500.close - c1400.close) / c1400.close) * 100 : null;
    sig.lastHour = { raw: lh, score: lh === null ? 0 : lh > C.lastHourPct ? 1 : lh < -C.lastHourPct ? -1 : 0 };
  } else { sig.clv = { raw: null, score: 0 }; sig.lastHour = { raw: null, score: 0 }; }

  // VIX (weight 1) — day change at 15:15 vs previous close; caution ≥ +5%
  let cautionFlag = false;
  const vixChg = pct(args.vix1515, args.vixPrevClose);
  let vixScore = 0;
  if (vixChg !== null) {
    if (vixChg <= -C.vixDownPct) vixScore = 1;
    else if (vixChg >= C.vixUpPct) vixScore = -1;
    if (vixChg >= C.vixCautionPct) cautionFlag = true;
  }
  sig.vix = { raw: vixChg, score: vixScore };

  const score = Object.keys(sig).reduce((a, k) => a + sig[k].score * (W[k] || 0), 0);
  return { signals: sig, score, cautionFlag, entryClose: c1500 ? c1500.close : null };
}

// ---------------------------------------------------------------- data loading
async function yahooHourly(sym: string): Promise<Series> {
  const r = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=60m&range=730d`,
    { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const res = r.data?.chart?.result?.[0];
  const ts: number[] = res?.timestamp || [];
  const close: Array<number | null> = res?.indicators?.quote?.[0]?.close || [];
  const out: Series = [];
  for (let i = 0; i < ts.length; i++) { const c = close[i]; if (typeof c === 'number' && c > 0) out.push([ts[i] * 1000, c]); }
  return out;
}

async function kiteFifteenMin(token: number, days: number): Promise<DayCandle[]> {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) throw new Error('no Kite session');
  const out: DayCandle[] = [];
  const CHUNK = 180; // days per request (15-min interval limit is ~200)
  let to = Date.now();
  let remaining = days;
  const chunks: Array<[number, number]> = [];
  while (remaining > 0) {
    const span = Math.min(CHUNK, remaining);
    chunks.unshift([to - span * 86400000, to]);
    to -= span * 86400000; remaining -= span;
  }
  for (const [f, t] of chunks) {
    const hist = await kc.getHistoricalData(token, '15minute', toISTString(f), toISTString(t));
    for (const c of hist || []) {
      const tt = new Date(c.date).getTime();
      out.push({ t: tt, open: c.open, high: c.high, low: c.low, close: c.close });
    }
    await new Promise(r => setTimeout(r, 400)); // pace the historical API
  }
  out.sort((a, b) => a.t - b.t);
  // de-dupe on timestamp (chunk edges overlap)
  return out.filter((c, i) => i === 0 || c.t !== out[i - 1].t);
}

// ---------------------------------------------------------------- job runner
const job: { status: string; startedAt: number | null; progress: string; error: string | null } =
  { status: 'idle', startedAt: null, progress: '', error: null };

async function runBacktest(db: any, days: number) {
  job.status = 'running'; job.startedAt = Date.now(); job.error = null;
  try {
    job.progress = 'fetching NIFTY 15-min history…';
    const nifty = await kiteFifteenMin(256265, days);
    job.progress = 'fetching INDIA VIX 15-min history…';
    const vix = await kiteFifteenMin(264969, days);
    job.progress = 'fetching 6 external hourly series…';
    const ext: Record<string, Series> = {};
    for (const [k, sym] of Object.entries(GAP_CONFIG.yahooSymbols)) {
      ext[k] = await yahooHourly(sym);
      await new Promise(r => setTimeout(r, 300));
    }

    // group NIFTY + VIX candles by IST calendar day
    const dayKey = (t: number) => { const x = new Date(t + IST_MS); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };
    const nByDay = new Map<string, DayCandle[]>(); for (const c of nifty) { const k = dayKey(c.t); if (!nByDay.has(k)) nByDay.set(k, []); nByDay.get(k)!.push(c); }
    const vByDay = new Map<string, DayCandle[]>(); for (const c of vix) { const k = dayKey(c.t); if (!vByDay.has(k)) vByDay.set(k, []); vByDay.get(k)!.push(c); }
    const tradingDays = [...nByDay.keys()].sort();

    // events (for event-day split — historical entries only if the user logged them)
    const eventDates = new Set<string>((db.prepare('SELECT dateIST FROM gap_events').all() as any[]).map(r => r.dateIST));

    job.progress = `scoring ${tradingDays.length} days…`;
    type Row = { date: string; score: number; caution: boolean; event: boolean; gapPct: number | null; cls: string | null; entry: number | null; exit: number | null };
    const rows: Row[] = [];
    for (let i = 0; i < tradingDays.length - 1; i++) {
      const d = tradingDays[i]; const nx = tradingDays[i + 1];
      const [y, m, dd] = d.split('-').map(Number);
      const dayUtc0 = Date.UTC(y, m - 1, dd);
      const prevDay = i > 0 ? tradingDays[i - 1] : null;
      const vixPrevArr = prevDay ? vByDay.get(prevDay) : null;
      const vArr = vByDay.get(d) || [];
      const v1500 = vArr.find(c => new Date(c.t + IST_MS).getUTCHours() === 15 && new Date(c.t + IST_MS).getUTCMinutes() === 0);
      const s = scoreDay({
        dayUtc0, nifty: nByDay.get(d)!,
        vixPrevClose: vixPrevArr && vixPrevArr.length ? vixPrevArr[vixPrevArr.length - 1].close : null,
        vix1515: v1500 ? v1500.close : null,
        es: ext.es, nq: ext.nq, dax: ext.dax, ftse: ext.ftse, brent: ext.brent, usdinr: ext.usdinr,
      });
      const todayArr = nByDay.get(d)!; const nextArr = nByDay.get(nx)!;
      const prevClose = todayArr[todayArr.length - 1].close;
      const nextOpen = nextArr[0].open;
      const gapPct = prevClose ? +(((nextOpen - prevClose) / prevClose) * 100).toFixed(3) : null;
      const th = GAP_CONFIG.gapClassThresholdPct;
      const cls = gapPct === null ? null : gapPct >= th ? 'gap-up' : gapPct <= -th ? 'gap-down' : 'flat';
      rows.push({ date: d, score: s.score, caution: s.cautionFlag, event: eventDates.has(d) || eventDates.has(nx), gapPct, cls, entry: s.entryClose, exit: nextArr[0].close });
    }

    // ---- evaluation
    const evalAt = (rs: Row[], threshold: number) => {
      const fired = rs.filter(r => Math.abs(r.score) >= threshold && !r.caution && !r.event && r.cls !== null);
      const hits = fired.filter(r => (r.score > 0 && r.cls === 'gap-up') || (r.score < 0 && r.cls === 'gap-down')).length;
      return { threshold, fired: fired.length, hits, hitRate: fired.length ? +(hits / fired.length * 100).toFixed(1) : null };
    };
    const bucket = (min: number) => {
      const b = rows.filter(r => Math.abs(r.score) >= min && r.cls !== null);
      const hits = b.filter(r => (r.score > 0 && r.cls === 'gap-up') || (r.score < 0 && r.cls === 'gap-down')).length;
      const gaps = b.map(r => r.gapPct as number);
      const avg = gaps.length ? +(gaps.reduce((a, x) => a + x, 0) / gaps.length).toFixed(3) : null;
      const med = gaps.length ? +([...gaps].sort((a, x) => a - x)[Math.floor(gaps.length / 2)]).toFixed(3) : null;
      return { minScore: min, days: b.length, hits, hitRate: b.length ? +(hits / b.length * 100).toFixed(1) : null, avgGapPct: avg, medianGapPct: med };
    };
    // confusion matrix at the live threshold
    const liveTh = GAP_CONFIG.decisionThreshold;
    const firedLive = rows.filter(r => Math.abs(r.score) >= liveTh && !r.caution && !r.event && r.cls !== null);
    const cm = { predUp: { up: 0, down: 0, flat: 0 }, predDown: { up: 0, down: 0, flat: 0 } };
    for (const r of firedLive) {
      const side = r.score > 0 ? cm.predUp : cm.predDown;
      side[r.cls === 'gap-up' ? 'up' : r.cls === 'gap-down' ? 'down' : 'flat']++;
    }
    // event vs normal split
    const evSplit = {
      eventDays: evalAt(rows.filter(r => r.event).map(r => ({ ...r, event: false })), liveTh),
      normalDays: evalAt(rows.filter(r => !r.event), liveTh),
      note: eventDates.size === 0 ? 'no historical events logged in gapEvents — event split is empty' : undefined,
    };
    // equity curve at live threshold, non-event days
    let eq = 0; const curve: Array<{ date: string; eq: number }> = [];
    for (const r of rows) {
      if (Math.abs(r.score) >= liveTh && !r.caution && !r.event && r.entry !== null && r.exit !== null) {
        const dir = r.score > 0 ? 1 : -1;
        eq += dir * (r.exit - r.entry) - GAP_CONFIG.costsPts;
        curve.push({ date: r.date, eq: +eq.toFixed(1) });
      }
    }
    // walk-forward: fit threshold on first 60%, validate on last 40%
    const cut = Math.floor(rows.length * 0.6);
    const train = rows.slice(0, cut), test = rows.slice(cut);
    let bestTh = liveTh, bestScore = -1;
    for (const th of [3, 4, 5, 6, 7]) {
      const e = evalAt(train, th);
      // sample floor: don't fit to a threshold that fired fewer than 8 times
      if (e.fired >= 8 && (e.hitRate ?? 0) > bestScore) { bestScore = e.hitRate ?? 0; bestTh = th; }
    }
    const walkForward = { fittedThreshold: bestTh, train: evalAt(train, bestTh), test: evalAt(test, bestTh), liveThresholdTest: evalAt(test, liveTh) };

    const result = {
      generatedAt: Date.now(),
      daysAnalyzed: rows.length,
      firstDay: rows[0]?.date, lastDay: rows[rows.length - 1]?.date,
      maxAbsScore: 7,
      excludedSignals: ['basis (expired futures history unavailable via Kite)', 'breadth (optional per spec; skipped)'],
      approximations: [
        'external series: Yahoo 60m bars, nearest-bar-at-or-before readings',
        'prior US settlement ≈ last bar ≤ 20:00 UTC prev day (±1h DST)',
        'equity: entry = 15:00-15:15 candle close, exit = next day first candle close, −3 pts costs',
      ],
      buckets: [bucket(3), bucket(5), bucket(7)],
      confusionAtLiveThreshold: cm,
      eventSplit: evSplit,
      equity: { trades: curve.length, finalPts: curve.length ? curve[curve.length - 1].eq : 0, curve: curve.slice(-120) },
      walkForward,
    };
    db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run('backtest', JSON.stringify(result), Date.now());
    job.status = 'done'; job.progress = `done: ${rows.length} days`;
    console.log('[gap-backtest] complete:', rows.length, 'days');
  } catch (e: any) {
    job.status = 'error'; job.error = e?.message || String(e);
    console.error('[gap-backtest] failed:', e);
  }
}

export function registerGapBacktest(app: any, db: any, guard: any) {
  app.post('/api/gap/backtest/start', express.json(), guard, (req: any, res: any) => {
    if (job.status === 'running') return res.json({ started: false, job });
    const days = Math.min(730, parseInt(String(req.body?.days || '730'), 10) || 730);
    runBacktest(db, days); // async, fire-and-monitor
    res.json({ started: true, days, note: 'poll /api/gap/backtest/status' });
  });
  app.get('/api/gap/backtest/status', (_req: any, res: any) => {
    const r: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('backtest');
    res.json({ job, result: job.status === 'done' && r ? JSON.parse(r.json) : (r ? { previous: true, summaryAvailable: true } : null) });
  });
}
