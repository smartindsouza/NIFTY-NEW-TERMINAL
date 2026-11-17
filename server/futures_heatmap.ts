import axios from 'axios';
import zlib from 'node:zlib';
import { getKiteClient, getNfoInstruments } from './kite_service';
import { expiryParts } from './instrument_search';

// THE FUTURES HEATMAP (17 Nov 2026). Martin, with a screen recording of one
// ("Futures Heatmap": Index / Sector, the index's chips, an expiry, Price, and a
// grid of stock futures coloured by the day's change): "I want this exact futures
// heat map in my homepage below at the end". This is its data:
//   - which stocks: the members of each index and sector chip, from NSE's own
//     lists (archives.nseindia.com/content/indices/ind_<name>list.csv), kept a
//     day. The Sensex is BSE's and BSE's site refuses the server, so its 30 are
//     written out below;
//   - their futures: Zerodha's NFO contract list (the stock futures of every
//     member, one per expiry), so the chips only ever show stocks that HAVE
//     futures, and the expiries are those on the list;
//   - price and change: one Zerodha quote of every stock future of the chosen
//     expiry (about 200, under the 500 a quote takes), kept 5 seconds so any
//     number of screens share one quote, and the chips switch without asking
//     again. Change is against the previous close (the quote's ohlc.close);
//   - OI change (the "OI" view): the quote's OI against the OI at the end of
//     the previous trading day, from NSE's F&O bhavcopy for that day (one file a
//     day, kept), read straight out of its zip here — no zip library needed.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

type Group = { name: string; file?: string; symbols?: string[] };

// The Sensex's 30, as BSE lists them after the rejig of 22 Dec 2025 (IndiGo
// in); the June 2026 rejig changed only other BSE indices. BSE rejigs in June
// and December: check this list then.
const SENSEX_30 = [
  'ADANIPORTS', 'ASIANPAINT', 'AXISBANK', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL', 'ETERNAL',
  'HCLTECH', 'HDFCBANK', 'HINDUNILVR', 'ICICIBANK', 'INDIGO', 'INFY', 'ITC', 'KOTAKBANK', 'LT', 'M&M',
  'MARUTI', 'NTPC', 'POWERGRID', 'RELIANCE', 'SBIN', 'SUNPHARMA', 'TCS', 'TATASTEEL', 'TECHM', 'TITAN',
  'TRENT', 'ULTRACEMCO',
];

// The chips, in the order of the recording (Index: Nifty 50, Sensex, Nifty Bank,
// Nifty Financial Services, Nifty Midcap 50, Nifty 100, Nifty 500; Sector: Auto,
// Banks, Metals, Finance, ...). Each sector is NSE's sectoral index of that name.
export const INDEX_GROUPS: Group[] = [
  { name: 'Nifty 50', file: 'ind_nifty50list' },
  { name: 'Sensex', symbols: SENSEX_30 },
  { name: 'Nifty Bank', file: 'ind_niftybanklist' },
  { name: 'Nifty Financial Services', file: 'ind_niftyfinancelist' },
  { name: 'Nifty Midcap 50', file: 'ind_niftymidcap50list' },
  { name: 'Nifty 100', file: 'ind_nifty100list' },
  { name: 'Nifty 500', file: 'ind_nifty500list' },
];
export const SECTOR_GROUPS: Group[] = [
  { name: 'Auto', file: 'ind_niftyautolist' },
  { name: 'Banks', file: 'ind_niftybanklist' },
  { name: 'Metals', file: 'ind_niftymetallist' },
  { name: 'Finance', file: 'ind_niftyfinancelist' },
  { name: 'IT', file: 'ind_niftyitlist' },
  { name: 'Pharma', file: 'ind_niftypharmalist' },
  { name: 'FMCG', file: 'ind_niftyfmcglist' },
  { name: 'Energy', file: 'ind_niftyenergylist' },
  { name: 'Oil & Gas', file: 'ind_niftyoilgaslist' },
  { name: 'Realty', file: 'ind_niftyrealtylist' },
  { name: 'Media', file: 'ind_niftymedialist' },
  { name: 'PSU Banks', file: 'ind_niftypsubanklist' },
  { name: 'Pvt Banks', file: 'ind_nifty_privatebanklist' },
  { name: 'Healthcare', file: 'ind_niftyhealthcarelist' },
  { name: 'Consumer Durables', file: 'ind_niftyconsumerdurableslist' },
];

const DAY = 24 * 3600 * 1000;
const istDate = (ms: number) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Symbols out of one of NSE's index CSVs ("Company Name,Industry,Symbol,Series,ISIN Code"). */
export function symbolsFromIndexCsv(csv: string): string[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const cells = (l: string) => {
    const out: string[] = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out.map((c) => c.trim());
  };
  const head = cells(lines[0]).map((h) => h.toLowerCase());
  const at = head.indexOf('symbol');
  if (at < 0) return [];
  return lines.slice(1).map((l) => cells(l)[at]).filter(Boolean);
}

