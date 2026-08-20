// Inside-bar break — FORWARD TEST. Records signals and grades itself. Never trades.
//
// WHY THIS IS ONLY A LOGGER. The 1,728-rule search (pa_search) failed its
// pre-registered bar. This rule family was NOT the declared winner — it was
// spotted in the top-ten list AFTER the test half had been looked at, which is
// precisely the mistake that manufactures strategies that lose money later. Both
// halves of history are now contaminated by having been examined, so the only
// clean evidence left is data that does not exist yet. Hence: log it live, grade
// it honestly, decide after ~30-40 signals. No order is ever placed from here.
//
// THE RULE IS FROZEN. It is the best of the four inside-bar variants exactly as
// the search found it (train avg +8.16 over 136 trades, test avg +12.58 over 97).
// Nothing here may be tuned while the forward test runs — adjusting a rule after
// watching it perform is how a forward test quietly becomes another backtest.

import express from 'express';
import cron from 'node-cron';
import { getKiteClient } from './kite_service';
import { istDateStr, toISTString } from './gap_scorecard';
import { isNseHoliday } from './calendar_service';
import { optionPnl, PA_COST } from './pa_search';

const IST_MS = 5.5 * 3600 * 1000;
const minOfDay = (t: number) => { const x = new Date(t + IST_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };

export const IB_RULE = {
  trigger: 'insideBreak',
  location: 'nearRound',     // within 15 pts of a round-100 level
  trend: 'none',
  windowFrom: 660, windowTo: 810,  // 11:00 - 13:30 IST, candle START minute
  stop: 'atr14',
  target: 'eod',             // hold to the 15:00 candle's close
  roundTolPts: 15,
  exitFromMin: 900,          // 15:00
  maxPerDay: 1,
  frozenOn: '2026-08-20',
};

export type Bar = { t: number; open: number; high: number; low: number; close: number };
export type IbSignal = {
  date: string; firedAtMin: number; dir: 'LONG' | 'SHORT';
  entry: number; stop: number; level: number; atr: number; riskPts: number;
};

// ---------------------------------------------------------------- pure logic
export function atr14(bars: Bar[], upto: number): number {
  let atr = bars[0].high - bars[0].low;
  for (let i = 1; i <= upto; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    atr = (atr * 13 + tr) / 14;
  }
  return atr;
}

/** First qualifying signal of the day, or null. Only CLOSED bars may be passed. */
export function detectInsideBarSignal(date: string, bars: Bar[]): IbSignal | null {
  const R = IB_RULE;
  if (!bars || bars.length < 4) return null;
  for (let i = 3; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1], pp = bars[i - 2];
    const m = minOfDay(b.t);
    if (m <= R.windowFrom || m > R.windowTo) continue;          // midday only
    if (!(p.high <= pp.high && p.low >= pp.low)) continue;      // prior bar must be INSIDE
    const dir: 'LONG' | 'SHORT' | null = b.close > p.high ? 'LONG' : b.close < p.low ? 'SHORT' : null;
    if (!dir) continue;                                          // must CLOSE beyond it
    const nearestRound = Math.round(b.close / 100) * 100;
    if (Math.abs(b.close - nearestRound) > R.roundTolPts) continue; // near a round number
    const a = atr14(bars, i);
    if (!(a > 0)) continue;
    const entry = b.close;
    const stop = dir === 'LONG' ? entry - a : entry + a;
    return {
      date, firedAtMin: m, dir, entry: +entry.toFixed(2), stop: +stop.toFixed(2),
      level: nearestRound, atr: +a.toFixed(2), riskPts: +a.toFixed(2),
    };
  }
  return null;
}

