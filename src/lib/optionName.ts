// Turning a Zerodha trading symbol into something readable.
//
// Lives here rather than inside the chart page because the Trade Journal needs
// the same answer, and importing it from AdvancedChart.tsx would drag that whole
// module into the journal's bundle. The chart keeps its own copy for now; this is
// the one the journal and the Excel export are built on, and the server mirrors
// it for the workbook.

export const UNDERLYING_LABEL: Record<string, string> = {
  BANKNIFTY: 'BANK NIFTY', FINNIFTY: 'FIN NIFTY', MIDCPNIFTY: 'MIDCAP NIFTY',
  NIFTY: 'NIFTY', SENSEX: 'SENSEX', BANKEX: 'BANKEX',
};
export const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
// Weekly symbols compress the month to one character: 1-9, then O, N, D.
export const WEEKLY_MONTH: Record<string, number> = {
  '1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'O':10,'N':11,'D':12,
};

export interface ParsedContract {
  underlying: string;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  /** "22 SEP" for a weekly, "SEP 2026" for a monthly. */
  expiryLabel: string | null;
}

/** NIFTY2692223350CE -> { NIFTY, 23350, CE, "22 SEP" }. */
export function parseContract(tradingsymbol: string): ParsedContract | null {
  const ts = String(tradingsymbol || '').trim().toUpperCase();
  const m = ts.match(/^([A-Z]+?)(\d.*)(CE|PE)$/);
  if (!m) return null;
  const [, rawUnder, middle, type] = m;
  const underlying = UNDERLYING_LABEL[rawUnder] || rawUnder;

  // MONTHLY: the two leading digits are the YEAR, not a day — BANKNIFTY27MAR58500CE
  // is March 2027. Printing "27 MAR" would read as the 27th, which on a trading
  // screen is a mistake waiting to be made.
  const monthly = middle.match(/^(\d{2})([A-Z]{3})(\d+)$/);
  if (monthly && MONTH_ABBR.includes(monthly[2])) {
    return { underlying, strike: Number(monthly[3]), optionType: type as 'CE' | 'PE',
             expiryLabel: `${monthly[2]} 20${monthly[1]}` };
  }
  const weekly = middle.match(/^(\d{2})([1-9OND])(\d{2})(\d+)$/);
  if (weekly) {
    const mon = WEEKLY_MONTH[weekly[2]];
    if (mon) return { underlying, strike: Number(weekly[4]), optionType: type as 'CE' | 'PE',
                      expiryLabel: `${weekly[3]} ${MONTH_ABBR[mon - 1]}` };
  }
  return null;
}

/** NIFTY2692223350CE -> "NIFTY 23350 CE 22 SEP". Falls back to the raw symbol. */
export function contractName(tradingsymbol: string): string {
  const p = parseContract(tradingsymbol);
  if (!p || p.strike == null) return String(tradingsymbol || '');
  return `${p.underlying} ${p.strike} ${p.optionType}${p.expiryLabel ? ` ${p.expiryLabel}` : ''}`;
}

const MONTH_TITLE = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/**
 * A contract as Lemonn's order list writes it: NIFTY26N1725250CE ->
 * "NIFTY 17 Nov 26 - 25250 CE". A monthly symbol carries no day, so it reads
 * "BANK NIFTY Mar 27 - 58500 CE". Falls back to the raw symbol.
 */
export function orderName(tradingsymbol: string): string {
  const ts = String(tradingsymbol || '').trim().toUpperCase();
  const m = ts.match(/^([A-Z]+?)(\d.*)(CE|PE)$/);
  if (!m) return String(tradingsymbol || '');
  const [, rawUnder, middle, type] = m;
  const underlying = UNDERLYING_LABEL[rawUnder] || rawUnder;
  const monthly = middle.match(/^(\d{2})([A-Z]{3})(\d+)$/);
  if (monthly && MONTH_ABBR.includes(monthly[2])) {
    return `${underlying} ${MONTH_TITLE[MONTH_ABBR.indexOf(monthly[2])]} ${monthly[1]} - ${Number(monthly[3])} ${type}`;
  }
  const weekly = middle.match(/^(\d{2})([1-9OND])(\d{2})(\d+)$/);
  const mon = weekly ? WEEKLY_MONTH[weekly[2]] : 0;
  if (weekly && mon) return `${underlying} ${weekly[3]} ${MONTH_TITLE[mon - 1]} ${weekly[1]} - ${Number(weekly[4])} ${type}`;
  return String(tradingsymbol || '');
}

