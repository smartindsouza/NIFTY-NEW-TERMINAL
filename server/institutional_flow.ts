import axios from 'axios';

// ============================================================================
// INSTITUTIONAL FLOW — daily FII/FPI and DII CASH-market activity, in ₹ crore.
//
// Not the same dataset as fii_service.ts, which reads F&O participant OI (long
// and short CONTRACTS). This is the cash market's rupee value: bought, sold and
// net per category, which is the headline figure quoted every evening.
//
// SOURCE. NSE's own report, the same numbers the exchange publishes. It needs a
// cookie handshake first — a bare request is refused — so the homepage is
// fetched to collect cookies and they are replayed on the data call, with
// browser headers. The cookie is reused until it fails rather than fetched per
// request.
//
// WHY IT IS STORED. NSE serves only the latest day at this endpoint, so history
// only exists if we keep it. Every successful fetch is written to SQLite keyed
// by date, which also means a day already captured survives NSE later blocking
// or changing the feed — the screen keeps working on what it already has.
//
// Provisional by nature: NSE publishes these as provisional after the close and
// they can be revised. Stored rows are therefore UPDATED on re-fetch, not
// ignored, so a revision replaces the provisional figure.
// ============================================================================

export type FlowSide = { buy: number; sell: number; net: number };
export type FlowDay = {
  date: string;            // ISO yyyy-mm-dd
  displayDate: string;     // as published, e.g. "04-Sep-2026"
  fii: FlowSide;
  dii: FlowSide;
  combinedBuy: number;
  combinedSell: number;
  combinedNet: number;
};

const NSE_HOME = 'https://www.nseindia.com';
const NSE_FIIDII = 'https://www.nseindia.com/api/fiidiiTradeReact';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let cookieJar: string | null = null;
let cookieAt = 0;

async function ensureCookie(force = false): Promise<string | null> {
  if (!force && cookieJar && Date.now() - cookieAt < 20 * 60 * 1000) return cookieJar;
  try {
    const r = await axios.get(NSE_HOME, {
      timeout: 10000,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
    });
    const set = (r.headers as any)?.['set-cookie'];
    if (Array.isArray(set) && set.length) {
      cookieJar = set.map((c: string) => c.split(';')[0]).join('; ');
      cookieAt = Date.now();
      return cookieJar;
    }
  } catch (e) { /* handled by the caller's reason */ }
  return null;
}

const num = (v: any): number => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** "04-Sep-2026" -> "2026-09-04". Returns null if it cannot be parsed, so a
 *  changed date format is visible rather than silently stored under a bad key. */
export function toIsoDate(display: string): string | null {
  const m = String(display || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const mm = months[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
}

/** Shape NSE's rows into one day. Categories arrive as "FII/FPI *" and "DII **". */
export function parseFiiDii(rows: any[]): { day: FlowDay | null; reason?: string } {
  if (!Array.isArray(rows) || rows.length === 0) return { day: null, reason: 'empty_response' };
  const pick = (needle: string) =>
    rows.find((r) => String(r?.category || '').toUpperCase().replace(/[^A-Z]/g, '').includes(needle));
  const fiiRow = pick('FII') || pick('FPI');
  const diiRow = pick('DII');
  if (!fiiRow || !diiRow) return { day: null, reason: 'category_missing' };
  const display = String(fiiRow.date || diiRow.date || '').trim();
  const iso = toIsoDate(display);
  if (!iso) return { day: null, reason: `unparsable_date:${display}`.slice(0, 60) };
  const side = (r: any): FlowSide => {
    const buy = num(r.buyValue), sell = num(r.sellValue);
    // Trust NSE's own net when present; fall back to the subtraction.
    const net = r.netValue !== undefined && r.netValue !== null && String(r.netValue).trim() !== ''
      ? num(r.netValue) : +(buy - sell).toFixed(2);
    return { buy, sell, net };
  };
  const fii = side(fiiRow), dii = side(diiRow);
  return {
    day: {
      date: iso, displayDate: display, fii, dii,
      combinedBuy: +(fii.buy + dii.buy).toFixed(2),
      combinedSell: +(fii.sell + dii.sell).toFixed(2),
      combinedNet: +(fii.net + dii.net).toFixed(2),
    },
  };
}

/** One plain-English line, the same reading Martin's reference screen gives. */
export function explain(d: FlowDay): string {
  const fiiBuying = d.fii.net >= 0, diiBuying = d.dii.net >= 0;
  const cr = (n: number) => `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
  if (fiiBuying && diiBuying) return 'Both foreign and domestic institutions were net buyers.';
  if (!fiiBuying && !diiBuying) return 'Both foreign and domestic institutions were net sellers.';
  if (!fiiBuying && diiBuying) {
    return d.combinedNet >= 0
      ? `FIIs sold ${cr(d.fii.net)}, but stronger DII buying kept the combined institutional flow positive.`
      : `DIIs bought ${cr(d.dii.net)}, but heavier FII selling left the combined flow negative.`;
  }
  return d.combinedNet >= 0
    ? `DIIs sold ${cr(d.dii.net)}, but stronger FII buying kept the combined institutional flow positive.`
    : `FIIs bought ${cr(d.fii.net)}, but heavier DII selling left the combined flow negative.`;
}

/** Fetch the latest published day. Retries once with a fresh cookie, since an
 *  expired one is the ordinary failure and is worth distinguishing from a block. */
export async function fetchLatestFlow(): Promise<{ day: FlowDay | null; reason?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = await ensureCookie(attempt > 0);
    if (!cookie) { if (attempt) return { day: null, reason: 'no_cookie_from_nse' }; continue; }
    try {
      const r = await axios.get(NSE_FIIDII, {
        timeout: 12000,
        headers: {
          'User-Agent': UA, Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9', Referer: `${NSE_HOME}/reports/fii-dii`, Cookie: cookie,
        },
      });
      return parseFiiDii(r.data);
    } catch (e: any) {
      const status = e?.response?.status ?? null;
      if ((status === 401 || status === 403) && attempt === 0) { cookieJar = null; continue; }
      return {
        day: null,
        reason: status === 401 || status === 403 ? `blocked_by_nse_${status}`
          : status === 429 ? 'rate_limited_429'
          : e?.code === 'ECONNABORTED' ? 'timeout'
          : status ? `http_${status}` : (e?.code || 'network_error'),
      };
    }
  }
  return { day: null, reason: 'unreachable' };
}
