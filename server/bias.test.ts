// Test for the Today's Bias API. No network; a temporary sqlite file.
//   npx tsx server/bias.test.ts

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

process.env.KITE_DATA_DIR = os.tmpdir();            // kite_service (imported indirectly) opens its file here
process.env.SNAPSHOT_API_KEY = 'test-key-123';

export function samplePayload(date: string) {
  return {
    date,
    generated_at: `${date}T09:33:05+05:30`,
    status: 'ok',
    bias: 'bearish',
    confidence: 'moderate',
    headline: 'Gap-up faded inside the first 15 min — sell rallies below 22,940',
    summary: 'GIFT implied +60 but NIFTY opened +45 and the first three candles closed lower.\nOR low 22,880 is the trigger; a 5-min close above 22,955 invalidates.',
    levels: { trigger: 22880, invalidation: 22955, next_reference: 22820, or_high: 22950, or_low: 22880,
      first_candle_high: 22950, first_candle_low: 22905, prev_high: 23175.25, prev_low: 22845, prev_close: 22888.95,
      cpr_pivot: 22969.7, cpr_tc: 23010.3, cpr_bc: 22929.1 },
    gap: { actual_open_pts: 45, gift_implied_pts: 60 },
    factors: [
      { name: 'Opening range', read: 'bearish', note: 'Three red candles after a gap-up' },
      { name: 'GIFT vs open', read: 'bearish', note: 'Opened below GIFT-implied' },
      { name: 'US30', read: 'neutral', note: 'Flat close' },
      { name: 'India VIX', read: 'bullish', note: 'VIX down 3%' },
    ],
    us30: { close: 46612, change_pts: -38, change_pct: -0.08, driver: 'Flat ahead of earnings' },
    error: null,
  };
}