// ---- members, kept a day; a list that fails keeps its last good copy, and is
// tried again ten minutes later ----
const memberLists = new Map<string, { at: number; symbols: string[]; ok: boolean }>();
let membersReading: Promise<void> | null = null;

async function readList(file: string): Promise<string[] | null> {
  try {
    const r = await axios.get(`https://archives.nseindia.com/content/indices/${file}.csv`, {
      headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' }, timeout: 8000, responseType: 'text',
    });
    const syms = symbolsFromIndexCsv(String(r.data || ''));
    return syms.length ? syms : null;
  } catch (e) { return null; }
}

function readMembers(): Promise<void> {
  if (!membersReading) {
    membersReading = (async () => {
      const files = [...new Set([...INDEX_GROUPS, ...SECTOR_GROUPS].map((g) => g.file).filter(Boolean) as string[])];
      const now = Date.now();
      const due = files.filter((f) => { const k = memberLists.get(f); return !k || now - k.at > (k.ok ? DAY : 10 * 60 * 1000); });
      // Three at a time: NSE's archive does not like a burst.
      for (let i = 0; i < due.length; i += 3) {
        await Promise.all(due.slice(i, i + 3).map(async (f) => {
          const syms = await readList(f);
          const kept = memberLists.get(f);
          if (syms) memberLists.set(f, { at: Date.now(), symbols: syms, ok: true });
          else memberLists.set(f, { at: Date.now(), symbols: kept?.symbols || [], ok: false });
        }));
      }
    })().finally(() => { membersReading = null; });
  }
  return membersReading;
}

function membersOf(g: Group): string[] {
  return g.symbols || (g.file ? memberLists.get(g.file)?.symbols || [] : []);
}

// ---- previous-day OI from NSE's F&O bhavcopy ----

/** The one file inside a zip, read with the zip's own directory and zlib. */
export function unzipFirst(buf: Buffer): Buffer {
  // End of central directory: the last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad zip directory');
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error('zip method ' + method);
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** "2026-11-24", "24-Nov-2026" or "20261124" as "2026-11". */
export function yearMonth(v: string): string | null {
  const t = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-\d{2}/.exec(t) || /^(\d{4})(\d{2})\d{2}$/.exec(t);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^\d{1,2}[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(t);
  if (m) { const i = MONTHS.indexOf(m[1].toUpperCase()); return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`; }
  return null;
}

/** Stock futures' end-of-day OI out of a bhavcopy CSV, by the stock and its
 *  expiry's month ("EICHERMOT|2026-11" — a stock has one future a month, and
 *  the month does not depend on how either side writes the date or names the
 *  contract), and by NSE's contract name too. */
export function stockFuturesOi(csv: string): Map<string, number> {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  const head = (lines[0] || '').split(',').map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const tp = col('FinInstrmTp'), sym = col('TckrSymb'), xp = col('XpryDt'), nm = col('FinInstrmNm'), oi = col('OpnIntrst');
  const out = new Map<string, number>();
  if (tp < 0 || oi < 0 || ((sym < 0 || xp < 0) && nm < 0)) return out;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map((x) => x.trim());
    if (c[tp] !== 'STF') continue;
    const v = Number(c[oi]);
    if (!Number.isFinite(v)) continue;
    const ym = xp >= 0 ? yearMonth(c[xp]) : null;
    if (sym >= 0 && c[sym] && ym) out.set(`${c[sym]}|${ym}`, v);
    if (nm >= 0 && c[nm]) out.set(c[nm], v);
  }
  return out;
}

const prevOiKept = new Map<string, { at: number; date: string | null; oi: Map<string, number> }>();
const prevOiReading = new Map<string, Promise<{ date: string | null; oi: Map<string, number> }>>();

/** The OI at the end of the last trading day before `session` (YYYY-MM-DD). */
function previousOi(session: string): Promise<{ date: string | null; oi: Map<string, number> }> {
  const k = prevOiKept.get(session);
  if (k && (k.date || Date.now() - k.at < 10 * 60 * 1000)) return Promise.resolve(k);
  let p = prevOiReading.get(session);
  if (!p) {
    p = (async () => {
      const base = Date.parse(session + 'T00:00:00Z');
      for (let back = 1; back <= 10; back++) {
        const d = new Date(base - back * DAY);
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        const ymd = d.toISOString().slice(0, 10);
        try {
          const r = await axios.get(`https://archives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${ymd.replace(/-/g, '')}_F_0000.csv.zip`, {
            headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 15000, responseType: 'arraybuffer',
          });
          const oi = stockFuturesOi(unzipFirst(Buffer.from(r.data)).toString('utf8'));
          if (oi.size) { const v = { at: Date.now(), date: ymd, oi }; prevOiKept.set(session, v); return v; }
        } catch (e) { /* a holiday, or not there: the day before */ }
      }
      const v = { at: Date.now(), date: null, oi: new Map<string, number>() };
      prevOiKept.set(session, v);
      return v;
    })().finally(() => { prevOiReading.delete(session); });
    prevOiReading.set(session, p);
  }
  return p;
}

