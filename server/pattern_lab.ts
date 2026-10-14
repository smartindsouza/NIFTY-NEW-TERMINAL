// Pattern Lab — server side. Stores Martin's hand-picked pattern examples (date +
// marked-candle time, IST, NIFTY 5-min) and returns, for each, the EXACT Zerodha
// candles around it plus the draft-rule analysis from src/lib/patternLab.ts.
// Read-only towards the market: no order path is touched.

import express from 'express';
import { getKiteClient } from './kite_service';
import { toISTString } from './gap_scorecard';
import { analyzeExample, runPatternTest, PATTERN_DRAFT, PATTERN_TEST, RULE_LABEL, type PC } from '../src/lib/patternLab';
import { kiteFiveMin } from './sweep_reclaim';
import { ssIstDay } from '../src/lib/swapSweep';

// The 11 bearish examples Martin sent on 13-14 Oct 2026 (seeded ONCE; deleting one
// in the app is permanent).
const SEED_BEAR: Array<[string, string]> = [
  ['2026-09-09', '13:55'], ['2026-09-17', '12:35'], ['2026-09-22', '10:05'], ['2026-09-30', '13:20'],
  ['2026-10-01', '11:50'], ['2026-10-05', '09:45'], ['2026-10-07', '11:55'], ['2026-10-08', '09:15'],
  ['2026-10-12', '09:20'], ['2026-10-14', '10:50'], ['2026-10-14', '12:10'],
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const toSec = (day: string, time: string) => {
  const [y, m, d] = day.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000) - 19800;
};
const dayNum = (day: string) => Number(day.replace(/-/g, ''));

// Candles per IST trading day (yyyymmdd). Past days are final and kept; today is refetched.
const dayCache = new Map<number, PC[]>();

async function fetch5m(fromMs: number, toMs: number): Promise<PC[]> {
  const kc = getKiteClient();
  // @ts-ignore
  if (!kc || !kc.access_token) throw new Error('Zerodha is not connected');
  const out: PC[] = [];
  const CHUNK = 90 * 86400000;
  for (let f = fromMs; f < toMs; f += CHUNK) {
    const t = Math.min(toMs, f + CHUNK);
    const hist = await kc.getHistoricalData(256265, '5minute', toISTString(f), toISTString(t));
    for (const c of hist || []) out.push({ time: Math.floor(new Date(c.date).getTime() / 1000), open: +c.open, high: +c.high, low: +c.low, close: +c.close });
    await new Promise((r) => setTimeout(r, 400));
  }
  out.sort((a, b) => a.time - b.time);
  return out.filter((c, i) => i === 0 || c.time !== out[i - 1].time);
}

/** Candles covering every example day plus a week before the earliest (for ATR). */
async function candlesFor(days: string[]): Promise<PC[]> {
  const today = ssIstDay(Math.floor(Date.now() / 1000));
  const nums = [...new Set(days.map(dayNum))].sort((a, b) => a - b);
  const need = nums.some((d) => d >= today || !dayCache.has(d));
  if (need && nums.length) {
    const first = days.reduce((a, b) => (a < b ? a : b)), last = days.reduce((a, b) => (a > b ? a : b));
    const fromMs = toSec(first, '00:00') * 1000 - 7 * 86400000;
    const toMs = Math.min(Date.now(), toSec(last, '23:59') * 1000);
    const got = await fetch5m(fromMs, toMs);
    const byDay = new Map<number, PC[]>();
    for (const c of got) { const d = ssIstDay(c.time); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(c); }
    for (const [d, list] of byDay) if (d < today) dayCache.set(d, list);
    for (const d of nums) if (d < today && !byDay.has(d)) dayCache.set(d, []);   // holiday / no data: do not refetch it every time
    // assemble from this fetch (it includes today's candles, which are not cached)
    return got;
  }
  const all: PC[] = [];
  const keys = [...dayCache.keys()].sort((a, b) => a - b);
  for (const k of keys) all.push(...dayCache.get(k)!);
  return all;
}