/** Grade a recorded signal against the rest of the day. Stop assumed first when ambiguous. */
export function gradeSignal(sig: IbSignal, bars: Bar[]) {
  const R = IB_RULE;
  const long = sig.dir === 'LONG';
  let exit: number | null = null, reason = '', exitMin = sig.firedAtMin;
  for (const b of bars) {
    const m = minOfDay(b.t);
    if (m <= sig.firedAtMin) continue;
    exitMin = m;
    const stopHit = long ? b.low <= sig.stop : b.high >= sig.stop;
    if (stopHit) { exit = sig.stop; reason = 'STOP'; break; }
    if (m >= R.exitFromMin) { exit = b.close; reason = 'EOD'; break; }
  }
  if (exit === null) {
    const last = bars[bars.length - 1];
    if (!last) return null;
    exit = last.close; reason = 'EOD'; exitMin = minOfDay(last.t);
  }
  const indexPts = +(long ? exit - sig.entry : sig.entry - exit).toFixed(2);
  return {
    exit: +exit.toFixed(2), exitReason: reason, heldMin: exitMin - sig.firedAtMin,
    indexPts,
    // What it would have been worth on the contract actually traded, not in index
    // points — the distinction that killed most rules in the search.
    optionPts: optionPnl(indexPts, exitMin - sig.firedAtMin),
  };
}

