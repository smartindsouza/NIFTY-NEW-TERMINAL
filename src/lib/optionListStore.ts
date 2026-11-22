// THE OPTION LIST IS REMEMBERED (22 Nov 2026). Martin: "Can you make the app
// remember my list. Because after the update every time it clears the list as
// shows only the nifty spot chart."
// The list of option charts lives in the session's storage (openOptionCharts),
// which is right while the app is open (the chart page, ScalperX, the chain and
// the positions card all read and write it there) but is thrown away whenever
// the app starts afresh: an update reloading it, the phone closing it in the
// background. So a copy is kept in the device's lasting storage every time the
// list changes, and put back when the app starts with no list of its own.
// Contracts that have expired since are left out when it is put back: a weekly
// one after its date, a monthly one after its month (their charts would be
// dead). Clearing the list by hand saves an empty list, so it stays cleared.
const SESSION_KEY = 'openOptionCharts';
const SAVED_KEY = 'openOptionChartsSaved';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** True when the contract's name says it expired before `today` (an IST date, yyyy-mm-dd). Unknown names are kept. */
export function optionExpired(tradingsymbol: string, today: string): boolean {
  const s = String(tradingsymbol || '').toUpperCase();
  const mo = s.match(/^[A-Z]+?(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d+(?:\.\d+)?(CE|PE)$/);
  if (mo) {
    const ym = `20${mo[1]}-${String(MONTHS.indexOf(mo[2]) + 1).padStart(2, '0')}`;
    return ym < today.slice(0, 7);
  }
  const wk = s.match(/^[A-Z]+?(\d{2})([1-9OND])(\d{2})\d+(?:\.\d+)?(CE|PE)$/);
  if (wk) {
    const m = wk[2] === 'O' ? 10 : wk[2] === 'N' ? 11 : wk[2] === 'D' ? 12 : Number(wk[2]);
    return `20${wk[1]}-${String(m).padStart(2, '0')}-${wk[3]}` < today;
  }
  return false;
}

const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** The list as it should be put back: what was saved, less the expired, once each. */
export function listToRestore(saved: any, today: string): any[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  return saved.filter((c) => {
    const sym = c && typeof c.tradingsymbol === 'string' ? c.tradingsymbol : '';
    if (!sym || !c.instrument_token || seen.has(sym) || optionExpired(sym, today)) return false;
    seen.add(sym); return true;
  });
}

/** At the app's start, before anything reads the list: put the saved one back if this session has none. */
export function restoreOptionList() {
  try {
    if (sessionStorage.getItem(SESSION_KEY) != null) return;
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(listToRestore(JSON.parse(raw), istToday())));
  } catch (e) { /* no list is the old behaviour */ }
}

/** Called with the list each time it changes. */
export function saveOptionList(list: any[]) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(Array.isArray(list) ? list : [])); } catch (e) {}
}
