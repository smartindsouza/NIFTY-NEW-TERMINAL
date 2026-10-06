// Swap-Sweep filter research — server job. Pulls ~2 years of NIFTY 5-min and
// 15-min history from Kite (chunked, paced), runs the pure research in
// src/lib/ssResearch.ts (rules, split and pass bar fixed in advance there), and
// stores the result. Started by a button on the Backtesting screen; read-only status.

import { kiteFiveMin } from './sweep_reclaim';
import { kiteFifteenMin } from './gap_backtest';
import { runSsResearch } from '../src/lib/ssResearch';

const job: { status: string; startedAt: number | null; progress: string; error: string | null } =
  { status: 'idle', startedAt: null, progress: '', error: null };

async function runJob(db: any, days: number) {
  job.status = 'running'; job.startedAt = Date.now(); job.error = null;
  try {
    job.progress = 'fetching NIFTY 5-min history (about 2 years)…';
    const c5 = await kiteFiveMin(256265, days);
    job.progress = 'fetching NIFTY 15-min history…';
    const c15 = await kiteFifteenMin(256265, days);
    job.progress = 'testing filters…';
    const result = { generatedAt: Date.now(), candles5: c5.length, candles15: c15.length, ...runSsResearch(c5, c15) };
    db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run('ss_research', JSON.stringify(result), Date.now());
    job.status = 'done'; job.progress = `done: ${result.period.signals} signals over ${result.period.days} days`;
  } catch (e: any) {
    job.status = 'error'; job.error = e?.message || String(e);
    console.error('[ss-research] failed:', e);
  }
}

export function registerSsResearch(app: any, db: any, guard: any) {
  app.post('/api/ss/research/start', guard, (_req: any, res: any) => {
    if (job.status === 'running') return res.json({ started: false, job });
    runJob(db, 730);
    res.json({ started: true, job });
  });
  app.get('/api/ss/research/status', (_req: any, res: any) => {
    const r: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('ss_research');
    res.json({ job, result: r ? JSON.parse(r.json) : null });
  });
  console.log('[ss-research] Swap-Sweep filter research registered');
}