// ── a contract as the search box lists it (17 Nov 2026) ──
// Martin, of the search results, which were Zerodha's own symbols
// (NIFTY26N1723500CE): "Show the search in this format
// NIFTY 17th (w) NOV 23500 CE
// 17 NOV WEEKLY".
// The two lines are made from what the row itself says — its name, expiry date,
// strike and type — rather than read back out of the symbol, so a name that
// ends in digits (SENSEX50, NIFTYNXT50) cannot be mistaken for a year. Only
// weekly-or-monthly comes from the symbol: after the name and the year a weekly
// has one character for the month and two digits for the day (26 N 17), a
// monthly the month's three letters (26 NOV). A monthly has no "(w)" and reads
// MONTHLY; the year is given on the second line only when it is not this year
// (NIFTY lists contracts years out). The server's search matches these same
// words when they are typed (server/instrument_search.ts).
export interface SearchLabel { title: string; sub: string }

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th", 23 -> "23rd". */
export const ordinal = (d: number): string => {
  const two = d % 100;
  return `${d}${two >= 11 && two <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][d % 10] || 'th')}`;
};

/** The two lines for an option or a future; null for anything else, which keeps its own symbol and name. */
export function searchLabel(
  i: { tradingsymbol?: string; name?: string; instrument_type?: string; expiry?: any; strike?: any } | null | undefined,
  nowMs: number = Date.now(),
): SearchLabel | null {
  const type = String(i?.instrument_type || '').toUpperCase();
  if (!i || (type !== 'CE' && type !== 'PE' && type !== 'FUT')) return null;
  const when = i.expiry instanceof Date ? (Number.isNaN(i.expiry.getTime()) ? '' : i.expiry.toISOString()) : String(i.expiry || '');
  const e = /^(\d{4})-(\d{2})-(\d{2})/.exec(when);
  if (!e) return null;
  const y = Number(e[1]), m = Number(e[2]), d = Number(e[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ts = String(i.tradingsymbol || '').toUpperCase();
  const given = String(i.name || '').toUpperCase();
  // What is left of the symbol after the name: "26N1723500CE" or "26NOV23500CE".
  const cut = /^(.*?)(\d{2}(?:[A-Z]{3}|[1-9OND]\d{2})\d*(?:\.\d+)?(?:CE|PE|FUT))$/.exec(ts);
  const under = given && ts.startsWith(given) ? given : (cut ? cut[1] : given);
  if (!under) return null;
  const rest = ts.startsWith(under) ? ts.slice(under.length) : (cut ? cut[2] : '');
  const weekly = type !== 'FUT' && /^\d{2}[1-9OND]\d{2}/.test(rest) && !/^\d{2}[A-Z]{3}/.test(rest);
  const mon = MONTH_ABBR[m - 1];
  const strike = Number(i.strike);
  if (type !== 'FUT' && !(strike > 0)) return null;
  const thisYear = new Date(nowMs + 5.5 * 3600 * 1000).getUTCFullYear();     // the year in India
  return {
    title: type === 'FUT'
      ? `${under} ${ordinal(d)} ${mon} FUT`
      : `${under} ${ordinal(d)}${weekly ? ' (w)' : ''} ${mon} ${strike} ${type}`,
    sub: `${d} ${mon}${y !== thisYear ? ` ${y}` : ''} ${weekly ? 'WEEKLY' : 'MONTHLY'}`,
  };
}
