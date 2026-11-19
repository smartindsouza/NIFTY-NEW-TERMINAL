// Today's Bias — the morning bias note a scheduled Claude task POSTs at ~09:33 IST.
//
//   POST /api/bias                 (X-API-Key header or ?key=, = SNAPSHOT_API_KEY)
//   GET  /api/bias/today           today's (IST) record, or {"status":"pending"}
//   GET  /api/bias/history?days=30 recent records, newest first
//
// Stored in the app's sqlite database (the same file as the Kite session and the
// journal, on the persistent volume), one row per date. A re-post for the same
// date replaces the note but keeps any "outcome" already scored. History is never
// deleted. Display only: nothing here can place or change an order.

import express from 'express';
import { snapshotKeyOk, istIso } from './market_snapshot';

export const istToday = (ms = Date.now()) => istIso(ms).slice(0, 10);

const LEVEL_KEYS = ['trigger', 'invalidation', 'next_reference', 'or_high', 'or_low', 'first_candle_high', 'first_candle_low',
  'prev_high', 'prev_low', 'prev_close', 'cpr_pivot', 'cpr_tc', 'cpr_bc'] as const;
const GAP_KEYS = ['actual_open_pts', 'gift_implied_pts'] as const;
const STATUSES = ['ok', 'error', 'no_session'];
const BIASES = ['bullish', 'bearish', 'neutral'];
const CONFIDENCES = ['low', 'moderate', 'high'];
const READS = ['bullish', 'bearish', 'neutral'];
const TOP_KEYS = ['date', 'generated_at', 'status', 'bias', 'confidence', 'headline', 'summary', 'levels', 'gap', 'factors', 'us30', 'error'];

export type BiasPayload = {
  date: string; generated_at: string; status: 'ok' | 'error' | 'no_session';
  bias: 'bullish' | 'bearish' | 'neutral' | null; confidence: 'low' | 'moderate' | 'high' | null;
  headline: string; summary: string;
  levels: Record<string, number | null> | null; gap: Record<string, number | null> | null;
  factors: { name: string; read: string; note: string }[];
  us30: { close: number | null; change_pts: number | null; change_pct: number | null; driver: string | null } | null;
  error: string | null;
};

const isNumOrNull = (v: any) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isStrOrNull = (v: any) => v === null || typeof v === 'string';

/** Validates and normalises a posted note. Unknown fields are not an error (the
 *  task may add something later) but are reported back as warnings, so a typo in
 *  a field name is visible in the POST response instead of silently lost. */