async function main() {
  const express = (await import('express')).default;
  const Database = (await import('better-sqlite3')).default;
  const { registerBias, istToday, validateBias } = await import('./bias');

  const file = path.join(os.tmpdir(), `bias-test-${process.pid}.db`);
  try { fs.unlinkSync(file); } catch {}
  const start = async () => {
    const db = new Database(file);
    const app = express(); registerBias(app, db);
    const srv = http.createServer(app); await new Promise<void>((r) => srv.listen(0, r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    return { db, srv, base };
  };
  let { db, srv, base } = await start();
  const post = async (body: any, opts: { key?: string | null; query?: string } = {}) => {
    const headers: any = { 'Content-Type': 'application/json' };
    if (opts.key !== null) headers['X-API-Key'] = opts.key ?? 'test-key-123';
    const r = await fetch(`${base}/api/bias${opts.query || ''}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { s: r.status, j: await r.json() };
  };
  const get = async (p: string) => { const r = await fetch(base + p); return { s: r.status, j: await r.json() }; };
  const today = istToday();

  // Auth
  assert.equal((await post(samplePayload(today), { key: null })).s, 401, 'no key');
  assert.equal((await post(samplePayload(today), { key: 'wrong' })).s, 401, 'wrong key');
  assert.equal((await post(samplePayload(today), { key: null, query: '?key=test-key-123' })).s, 200, '?key= accepted');

  // Pending before / record after
  db.prepare('DELETE FROM daily_bias').run();
  assert.deepEqual((await get('/api/bias/today')).j, { status: 'pending', date: today });
  const first = await post(samplePayload(today));
  assert.equal(first.s, 200); assert.equal(first.j.replaced, false); assert.deepEqual(first.j.warnings, []);
  const t = (await get('/api/bias/today')).j;
  assert.equal(t.status, 'ok'); assert.equal(t.bias, 'bearish'); assert.equal(t.levels.trigger, 22880);
  assert.equal(t.outcome, null); assert.match(t.received_at, /\+05:30$/);

  // Validation
  const bad = await post({ ...samplePayload(today), bias: 'up', levels: { trigger: '22880' }, factors: [{ name: 'x', read: 'maybe' }] });
  assert.equal(bad.s, 400);
  assert.ok(bad.j.errors.some((e: string) => e.startsWith('bias must')));
  assert.ok(bad.j.errors.some((e: string) => e.startsWith('levels.trigger')));
  assert.ok(bad.j.errors.some((e: string) => e.startsWith('factors[0].read')));
  assert.equal((await post({ ...samplePayload(today), date: '2026-02-30' })).s, 400, 'impossible date');
  assert.equal((await post('{not json')).s, 400, 'malformed JSON');
  const big = await post({ ...samplePayload(today), summary: 'x'.repeat(60 * 1024) });
  assert.equal(big.s, 413, 'over 50 KB');
  const warn = await post({ ...samplePayload(today), extra: 1, levels: { ...samplePayload(today).levels, triger: 1 } });
  assert.equal(warn.s, 200); assert.ok(warn.j.warnings.some((w: string) => w.includes('"extra"')));
  assert.ok(warn.j.warnings.some((w: string) => w.includes('levels.triger')));

  // Holiday / no session note is valid with nulls
  const ns = validateBias({ date: today, generated_at: `${today}T09:33:00+05:30`, status: 'no_session', bias: null, confidence: null,
    headline: 'No bias today — market holiday', summary: '', levels: null, gap: null, factors: [], us30: null, error: 'NSE holiday' });
  assert.equal(ns.ok, true);

  // Re-post replaces the note but keeps a score already given
  db.prepare('UPDATE daily_bias SET outcome = ?, outcome_note = ? WHERE date = ?').run('worked', 'hit next ref', today);
  const re = await post({ ...samplePayload(today), bias: 'neutral', headline: 'Revised: range day' });
  assert.equal(re.j.replaced, true);
  const t2 = (await get('/api/bias/today')).j;
  assert.equal(t2.bias, 'neutral'); assert.equal(t2.headline, 'Revised: range day'); assert.equal(t2.outcome, 'worked');

  // History: older days kept, newest first, window respected
  const d = (n: number) => istToday(Date.now() - n * 86400000);
  for (const n of [1, 2, 40]) await post({ ...samplePayload(d(n)), headline: `day -${n}` });
  const h = (await get('/api/bias/history?days=30')).j;
  assert.deepEqual(h.records.map((r: any) => r.date), [today, d(1), d(2)]);
  assert.equal((await get('/api/bias/history?days=60')).j.records.length, 4, 'the 40-day-old note is still stored');

  // Survives a restart (same database file, fresh app)
  srv.close(); db.close();
  ({ db, srv, base } = await start());
  assert.equal((await get('/api/bias/today')).j.headline, 'Revised: range day');
  srv.close(); db.close();
  try { fs.unlinkSync(file); } catch {}

  // ── the reversal rule ──
  {
    const { biasReversal } = await import('./bias');
    const D = '2026-11-19';
    const note = (bias: any, inval: any) => ({ bias, status: 'ok', generated_at: `${D}T09:34:00+05:30`, levels: { invalidation: inval } as any });
    const k = (hhmm: string, c: number) => ({ t: Date.parse(`${D}T${hhmm}:00+05:30`), c });
    // bearish: closes at or under the level do nothing, a wick is not known here (closes only), the first close above reverses
    const day = [k('09:15', 25200), k('09:30', 25130), k('09:45', 25256), k('10:00', 25240), k('10:15', 25262.5), k('10:30', 25300)];
    const r = biasReversal(note('bearish', 25256), day)!;
    assert.equal(r.to, 'bullish'); assert.equal(r.from, 'bearish'); assert.equal(r.close, 25262.5); assert.equal(r.level, 25256);
    assert.equal(r.at, `${D}T10:30:00+05:30`, 'at the close of the 10:15 candle');
    assert.equal(r.candle_start, `${D}T10:15:00+05:30`);
    // a candle that had closed before the note was written is not counted, however far beyond
    assert.equal(biasReversal(note('bearish', 25256), [k('09:15', 25400)]), null, '09:15-09:30 closed before 09:34');
    // ...but the one the note was written inside is (09:30-09:45 closes after 09:34)
    assert.equal(biasReversal(note('bearish', 25256), [k('09:30', 25300)])!.at, `${D}T09:45:00+05:30`);
    // bullish mirrors it
    const b = biasReversal(note('bullish', 25100), [k('09:45', 25100), k('10:00', 25099.9)])!;
    assert.equal(b.to, 'bearish'); assert.equal(b.at, `${D}T10:15:00+05:30`);
    assert.equal(biasReversal(note('bullish', 25100), [k('09:45', 25100.1), k('10:00', 25500)]), null);
    // nothing to reverse
    assert.equal(biasReversal(note('neutral', 25256), day), null);
    assert.equal(biasReversal(note('bearish', null), day), null);
    assert.equal(biasReversal({ ...note('bearish', 25256), status: 'error' }, day), null);
    assert.equal(biasReversal(note('bearish', 25256), []), null);
  }

  console.log('bias: all checks passed');
}

if (process.argv[1] && process.argv[1].endsWith('bias.test.ts')) main().catch((e) => { console.error(e); process.exit(1); });
