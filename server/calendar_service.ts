// Market calendar — official NSE trading holidays.
//
// Source: https://www.nseindia.com/api/holiday-master?type=trading (the FO
// segment, which is what F&O trading follows). This is NSE's own published
// list, not a scrape of a rendered page, so it stays correct without yearly
// hand-maintenance — the previous hardcoded list in config/gapScorecard.ts
// carried 4 dates while NSE publishes ~20.
//
// Reliability rules (money-critical paths depend on this):
//  - cached 24h in memory AND persisted to sqlite, so a restart or an NSE
//    outage never leaves the app guessing;
//  - if NSE is unreachable and the table is empty, callers fall back to the
//    static config list and the response says so — never a silent guess.

import axios from 'axios';
import { GAP_CONFIG } from './config/gapScorecard';

let db: any = null;
let memo: Map<string, string> = new Map(); // 'YYYY-MM-DD' -> description
let lastFetchAt = 0;
let lastSource: 'nse' | 'sqlite' | 'static-fallback' | 'none' = 'none';

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

// NSE renders dates as '15-Jan-2026'.
export function parseNseDate(s: string): string | null {
  const m = String(s || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toUpperCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${String(m[1]).padStart(2, '0')}`;
}

export function initCalendar(database: any) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS market_holidays (
    date TEXT PRIMARY KEY, description TEXT, segment TEXT, updated_at INTEGER
  );`);
  try {
    const rows: any[] = db.prepare('SELECT date, description FROM market_holidays').all();
    memo = new Map(rows.map(r => [r.date, r.description || 'Trading holiday']));
    if (memo.size) lastSource = 'sqlite';
  } catch (e) { /* first boot */ }
  // Refresh on boot (non-blocking) and once a day thereafter.
  refreshHolidays().catch(() => {});
  setInterval(() => { refreshHolidays().catch(() => {}); }, 24 * 60 * 60 * 1000);
}

export async function refreshHolidays(force = false): Promise<{ ok: boolean; count: number; source: string; error?: string }> {
  if (!force && Date.now() - lastFetchAt < 12 * 60 * 60 * 1000 && memo.size) {
    return { ok: true, count: memo.size, source: lastSource };
  }
  try {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    // NSE requires a cookie handshake before its /api routes answer.
    const home = await axios.get('https://www.nseindia.com/', {
      headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 8000,
    });
    const cookies = ((home.headers['set-cookie'] as any) || []).map((c: string) => c.split(';')[0]).join('; ');
    const r = await axios.get('https://www.nseindia.com/api/holiday-master?type=trading', {
      headers: {
        'User-Agent': ua, 'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/resources/exchange-communication-holidays',
        ...(cookies ? { Cookie: cookies } : {}),
      },
      timeout: 8000,
    });
    const fo = (r.data && (r.data.FO || r.data.CM)) || [];
    if (!Array.isArray(fo) || !fo.length) throw new Error('unexpected holiday-master shape');
    const parsed: Array<{ date: string; description: string }> = [];
    for (const h of fo) {
      const d = parseNseDate(h.tradingDate);
      if (d) parsed.push({ date: d, description: String(h.description || 'Trading holiday').trim() });
    }
    if (!parsed.length) throw new Error('no parsable holiday rows');
    const tx = db.transaction((rows: any[]) => {
      for (const p of rows) {
        db.prepare(`INSERT INTO market_holidays (date, description, segment, updated_at) VALUES (?, ?, 'FO', ?)
          ON CONFLICT(date) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at`)
          .run(p.date, p.description, Date.now());
      }
    });
    tx(parsed);
    for (const p of parsed) memo.set(p.date, p.description);
    lastFetchAt = Date.now(); lastSource = 'nse';
    console.log(`[calendar] NSE holidays refreshed: ${parsed.length} F&O dates`);
    return { ok: true, count: parsed.length, source: 'nse' };
  } catch (e: any) {
    if (memo.size) return { ok: false, count: memo.size, source: lastSource, error: e?.message || String(e) };
    lastSource = 'static-fallback';
    return { ok: false, count: GAP_CONFIG.nseHolidays.length, source: 'static-fallback', error: e?.message || String(e) };
  }
}

export function isNseHoliday(dateStr: string): boolean {
  if (memo.size) return memo.has(dateStr);
  return GAP_CONFIG.nseHolidays.includes(dateStr); // last-resort static list
}
export function holidayName(dateStr: string): string | null {
  return memo.get(dateStr) || (GAP_CONFIG.nseHolidays.includes(dateStr) ? 'Trading holiday' : null);
}
export function isWeekend(dateStr: string): boolean {
  const wd = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return wd === 0 || wd === 6;
}
export function isTradingDay(dateStr: string): boolean {
  return !isWeekend(dateStr) && !isNseHoliday(dateStr);
}
export function calendarStatus() {
  return {
    source: lastSource,
    count: memo.size || GAP_CONFIG.nseHolidays.length,
    lastFetchAt: lastFetchAt || null,
    holidays: [...memo.entries()].sort().map(([date, description]) => ({ date, description })),
  };
}

export function registerCalendar(app: any, database: any) {
  initCalendar(database);

  app.get('/api/calendar/holidays', async (req: any, res: any) => {
    try {
      if (req.query.refresh === '1') await refreshHolidays(true);
      res.json(calendarStatus());
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Used by the H-levels morning prompt so it never fires on a closed day.
  app.get('/api/calendar/trading-day', (req: any, res: any) => {
    try {
      const x = new Date(Date.now() + 5.5 * 3600 * 1000);
      const today = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
      const d = String(req.query.date || today);
      const weekend = isWeekend(d);
      const holiday = isNseHoliday(d);
      res.json({
        date: d, isTradingDay: !weekend && !holiday,
        reason: weekend ? 'weekend' : holiday ? (holidayName(d) || 'NSE holiday') : 'trading day',
        source: lastSource,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('[calendar] registered: NSE holiday master (auto-refresh daily)');
}