// ---- the quote, kept 5 s per expiry ----
type Row = { s: string; p: number; c: number | null; oi: number | null; oc: number | null };
const quoteKept = new Map<string, { at: number; payload: any }>();
const quoteReading = new Map<string, Promise<any>>();

export type HeatmapPayload = {
  ok: boolean; error?: string;
  expiries: string[]; expiry: string | null;
  index: { name: string; symbols: string[] }[];
  sector: { name: string; symbols: string[] }[];
  rows: Row[]; asOf: number; oiBase: string | null;
};

export async function getFuturesHeatmap(askedExpiry?: string): Promise<HeatmapPayload> {
  const empty = (error: string): HeatmapPayload => ({ ok: false, error, expiries: [], expiry: null, index: [], sector: [], rows: [], asOf: Date.now(), oiBase: null });
  const kc: any = getKiteClient();
  if (!kc || !kc.access_token) return empty('Zerodha is not connected');
  if (!memberLists.size) await readMembers(); else void readMembers();

  const nfo = await getNfoInstruments();
  const all = new Set<string>();
  for (const g of [...INDEX_GROUPS, ...SECTOR_GROUPS]) for (const s of membersOf(g)) all.add(s);
  const today = istDate(Date.now());
  const futs = nfo.filter((i: any) => i && i.instrument_type === 'FUT' && all.has(i.name) && i.expiry)
    .map((i: any) => {
      // The expiry's day as Zerodha's file has it (a Date at midnight UTC).
      const e = expiryParts(i.expiry);
      return { name: i.name as string, ts: i.tradingsymbol as string, exp: e ? `${e.y}-${String(e.m).padStart(2, '0')}-${String(e.d).padStart(2, '0')}` : '' };
    })
    .filter((f) => f.exp && f.exp >= today);
  const expiries = [...new Set(futs.map((f) => f.exp))].sort();
  const expiry = askedExpiry && expiries.includes(askedExpiry) ? askedExpiry : expiries[0] || null;
  if (!expiry) return { ...empty('No stock futures on the contract list'), expiries };

  const kept = quoteKept.get(expiry);
  if (kept && Date.now() - kept.at < 5000) return kept.payload;
  let reading = quoteReading.get(expiry);
  if (!reading) {
    reading = (async () => {
      const mine = futs.filter((f) => f.exp === expiry);
      const have = new Set(mine.map((f) => f.name));
      const groupsOf = (gs: Group[]) => gs.map((g) => ({ name: g.name, symbols: membersOf(g).filter((s) => have.has(s)) }));
      const quotes: Record<string, any> = {};
      const keys = mine.map((f) => 'NFO:' + f.ts);
      for (let i = 0; i < keys.length; i += 500) Object.assign(quotes, await kc.getQuote(keys.slice(i, i + 500)));
      // The session the quotes are from: the newest trade among them (after the
      // close and before the next open, that is the day just traded).
      let newest = 0;
      for (const q of Object.values(quotes) as any[]) {
        const t = q?.last_trade_time ? new Date(q.last_trade_time).getTime() : 0;
        if (Number.isFinite(t) && t > newest) newest = t;
      }
      const prev = await previousOi(newest ? istDate(newest) : today);
      const rows: Row[] = [];
      for (const f of mine) {
        const q = quotes['NFO:' + f.ts];
        const p = Number(q?.last_price);
        if (!q || !(p > 0)) continue;
        const pc = Number(q?.ohlc?.close);
        const oi = Number.isFinite(Number(q?.oi)) ? Number(q.oi) : null;
        const poi = prev.oi.get(`${f.name}|${f.exp.slice(0, 7)}`) ?? prev.oi.get(f.ts);
        rows.push({
          s: f.name, p,
          c: pc > 0 ? +(((p - pc) / pc) * 100).toFixed(2) : null,
          oi,
          oc: oi !== null && poi && poi > 0 ? +(((oi - poi) / poi) * 100).toFixed(2) : null,
        });
      }
      const payload: HeatmapPayload = {
        ok: true, expiries, expiry, index: groupsOf(INDEX_GROUPS), sector: groupsOf(SECTOR_GROUPS),
        rows, asOf: Date.now(), oiBase: prev.date,
      };
      quoteKept.set(expiry, { at: Date.now(), payload });
      return payload;
    })().finally(() => { quoteReading.delete(expiry); });
    quoteReading.set(expiry, reading);
  }
  return reading;
}

/** Read the member lists once as the server starts. */
export function warmHeatmapMembers() { void readMembers().catch(() => {}); }
