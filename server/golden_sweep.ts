// GOLDEN-ZONE SWAP-SWEEP — WATCH ONLY (2 Nov 2026, Martin).
//
// The 2-year study (4 Nov 2024 – 2 Nov 2026, NIFTY 15-min) tested Martin's
// Swap-Sweep with 174 Fibonacci variants. Plain Swap-Sweep lost money after costs
// on every exit. One variant stayed positive on both the training and the test
// period: a Swap-Sweep whose sweep candle reaches the 50–61.8% "golden zone" of
// the last 24 candles' swing, held to the close (+12 index pts/trade after 5 pts
// costs, 74 trades). It is luck-shaped (median trade −19, +0.6 without its 3 best
// trades), so Martin asked for it as a WATCH-ONLY alert: it places no orders. It
// logs each signal and grades it the way the study did, so the live record can be
// compared with the backtest before any money goes on it.
//
// THE RULE (identical to the study; verified by replaying the 2 years):
//   C1, C2, C3 = three consecutive completed 15-min candles of the same day, and
//   C3 is not the day's last candle.
//   Bullish: C2 closes below C1's low; C3's low goes below C2's low; C3 closes
//            back inside C1's range.            (bearish mirrored at the highs)
//   Swing:   highest high / lowest low of the 24 candles before C3 (may span days);
//            must be at least 2 × ATR20.
//   Golden zone: 50%–61.8% retracement of that swing — down from the high for a
//            bullish sweep, up from the low for a bearish one — widened by
//            0.15 × ATR20 each side. C3's sweep extreme must lie inside it.
//   ATR20:   mean true range of the last 20 candles up to and including C3.
//   Grading: entry = next candle's open; stop = 0.05 beyond C3's sweep extreme;
//            exit at the stop or at the day's last close; 5 pts costs.
import { getKiteClient } from './kite_service';

export interface Bar { t: number; open: number; high: number; low: number; close: number }
export interface GzSignal { c3: number; dir: 1 | -1; ext: number; atr: number; swingH: number; swingL: number; zoneLo: number; zoneHi: number }

const IST = 5.5 * 3600000;
const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const istMin = (ms: number) => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const COST = 5;

/** ATR20 series (mean true range, at least 10 bars), same as the study. */
export function atrSeries(b: Bar[]): number[] {
  const tr = b.map((x, i) => i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)));
  return tr.map((_, i) => { const s = tr.slice(Math.max(0, i - 19), i + 1); return s.length >= 10 ? s.reduce((a, v) => a + v, 0) / s.length : NaN; });
}

/** Is candle t (as C3) a golden-zone Swap-Sweep? `hasNext` = a later candle of the same day exists or will. */
export function detectAt(b: Bar[], t: number, atr: number[]): GzSignal | null {
  if (t < 24 || !(atr[t] > 0)) return null;
  const d = istDay(b[t].t);
  if (istDay(b[t - 1].t) !== d || istDay(b[t - 2].t) !== d) return null;
  const C1 = b[t - 2], C2 = b[t - 1], C3 = b[t];
  let dir: 1 | -1, ext: number;
  if (C2.close < C1.low && C3.low < C2.low && C3.close > C1.low && C3.close < C1.high) { dir = 1; ext = C3.low; }
  else if (C2.close > C1.high && C3.high > C2.high && C3.close > C1.low && C3.close < C1.high) { dir = -1; ext = C3.high; }
  else return null;
  let H = -Infinity, L = Infinity;
  for (let k = t - 24; k < t; k++) { H = Math.max(H, b[k].high); L = Math.min(L, b[k].low); }
  const a = atr[t];
  if (H - L < 2 * a) return null;
  const lv = (r: number) => dir === 1 ? H - r * (H - L) : L + r * (H - L);
  const tol = 0.15 * a;
  const lo = Math.min(lv(0.5), lv(0.618)) - tol, hi = Math.max(lv(0.5), lv(0.618)) + tol;
  if (ext < lo || ext > hi) return null;
  return { c3: C3.t, dir, ext, atr: a, swingH: H, swingL: L, zoneLo: lo, zoneHi: hi };
}

/** Grade from the bars after C3 (same day). null = no entry candle yet. */
export function grade(b: Bar[], s: GzSignal, dayDone: boolean) {
  const i = b.findIndex(x => x.t === s.c3);
  if (i < 0 || i + 1 >= b.length || istDay(b[i + 1].t) !== istDay(s.c3)) return null;
  const entry = b[i + 1].open, stop = s.ext - s.dir * 0.05;
  if ((entry - stop) * s.dir <= 0.5) return { entry, stop, status: 'SKIPPED' as const, reason: 'opened beyond the stop', pts: null, exit: null };
  let last = b[i + 1];
  for (let j = i + 1; j < b.length && istDay(b[j].t) === istDay(s.c3); j++) {
    last = b[j];
    if (s.dir === 1 ? b[j].low <= stop : b[j].high >= stop) return { entry, stop, status: 'CLOSED' as const, reason: 'stop', exit: stop, pts: +((stop - entry) * s.dir - COST).toFixed(2) };
  }
  if (!dayDone) return { entry, stop, status: 'OPEN' as const, reason: null, exit: null, pts: +((last.close - entry) * s.dir - COST).toFixed(2) };
  return { entry, stop, status: 'CLOSED' as const, reason: 'day close', exit: last.close, pts: +((last.close - entry) * s.dir - COST).toFixed(2) };
}

// ------------------------------------------------------------------ live
let D: { db: any; notify: (t: string) => Promise<any> | void };
const fmt = (ms: number) => new Date(ms + IST).toISOString().slice(11, 16);

