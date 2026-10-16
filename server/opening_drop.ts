// Opening drop — FORWARD TEST. Logs and grades itself every trading day after the
// close. NEVER trades. Rule and grading: src/lib/patternLab.ts (OPENING_FWD).

import cron from 'node-cron';
import { kiteFiveMin } from './sweep_reclaim';
import { istDateStr } from './gap_scorecard';
import { isNseHoliday } from './calendar_service';
import { gradeOpeningDrops, OPENING_FWD, PATTERN_DRAFT, type PC } from '../src/lib/patternLab';
import { ssContScore } from '../src/lib/ssResearch';
import { ssIstDay } from '../src/lib/swapSweep';

const fmtDay = (d: number) => { const s = String(d); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };

export async function logOpeningDrops(db: any) {
  const raw = await kiteFiveMin(256265, 10);
  const c: PC[] = raw.map((k: any) => ({ time: Math.floor(k.t / 1000), open: k.open, high: k.high, low: k.low, close: k.close }));
  const today = ssIstDay(Math.floor(Date.now() / 1000));
  const istMin = Math.floor(((Date.now() / 1000 + 19800) % 86400) / 60);
  const ins = db.prepare(`INSERT OR IGNORE INTO opening_drop_log (time, day, entry, stop, target, exit_px, outcome, r, fall_first, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  for (const g of gradeOpeningDrops(c)) {
    if (g.day > today || (g.day === today && istMin < 935)) continue;      // grade a day only after its close
    added += ins.run(g.time, fmtDay(g.day), g.entry, g.stop, g.target, g.exit, g.outcome, g.r, g.fallFirst === null ? null : g.fallFirst ? 1 : 0, Date.now()).changes;
  }
  return { added };
}

export function registerOpeningDrop(app: any, db: any, guard: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS opening_drop_log (
    time INTEGER PRIMARY KEY, day TEXT, entry REAL, stop REAL, target REAL, exit_px REAL,
    outcome TEXT, r REAL, fall_first INTEGER, created_at INTEGER
  );`);
  cron.schedule('52 15 * * 1-5', async () => {
    if (isNseHoliday(istDateStr())) return;
    try { const r = await logOpeningDrops(db); console.log('[opening-drop] logged', r.added); } catch (e) { console.error('[opening-drop] log failed', e); }
  }, { timezone: 'Asia/Kolkata' });
  app.get('/api/opening-drop', (_req: any, res: any) => {
    try {
      const rows: any[] = db.prepare('SELECT * FROM opening_drop_log ORDER BY time').all();
      const decided = rows.filter((r) => r.fall_first !== null);
      res.json({
        rule: { frozenOn: OPENING_FWD.frozenOn, liveFrom: fmtDay(OPENING_FWD.liveFrom), minSignals: OPENING_FWD.minSignals, text: PATTERN_DRAFT.text[2] },
        backtest: { signals: 119, fallFirst: 54.39, randomFallFirst: 50.99, avgR: 0.12, luck: 0.22, note: '2-year test, Oct 2024 – Aug 2026' },
        live: ssContScore(rows.map((r) => r.r)),
        fallFirst: decided.length ? Math.round(decided.filter((r) => r.fall_first === 1).length / decided.length * 1000) / 10 : null,
        signals: rows.slice(-50).reverse(),
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/opening-drop/log-now', guard, async (_req: any, res: any) => {
    try { res.json(await logOpeningDrops(db)); } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  console.log('[opening-drop] forward test registered — logs signals, never trades');
}
