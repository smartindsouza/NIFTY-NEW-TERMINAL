// Overnight Gap Scorecard — single source of configuration.
// Everything tunable lives here; the engine, advisor, backtest and UI all read
// from this file so live and backtested logic can never drift apart.

export const GAP_CONFIG = {
  // --- schedule (IST) ---
  snapshotHHMM: '15:15',
  outcomeHHMM: '09:16',
  recoPriceHHMM: '09:21', // records the recommended option's early price

  // --- signal thresholds ---
  usFuturesPct: 0.25,        // |avg ES+NQ %| beyond this scores ±1
  lastHourPct: 0.15,         // NIFTY 14:15→15:15 move
  clvHigh: 0.8,
  clvLow: 0.2,
  vixDownPct: 2,             // VIX day change ≤ −2% → +1
  vixUpPct: 3,               // VIX day change ≥ +3% → −1
  vixCautionPct: 5,          // VIX day change ≥ +5% → cautionFlag
  brentPct: 1,
  rupeeWeakPct: 0.2,         // USDINR up > 0.2% = rupee weaker
  breadthUp: 35,             // advancers ≥ 35 → +1
  breadthDown: 15,           // advancers ≤ 15 → −1

  // --- weights (sum with ±1 scores → composite −9…+9) ---
  weights: {
    usFutures: 2,
    europe: 1,
    basis: 1,
    clv: 1,
    lastHour: 1,
    vix: 1,
    macro: 1,
    breadth: 1,
  } as Record<string, number>,

  // --- decision ---
  decisionThreshold: 5,      // |score| ≥ 5 fires a bias (no event/caution flag)

  // --- outcome classification ---
  gapClassThresholdPct: 0.2, // |open gap| ≥ 0.2% counts as a real gap
  lowMagnitudePct: 0.15,     // implied move below this % of spot → "may not beat costs"

  // --- backtest ---
  costsPts: 3,               // round-trip cost in NIFTY points for the equity curve

  // --- strike advisor ---
  targetDelta: 0.87,
  deltaBandLo: 0.85,
  deltaBandHi: 0.90,
  maxSpreadRs: 5,
  minOI: 50000,              // contracts; below this a strike is illiquid for overnight
  candidateRangePts: 600,    // CE: ATM down to spot−600 / PE: ATM up to spot+600
  strikeStepPts: 50,
  riskFreeRate: 0.065,
  skipExpiryTomorrow: true,  // never hold into expiry morning — roll to next expiry

  // --- external symbols (fetched via the app's existing axios Yahoo pattern) ---
  yahooSymbols: {
    es: 'ES=F',
    nq: 'NQ=F',
    dax: '^GDAXI',
    ftse: '^FTSE',
    brent: 'BZ=F',
    usdinr: 'USDINR=X',
  },

  // --- NSE trading holidays (IST dates, YYYY-MM-DD) ---
  // ⚠ MAINTENANCE REQUIRED: fill from the official NSE holiday circular each year.
  // Only nationally fixed dates are pre-listed. An unlisted holiday is harmless:
  // the snapshot job also self-detects a closed market (no fresh NIFTY candles
  // for today) and skips, so this list is a fast-path, not the only guard.
  //
  // THE FULL 2026 LIST (15 Nov 2026). This fallback is not a fast-path in
  // production — it is the ONLY list: NSE's site refuses the server, so
  // /api/calendar/holidays has been answering source "static-fallback" with the
  // four dates below it started with. That surfaced when the Expiry Skew history
  // loader asked Dhan for 14 Sep, 20 Oct and 10 Nov (all closed) and, worse,
  // dated two weekly expiries on holiday Tuesdays (20 Oct, 10 Nov) when the
  // contracts had expired on the Monday. Dates from NSE's 2026 circular as
  // published by brokers, and checked against the record: every weekday NIFTY did
  // not trade from 1 Jan to 11 Nov 2026 is on this list (14 of 14) and no listed
  // day traded. 24 Nov and 25 Dec are still to come. Needs the 2027 circular in
  // December.
  nseHolidays: [
    '2026-01-15', // Maharashtra municipal elections
    '2026-01-26', // Republic Day
    '2026-03-03', // Holi
    '2026-03-26', // Shri Ram Navami
    '2026-03-31', // Shri Mahavir Jayanti
    '2026-04-03', // Good Friday
    '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
    '2026-05-01', // Maharashtra Day
    '2026-05-28', // Bakri Id
    '2026-06-26', // Muharram
    '2026-08-15', // Independence Day (a Saturday)
    '2026-09-14', // Ganesh Chaturthi
    '2026-10-02', // Gandhi Jayanti
    '2026-10-20', // Dussehra
    '2026-11-10', // Diwali Balipratipada
    '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
    '2026-12-25', // Christmas
  ],

  // --- NIFTY 50 constituents for the breadth signal (NSE tradingsymbols) ---
  // ⚠ MAINTENANCE: index composition changes ~twice a year. The breadth signal
  // counts advancers among whichever of these return live quotes, so a stale
  // entry degrades gracefully (it simply doesn't count).
  nifty50: [
    'RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','ITC','LT','KOTAKBANK','AXISBANK','SBIN',
    'BHARTIARTL','ASIANPAINT','MARUTI','TITAN','SUNPHARMA','ULTRACEMCO','NESTLEIND','BAJFINANCE','BAJAJFINSV','WIPRO',
    'HCLTECH','TECHM','NTPC','POWERGRID','ONGC','COALINDIA','TATASTEEL','JSWSTEEL','HINDALCO','ADANIENT',
    'ADANIPORTS','GRASIM','CIPLA','DRREDDY','APOLLOHOSP','EICHERMOT','HEROMOTOCO','BAJAJ-AUTO','M&M','TATAMOTORS',
    'BRITANNIA','HINDUNILVR','TATACONSUM','SBILIFE','HDFCLIFE','INDUSINDBK','BPCL','SHRIRAMFIN','TRENT','BEL',
  ],
};

export type GapSignalKey = keyof typeof GAP_CONFIG.weights;