async function bars15(): Promise<Bar[]> {
  const kc: any = getKiteClient();
  if (!kc || !kc.access_token) throw new Error('Zerodha is not logged in');
  const s = (ms: number) => new Date(ms + IST).toISOString().slice(0, 19).replace('T', ' ');
  const raw = await kc.getHistoricalData(256265, '15minute', s(Date.now() - 8 * 86400000), s(Date.now()));
  const now = Date.now();
  // completed candles only: the one still printing is dropped
  return (raw || []).map((c: any) => ({ t: new Date(c.date).getTime(), open: +c.open, high: +c.high, low: +c.low, close: +c.close }))
    .filter((x: Bar) => x.t + 15 * 60000 <= now);
}

let lastScanned = 0, busy = false;
async function tick() {
  if (busy) return;
  const now = Date.now(), d = new Date(now + IST), m = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
  if (wd === 0 || wd === 6 || m < 9 * 60 + 30 || m > 15 * 60 + 40) return;
  const slot = Math.floor((now + IST) / (15 * 60000));        // one scan per closed 15-min candle
  if (slot === lastScanned || d.getUTCSeconds() < 20 && m % 15 === 0) return;
  busy = true;
  try {
    const b = await bars15(); lastScanned = slot;
    if (b.length < 30) return;
    const atr = atrSeries(b);
    const t = b.length - 1;                                    // the candle that just closed is C3
    const today = istDay(now);
    if (istDay(b[t].t) === today && istMin(b[t].t) < 15 * 60 + 15) {
      const s = detectAt(b, t, atr);
      // only a candle that has just closed: after a restart mid-session, an old
      // candle must not raise a late alert
      if (s && b[t].t + 30 * 60000 > now) {
        const r = D.db.prepare(`INSERT OR IGNORE INTO gz_signals (c3_time, day, dir, ext, atr, swing_h, swing_l, zone_lo, zone_hi, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?, 'WAITING', ?)`).run(s.c3, today, s.dir, s.ext, s.atr, s.swingH, s.swingL, s.zoneLo, s.zoneHi, Date.now());
        if (r.changes) {
          await D.notify(`🟡 WATCH ONLY — Golden-zone Swap-Sweep ${s.dir === 1 ? 'BULLISH (would buy CE)' : 'BEARISH (would buy PE)'}\n` +
            `NIFTY 15-min candle ${fmt(s.c3)}–${fmt(s.c3 + 15 * 60000)} swept ${s.dir === 1 ? 'down to' : 'up to'} ${s.ext.toFixed(1)}, inside the 50–61.8% zone ` +
            `(${s.zoneLo.toFixed(0)}–${s.zoneHi.toFixed(0)}) of the last 24 candles' swing ${s.swingL.toFixed(0)}–${s.swingH.toFixed(0)}.\n` +
            `Test rule: enter next candle open, stop ${(s.ext - s.dir * 0.05).toFixed(1)}, hold to the close. No order placed — 2-year test: luck-shaped, not proven.`);
        }
      }
    }
    // grade today's signals
    const dayDone = m >= 15 * 60 + 30;
    for (const row of D.db.prepare("SELECT * FROM gz_signals WHERE status IN ('WAITING','OPEN')").all() as any[]) {
      const s: GzSignal = { c3: row.c3_time, dir: row.dir, ext: row.ext, atr: row.atr, swingH: row.swing_h, swingL: row.swing_l, zoneLo: row.zone_lo, zoneHi: row.zone_hi };
      const g = grade(b, s, dayDone || row.day !== today);
      if (!g) continue;
      D.db.prepare('UPDATE gz_signals SET entry=?, stop=?, status=?, exit_reason=?, exit_px=?, pts=?, updated_at=? WHERE c3_time=?')
        .run(g.entry, g.stop, g.status, g.reason, g.exit, g.pts, Date.now(), row.c3_time);
      if (g.status === 'CLOSED' && row.status !== 'CLOSED')
        await D.notify(`🟡 WATCH ONLY — Golden-zone Swap-Sweep of ${fmt(row.c3_time)} graded: ${g.reason === 'stop' ? 'stopped' : 'held to close'} → ${g.pts! >= 0 ? '+' : ''}${g.pts} index pts after 5 pts costs.`);
    }
  } catch (e: any) { if (!/not logged in/.test(String(e?.message))) console.error('[golden-sweep]', e?.message || e); }
  finally { busy = false; }
}

export function registerGoldenSweep(app: any, deps: typeof D) {
  D = deps;
  D.db.exec(`CREATE TABLE IF NOT EXISTS gz_signals (c3_time INTEGER PRIMARY KEY, day TEXT, dir INTEGER, ext REAL, atr REAL,
    swing_h REAL, swing_l REAL, zone_lo REAL, zone_hi REAL, entry REAL, stop REAL, status TEXT, exit_reason TEXT, exit_px REAL,
    pts REAL, created_at INTEGER, updated_at INTEGER)`);
  setInterval(() => { void tick(); }, 20000);
  app.get('/api/golden-sweep/status', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store');
    const rows = D.db.prepare('SELECT * FROM gz_signals ORDER BY c3_time DESC LIMIT 200').all() as any[];
    const done = rows.filter(r => r.status === 'CLOSED' && r.pts != null);
    const tot = done.reduce((a, r) => a + r.pts, 0);
    res.json({ ok: true, watchOnly: true,
      backtest: { period: '4 Nov 2024 – 2 Nov 2026', trades: 74, avgPts: 12.3, medianPts: -19.5, winRate: 0.36, note: 'after 5 pts costs; +0.6 without its 3 best trades' },
      live: { graded: done.length, avgPts: done.length ? +(tot / done.length).toFixed(2) : null, totalPts: +tot.toFixed(2), wins: done.filter(r => r.pts > 0).length },
      signals: rows });
  });
}
