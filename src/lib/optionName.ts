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