export function validateBias(b: any): { ok: true; value: BiasPayload; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, errors: ['body must be a JSON object'] };
  for (const k of Object.keys(b)) if (!TOP_KEYS.includes(k)) warnings.push(`unknown field "${k}" ignored`);

  const date = b.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) errors.push('date must be a real date as YYYY-MM-DD');
  if (typeof b.generated_at !== 'string' || Number.isNaN(Date.parse(b.generated_at))) errors.push('generated_at must be an ISO-8601 time');
  if (!STATUSES.includes(b.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
  const bias = b.bias ?? null, confidence = b.confidence ?? null;
  if (bias !== null && !BIASES.includes(bias)) errors.push(`bias must be one of ${BIASES.join(', ')} or null`);
  if (confidence !== null && !CONFIDENCES.includes(confidence)) errors.push(`confidence must be one of ${CONFIDENCES.join(', ')} or null`);
  if (b.status === 'ok' && bias === null) warnings.push('status is "ok" but bias is null');
  if (typeof b.headline !== 'string' || !b.headline.trim()) errors.push('headline must be a non-empty string');
  else if (b.headline.length > 300) errors.push('headline must be at most 300 characters');
  const summary = b.summary ?? '';
  if (typeof summary !== 'string') errors.push('summary must be a string');
  else {
    if (summary.length > 3000) errors.push('summary must be at most 3000 characters');
    const words = summary.trim() ? summary.trim().split(/\s+/).length : 0;
    if (words > 150) warnings.push(`summary has ${words} words (target is 150 or fewer)`);
  }

  const numObj = (name: string, v: any, keys: readonly string[]) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${name} must be an object or null`); return null; }
    const out: Record<string, number | null> = {};
    for (const k of keys) {
      const x = v[k] ?? null;
      if (!isNumOrNull(x)) errors.push(`${name}.${k} must be a number or null`); else out[k] = x;
    }
    for (const k of Object.keys(v)) if (!keys.includes(k)) warnings.push(`unknown field "${name}.${k}" ignored`);
    return out;
  };
  const levels = numObj('levels', b.levels, LEVEL_KEYS);
  const gap = numObj('gap', b.gap, GAP_KEYS);

  let factors: BiasPayload['factors'] = [];
  if (b.factors !== undefined && b.factors !== null) {
    if (!Array.isArray(b.factors)) errors.push('factors must be an array');
    else if (b.factors.length > 30) errors.push('factors can have at most 30 entries');
    else b.factors.forEach((f: any, i: number) => {
      if (!f || typeof f !== 'object') { errors.push(`factors[${i}] must be an object`); return; }
      if (typeof f.name !== 'string' || !f.name.trim()) errors.push(`factors[${i}].name must be a non-empty string`);
      if (!READS.includes(f.read)) errors.push(`factors[${i}].read must be one of ${READS.join(', ')}`);
      if (f.note !== undefined && f.note !== null && typeof f.note !== 'string') errors.push(`factors[${i}].note must be a string`);
      factors.push({ name: String(f.name || '').slice(0, 80), read: f.read, note: String(f.note ?? '').slice(0, 500) });
    });
  }

  let us30: BiasPayload['us30'] = null;
  if (b.us30 !== undefined && b.us30 !== null) {
    const u = b.us30;
    if (typeof u !== 'object' || Array.isArray(u)) errors.push('us30 must be an object or null');
    else {
      for (const k of ['close', 'change_pts', 'change_pct']) if (!isNumOrNull(u[k] ?? null)) errors.push(`us30.${k} must be a number or null`);
      if (!isStrOrNull(u.driver ?? null)) errors.push('us30.driver must be a string or null');
      us30 = { close: u.close ?? null, change_pts: u.change_pts ?? null, change_pct: u.change_pct ?? null, driver: u.driver ? String(u.driver).slice(0, 300) : null };
    }
  }
  const error = b.error ?? null;
  if (!isStrOrNull(error)) errors.push('error must be a string or null');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true, warnings,
    value: { date, generated_at: b.generated_at, status: b.status, bias, confidence, headline: b.headline.trim(),
      summary: String(summary), levels, gap, factors, us30, error: error ? String(error).slice(0, 500) : null },
  };
}

// THE BIAS REVERSES WHEN ITS OWN INVALIDATION LEVEL IS CLOSED THROUGH (19 Nov
// 2026). Martin: "today's bias at 9.32 was bearish. Market has been bullish
// ever since. The bias card on the homepage still shows bearish can you make
// it update the bias when it gets a signal of reversal".
// The note is written once, at about 09:33, and nothing looked at it again.
// It does carry the level at which its own view is wrong — levels.invalidation
// ("invalidation 25256" that morning, the opening range's high) — so that is
// the signal, and nothing new is invented: the first completed 15-minute NIFTY
// candle after the note that CLOSES beyond that level (above it for a bearish
// note, below it for a bullish one) reverses the bias to the other side, at
// that candle's close. A wick through the level is not a close. 15 minutes,
// not 5, so that one sharp candle does not turn the card over — the same
// timeframe his Structure SL reads by default. It happens once in a day: the
// card then says what it reversed to, when, and on what, with the morning's
// note under it as it was written. A neutral note, or one with no
// invalidation level, never reverses. This is arithmetic on the note's own
// level, not a second reading of the market, and it places no order.
export type BiasReversal = { to: 'bullish' | 'bearish'; from: 'bullish' | 'bearish'; level: number; close: number; at: string; candle_start: string; timeframe: 15 };
export function biasReversal(note: { bias: string | null; status: string; generated_at: string; levels: Record<string, number | null> | null },
  candles: { t: number; c: number }[], tfMin = 15): BiasReversal | null {
  if (!note || note.status !== 'ok' || (note.bias !== 'bullish' && note.bias !== 'bearish')) return null;
  const level = note.levels?.invalidation;
  const since = Date.parse(note.generated_at);
  if (typeof level !== 'number' || !Number.isFinite(level) || Number.isNaN(since)) return null;
  for (const k of candles) {
    const end = k.t + tfMin * 60000;
    if (end <= since) continue;                       // closed before the note was written: the note had seen it
    const hit = note.bias === 'bearish' ? k.c > level : k.c < level;
    if (hit) return { to: note.bias === 'bearish' ? 'bullish' : 'bearish', from: note.bias, level, close: k.c, at: istIso(end), candle_start: istIso(k.t), timeframe: 15 };
  }
  return null;
}

const rowToRecord = (r: any) => ({
  ...JSON.parse(r.payload),
  reversal: (() => { try { return r.reversal ? JSON.parse(r.reversal) : null; } catch (e) { return null; } })(),
  received_at: istIso(r.received_at),
  outcome: r.outcome ?? null,
  outcome_note: r.outcome_note ?? null,
});

/** Today's (IST) stored note, or null. Used by the "Check bias" router so the
 *  card under the chart also shows the 09:35 scheduled note. */
export function getTodayBias(db: any): any | null {
  try {
    const r = db.prepare('SELECT * FROM daily_bias WHERE date = ?').get(istToday());
    return r ? rowToRecord(r) : null;
  } catch (e) { return null; }
}

export function registerBias(app: any, db: any, deps?: { niftyCandles15?: (now: number) => Promise<{ t: number; c: number }[]> }) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_bias (
    date TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    bias TEXT,
    confidence TEXT,
    headline TEXT,
    generated_at TEXT,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    post_count INTEGER NOT NULL DEFAULT 1,
    outcome TEXT,          -- nullable: scored later (e.g. "worked" / "failed" / "mixed")
    outcome_note TEXT
  );`);

  try { db.exec('ALTER TABLE daily_bias ADD COLUMN reversal TEXT'); } catch (e) { /* column exists */ }

  const upsert = db.prepare(`INSERT INTO daily_bias (date, status, bias, confidence, headline, generated_at, payload, received_at, updated_at)
    VALUES (@date, @status, @bias, @confidence, @headline, @generated_at, @payload, @now, @now)
    ON CONFLICT(date) DO UPDATE SET status = excluded.status, bias = excluded.bias, confidence = excluded.confidence,
      headline = excluded.headline, generated_at = excluded.generated_at, payload = excluded.payload,
      received_at = excluded.received_at, updated_at = excluded.updated_at, post_count = daily_bias.post_count + 1, reversal = NULL`);
  // reversal IS cleared by a re-post: it belonged to the note that was replaced, and is worked out again for the new one.
  // outcome / outcome_note are deliberately NOT in the update list: a re-post
  // replaces the note, never a score already given to that day.

  const jsonBody = express.json({ limit: '50kb' });
  app.post('/api/bias', (req: any, res: any, next: any) => {
    res.setHeader('Cache-Control', 'no-store');
    const key = req.get('x-api-key') ?? req.query?.key;
    if (!snapshotKeyOk(key)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    jsonBody(req, res, (err: any) => {
      if (err) {
        const tooBig = err.type === 'entity.too.large';
        return res.status(tooBig ? 413 : 400).json({ ok: false, error: tooBig ? 'body larger than 50 KB' : 'body is not valid JSON' });
      }
      next();
    });
  }, (req: any, res: any) => {
    const v = validateBias(req.body);
    if (v.ok !== true) return res.status(400).json({ ok: false, errors: (v as { errors: string[] }).errors });
    const existed = !!db.prepare('SELECT 1 FROM daily_bias WHERE date = ?').get(v.value.date);
    upsert.run({ date: v.value.date, status: v.value.status, bias: v.value.bias, confidence: v.value.confidence,
      headline: v.value.headline, generated_at: v.value.generated_at, payload: JSON.stringify(v.value), now: Date.now() });
    console.log(`[bias] ${existed ? 'replaced' : 'stored'} ${v.value.date} ${v.value.status} ${v.value.bias ?? '-'}`);
    res.json({ ok: true, date: v.value.date, replaced: existed, warnings: v.warnings });
  });

  app.get('/api/bias/today', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    const today = istToday();
    const r = db.prepare('SELECT * FROM daily_bias WHERE date = ?').get(today);
    if (!r) return res.json({ status: 'pending', date: today });
    res.json(rowToRecord(r));
  });

  app.get('/api/bias/history', (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    const days = Math.max(1, Math.min(365, Math.floor(Number(req.query?.days) || 30)));
    const from = istToday(Date.now() - (days - 1) * 86400000);
    const rows = db.prepare('SELECT * FROM daily_bias WHERE date >= ? ORDER BY date DESC').all(from);
    res.json({ days, from, records: rows.map(rowToRecord) });
  });

  // The look for a reversal: once a minute in market hours, while today's note
  // has none recorded. One candle request a minute at most, and none once the
  // day's reversal is written or when there is nothing that could reverse.
  if (deps?.niftyCandles15) {
    let busy = false;
    setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const now = Date.now();
        const d = new Date(now + 5.5 * 3600 * 1000), mins = d.getUTCHours() * 60 + d.getUTCMinutes(), day = d.getUTCDay();
        if (day === 0 || day === 6 || mins < 9 * 60 + 30 || mins > 15 * 60 + 35) return;
        const r: any = db.prepare('SELECT * FROM daily_bias WHERE date = ?').get(istToday(now));
        if (!r || r.reversal || r.status !== 'ok' || (r.bias !== 'bullish' && r.bias !== 'bearish')) return;
        const note = JSON.parse(r.payload);
        if (typeof note?.levels?.invalidation !== 'number') return;
        const rev = biasReversal(note, await deps.niftyCandles15!(now));
        if (!rev) return;
        db.prepare('UPDATE daily_bias SET reversal = ?, updated_at = ? WHERE date = ? AND reversal IS NULL').run(JSON.stringify(rev), now, r.date);
        console.log(`[bias] REVERSED ${r.date} ${rev.from} -> ${rev.to}: 15-min candle closed ${rev.close}, ${rev.to === 'bullish' ? 'above' : 'below'} ${rev.level}, at ${rev.at}`);
      } catch (e: any) { /* the next minute looks again */ }
      finally { busy = false; }
    }, 60000);
  }

  console.log('[bias] registered: POST /api/bias, GET /api/bias/today, /api/bias/history');
}