// ---------------------------------------------------------------- data
async function todaysBars(): Promise<Bar[]> {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) throw new Error('no Kite session');
  const istStr = (ms: number) => {
    const x = new Date(ms + IST_MS);
    return x.toISOString().slice(0, 10) + ' ' + x.toISOString().slice(11, 19);
  };
  const raw = await kc.getHistoricalData(256265, '5minute', istStr(Date.now() - 86400000), istStr(Date.now()));
  const today = istDateStr();
  return (raw || [])
    .map((c: any) => ({ t: new Date(c.date).getTime(), open: c.open, high: c.high, low: c.low, close: c.close }))
    .filter((b: Bar) => {
      const x = new Date(b.t + IST_MS);
      return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}` === today;
    });
}

// ---------------------------------------------------------------- jobs
export async function scanForSignal(db: any): Promise<any> {
  const date = istDateStr();
  const existing = db.prepare('SELECT * FROM ib_signals WHERE date = ?').get(date);
  if (existing) return { skipped: 'already have today\'s signal', date };
  const bars = await todaysBars();
  // Only CLOSED bars: the forming one is dropped, so nothing is ever detected
  // using a candle the market had not finished printing.
  const nowMin = minOfDay(Date.now());
  const closed = bars.filter(b => minOfDay(b.t) + 5 <= nowMin);
  const sig = detectInsideBarSignal(date, closed);
  if (!sig) return { signal: null, date, barsChecked: closed.length };
  db.prepare(`INSERT INTO ib_signals (date, fired_at_min, dir, entry, stop, level, atr, risk_pts, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`)
    .run(date, sig.firedAtMin, sig.dir, sig.entry, sig.stop, sig.level, sig.atr, sig.riskPts, Date.now());
  console.log(`[inside-bar] signal ${sig.dir} @ ${sig.entry} (level ${sig.level}) — logged, NOT traded`);
  return { signal: sig, date };
}

export async function gradeToday(db: any): Promise<any> {
  const date = istDateStr();
  const row: any = db.prepare('SELECT * FROM ib_signals WHERE date = ? AND status = ?').get(date, 'OPEN');
  if (!row) return { skipped: 'nothing open to grade', date };
  const bars = await todaysBars();
  const sig: IbSignal = {
    date: row.date, firedAtMin: row.fired_at_min, dir: row.dir, entry: row.entry,
    stop: row.stop, level: row.level, atr: row.atr, riskPts: row.risk_pts,
  };
  const g = gradeSignal(sig, bars);
  if (!g) return { skipped: 'no bars to grade against', date };
  db.prepare(`UPDATE ib_signals SET status='GRADED', exit_px=?, exit_reason=?, held_min=?, index_pts=?, option_pts=?, graded_at=? WHERE date=?`)
    .run(g.exit, g.exitReason, g.heldMin, g.indexPts, g.optionPts, Date.now(), date);
  console.log(`[inside-bar] graded ${date}: ${g.indexPts} index pts → ${g.optionPts} after option costs`);
  return { date, ...g };
}

export function ibScorecard(db: any) {
  const rows: any[] = db.prepare('SELECT * FROM ib_signals WHERE status = ? ORDER BY date').all('GRADED');
  const n = rows.length;
  if (!n) return { n: 0, verdict: 'no graded signals yet — needs ~30-40 to mean anything' };
  const tot = rows.reduce((a, r) => a + (r.option_pts || 0), 0);
  const avg = tot / n;
  const sd = Math.sqrt(rows.reduce((a, r) => a + ((r.option_pts || 0) - avg) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0, peak = 0, mdd = 0;
  for (const r of rows) { eq += r.option_pts || 0; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
  return {
    n,
    winRate: +(rows.filter(r => (r.option_pts || 0) > 0).length / n * 100).toFixed(1),
    totalOptionPts: +tot.toFixed(1), avgOptionPts: +avg.toFixed(2),
    maxDrawdownPts: +mdd.toFixed(1),
    tStat: sd > 0 ? +(avg / (sd / Math.sqrt(n))).toFixed(2) : null,
    byDirection: {
      long: rows.filter(r => r.dir === 'LONG').length,
      short: rows.filter(r => r.dir === 'SHORT').length,
    },
    backtestExpectation: { trainAvg: 8.16, testAvg: 12.58, note: 'what the search saw; the live number is the honest one' },
    verdict: n < 30
      ? `${n}/30 signals — too early to judge`
      : avg > 0
        ? 'positive so far on data nobody mined — worth ONE small lot, still not proof'
        : 'negative on fresh data — the backtest edge has not shown up live',
  };
}

export function registerInsideBar(app: any, db: any, guard: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS ib_signals (
    date TEXT PRIMARY KEY, fired_at_min INTEGER, dir TEXT, entry REAL, stop REAL,
    level REAL, atr REAL, risk_pts REAL, status TEXT DEFAULT 'OPEN',
    exit_px REAL, exit_reason TEXT, held_min INTEGER, index_pts REAL, option_pts REAL,
    created_at INTEGER, graded_at INTEGER
  );`);

  // Scan every 5 minutes through the midday window only. The rule is frozen; this
  // simply watches for it. It writes a row and nothing else — no order path is
  // touched from this module at all.
  cron.schedule('*/5 11-13 * * 1-5', async () => {
    const d = istDateStr();
    if (isNseHoliday(d)) return;
    try { await scanForSignal(db); } catch (e) { console.error('[inside-bar] scan failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  // Grade after the 15:00 exit bar has closed.
  cron.schedule('20 15 * * 1-5', async () => {
    const d = istDateStr();
    if (isNseHoliday(d)) return;
    try { await gradeToday(db); } catch (e) { console.error('[inside-bar] grading failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  app.get('/api/inside-bar', (_req: any, res: any) => {
    try {
      const rows = db.prepare('SELECT * FROM ib_signals ORDER BY date DESC LIMIT 100').all();
      res.json({
        rule: IB_RULE,
        costModel: PA_COST,
        status: 'FORWARD TEST — signals are logged and graded, never traded',
        scorecard: ibScorecard(db),
        signals: rows.map((r: any) => ({
          ...r,
          firedAt: `${String(Math.floor(r.fired_at_min / 60)).padStart(2, '0')}:${String(r.fired_at_min % 60).padStart(2, '0')} IST`,
        })),
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Manual triggers for testing the plumbing.
  app.get('/api/inside-bar/scan', guard, async (_req: any, res: any) => {
    try { res.json(await scanForSignal(db)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/inside-bar/grade', guard, async (_req: any, res: any) => {
    try { res.json(await gradeToday(db)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('[inside-bar] forward test registered — logs signals, never trades');
}
