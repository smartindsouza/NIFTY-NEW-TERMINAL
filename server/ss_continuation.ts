// SS continuation — FORWARD TEST. Logs and grades itself. NEVER trades.
//
// Rule (frozen 6 Oct 2026, text in src/lib/ssResearch.ts SS_CONT_RULE): a 5m + 15m
// Swap-Sweep whose 15-min sweep candle set the day's high/low is traded the OTHER
// way (with the sweep), 2R, exit by the day's close, 2 points cost.
//
// Two pieces of evidence, both on days the idea was never seen on:
//   1. A ONE-TIME past check on the research hold-out (26 Feb – 6 Oct 2026). It
//      refuses to run a second time, so it cannot be re-rolled until it looks good.
//   2. A live log from 7 Oct 2026: every weekday after the close the job grades the
//      last few days (catching up on any it missed). A graded signal is never
//      rewritten. The verdict waits for 30 signals.
// No order path is touched from this module.

import cron from 'node-cron';
import { kiteFiveMin } from './sweep_reclaim';
import { kiteFifteenMin } from './gap_backtest';
import { istDateStr } from './gap_scorecard';
import { isNseHoliday } from './calendar_service';
import { ssContinuationTrades, ssContScore, SS_CONT_RULE } from '../src/lib/ssResearch';
import { ssIstDay } from '../src/lib/swapSweep';

const istNowMin = () => { const x = new Date(Date.now() + 19800000); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const todayNum = () => ssIstDay(Math.floor(Date.now() / 1000));
const fmtDay = (d: number) => { const s = String(d); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };

const holdJob = { status: 'idle', error: null as string | null };

export async function logRecent(db: any) {
  const c5 = await kiteFiveMin(256265, 8);
  const c15 = await kiteFifteenMin(256265, 8);
  const today = todayNum(), closed = istNowMin() >= 935;          // index closes 15:30; grade after 15:35
  const ins = db.prepare(`INSERT OR IGNORE INTO ss_cont_signals
    (time, day, dir, entry, stop, target, exit_px, exit_time, outcome, r, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  for (const t of ssContinuationTrades(c5, c15)) {
    const d = ssIstDay(t.time);
    if (d < SS_CONT_RULE.liveFrom || d > today || (d === today && !closed)) continue;
    const r = ins.run(t.time, fmtDay(d), t.kind === 'bull' ? 'LONG' : 'SHORT', t.entry, t.stop, t.target, t.exit, t.exitTime, t.outcome, t.r, Date.now());
    added += r.changes;
  }
  return { added };
}

async function runHoldoutOnce(db: any) {
  holdJob.status = 'running'; holdJob.error = null;
  try {
    const c5 = await kiteFiveMin(256265, 400);
    const c15 = await kiteFifteenMin(256265, 400);
    const trades = ssContinuationTrades(c5, c15).filter((t) => {
      const d = ssIstDay(t.time); return d >= SS_CONT_RULE.holdoutFrom && d <= SS_CONT_RULE.holdoutTo;
    });
    const result = { ranAt: Date.now(), from: fmtDay(SS_CONT_RULE.holdoutFrom), to: fmtDay(SS_CONT_RULE.holdoutTo),
      score: ssContScore(trades.map((t) => t.r)), longs: trades.filter((t) => t.kind === 'bull').length, shorts: trades.filter((t) => t.kind === 'bear').length };
    db.prepare('INSERT OR IGNORE INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?)').run('ss_cont_holdout', JSON.stringify(result), Date.now());
    holdJob.status = 'done';
  } catch (e: any) { holdJob.status = 'error'; holdJob.error = e?.message || String(e); }
}

export function registerSsContinuation(app: any, db: any, guard: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS ss_cont_signals (
    time INTEGER PRIMARY KEY, day TEXT, dir TEXT, entry REAL, stop REAL, target REAL,
    exit_px REAL, exit_time INTEGER, outcome TEXT, r REAL, created_at INTEGER
  );`);

  cron.schedule('50 15 * * 1-5', async () => {
    if (isNseHoliday(istDateStr())) return;
    try { const r = await logRecent(db); console.log('[ss-cont] logged', r.added); } catch (e) { console.error('[ss-cont] log failed', e); }
  }, { timezone: 'Asia/Kolkata' });

  app.get('/api/ss/continuation', (_req: any, res: any) => {
    try {
      const rows: any[] = db.prepare('SELECT * FROM ss_cont_signals ORDER BY time').all();
      const h: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('ss_cont_holdout');
      res.json({ rule: SS_CONT_RULE, live: ssContScore(rows.map((r) => r.r)), signals: rows.slice(-50).reverse(),
        holdout: h ? JSON.parse(h.json) : null, holdJob });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/ss/continuation/holdout', guard, (_req: any, res: any) => {
    const h = db.prepare('SELECT 1 FROM gap_stats WHERE key = ?').get('ss_cont_holdout');
    if (h) return res.json({ started: false, reason: 'already run — the past check is one-time only' });
    if (holdJob.status === 'running') return res.json({ started: false, reason: 'running' });
    runHoldoutOnce(db); res.json({ started: true });
  });
  app.get('/api/ss/continuation/log-now', guard, async (_req: any, res: any) => {
    try { res.json(await logRecent(db)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  console.log('[ss-cont] forward test registered — logs signals, never trades');
}