// The 2-year test of the approved rules (draft 2). Server job; the result is stored.
const testJob: { status: string; progress: string; error: string | null } = { status: 'idle', progress: '', error: null };
async function runTestJob(db: any) {
  testJob.status = 'running'; testJob.error = null;
  try {
    testJob.progress = 'fetching ~2 years of NIFTY 5-min candles…';
    const raw = await kiteFiveMin(256265, 730);
    testJob.progress = 'testing the rules…';
    const c: PC[] = raw.map((k: any) => ({ time: Math.floor(k.t / 1000), open: k.open, high: k.high, low: k.low, close: k.close }));
    const result = { generatedAt: Date.now(), rulesVersion: PATTERN_DRAFT.version, ...runPatternTest(c) };
    db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run('pattern_test', JSON.stringify(result), Date.now());
    testJob.status = 'done'; testJob.progress = '';
  } catch (e: any) { testJob.status = 'error'; testJob.error = e?.message || String(e); }
}

export function registerPatternLab(app: any, db: any, guard: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS pattern_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL,
    note TEXT, created_at INTEGER, UNIQUE(side, day, time)
  );`);
  try {
    const seeded = db.prepare('SELECT 1 FROM gap_stats WHERE key = ?').get('pattern_examples_seeded');
    if (!seeded) {
      const ins = db.prepare('INSERT OR IGNORE INTO pattern_examples (side, day, time, note, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const [d, t] of SEED_BEAR) ins.run('bear', d, t, 'sent as a screenshot', Date.now());
      db.prepare('INSERT INTO gap_stats (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
        .run('pattern_examples_seeded', JSON.stringify({ at: Date.now(), n: SEED_BEAR.length }), Date.now());
    }
  } catch (e) { console.error('[pattern-lab] seed failed', e); }

  app.get('/api/patterns/examples', async (req: any, res: any) => {
    const side = req.query.side === 'bull' ? 'bull' : 'bear';
    const rows: any[] = db.prepare('SELECT * FROM pattern_examples WHERE side = ? ORDER BY day DESC, time DESC').all(side);
    let candles: PC[] = [];
    let error: string | null = null;
    try { if (rows.length) candles = await candlesFor(rows.map((r) => r.day)); }
    catch (e: any) { error = e?.message || String(e); }
    const at = new Map<number, number>(); candles.forEach((c, i) => at.set(c.time, i));
    const examples = rows.map((r) => {
      const idx = at.get(toSec(r.day, r.time));
      if (idx === undefined) return { ...r, found: false, analysis: null };
      return { ...r, found: true, analysis: analyzeExample(candles, idx) };
    });
    res.json({
      side, draft: PATTERN_DRAFT, labels: RULE_LABEL, error,
      total: examples.length,
      caught: examples.filter((e: any) => e.analysis?.hit).length,
      examples,
    });
  });

  app.post('/api/patterns/examples', express.json(), guard, (req: any, res: any) => {
    const side = req.body?.side === 'bull' ? 'bull' : 'bear';
    const day = String(req.body?.day || ''), time = String(req.body?.time || '');
    const note = String(req.body?.note || '').slice(0, 200);
    if (!DAY_RE.test(day) || !TIME_RE.test(time)) return res.status(400).json({ ok: false, error: 'Use a date like 2026-10-14 and a time like 10:50' });
    const [hh, mm] = time.split(':').map(Number);
    const mins = hh * 60 + mm;
    if (mm % 5 !== 0 || mins < 555 || mins > 925) return res.status(400).json({ ok: false, error: 'Time must be a 5-minute candle between 09:15 and 15:25' });
    db.prepare('INSERT OR IGNORE INTO pattern_examples (side, day, time, note, created_at) VALUES (?, ?, ?, ?, ?)').run(side, day, time, note || null, Date.now());
    res.json({ ok: true });
  });

  app.delete('/api/patterns/examples/:id', guard, (req: any, res: any) => {
    db.prepare('DELETE FROM pattern_examples WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/patterns/test/start', guard, (_req: any, res: any) => {
    if (testJob.status === 'running') return res.json({ started: false, job: testJob });
    runTestJob(db); res.json({ started: true });
  });
  app.get('/api/patterns/test/status', (_req: any, res: any) => {
    const r: any = db.prepare('SELECT json FROM gap_stats WHERE key = ?').get('pattern_test');
    res.json({ job: testJob, result: r ? JSON.parse(r.json) : null, config: PATTERN_TEST });
  });
  console.log('[pattern-lab] registered');
}
