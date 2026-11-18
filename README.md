<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/acf2a73d-ba83-4660-b80b-68831c5700b6

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Read-only market snapshot (`/api/market-snapshot`)

For the external ~09:32 IST "first 15 minutes vs overnight cues" analysis. Read-only:
quotes, historical candles and the instrument list only — no orders, positions or funds,
and never the Kite token or keys.

- Set `SNAPSHOT_API_KEY` on Railway (a long random string). Without it every call gets 401.
- Call: `curl -s "https://nifty-new-terminal-production.up.railway.app/api/market-snapshot?key=$SNAPSHOT_API_KEY"`
- 401 = missing/wrong key · 503 = Kite session not ready/invalid · 200 = snapshot; any
  section that failed is listed in `errors` and the rest is still returned.
- Cached ~20 s (`cache_age_s` in the response).
- Test (no network, fake Kite client): `npx tsx server/market_snapshot.test.ts --print`

## Today's Bias (`/api/bias`)

The scheduled ~09:33 IST analysis posts its note here; the terminal shows it at the top of
Home, draws its levels on the NIFTY chart (Indicators → Today's Bias Levels) and alerts once a day.

- Auth: `X-API-Key: $SNAPSHOT_API_KEY` header (or `?key=`). 401 otherwise. Body ≤ 50 KB.
- `POST /api/bias` — upserts by `date` (a re-post replaces the note, keeps any `outcome`).
  Response: `{ ok, date, replaced, warnings[] }`; 400 lists every validation error.
- `GET /api/bias/today` — today's (IST) note or `{"status":"pending"}`.
- `GET /api/bias/history?days=30` — newest first. Stored in the app's sqlite (`daily_bias`), never deleted.
- Test: `npx tsx server/bias.test.ts`

```
curl -s -X POST "https://nifty-new-terminal-production.up.railway.app/api/bias" \
  -H "Content-Type: application/json" -H "X-API-Key: $SNAPSHOT_API_KEY" \
  -d '{"date":"2026-10-21","generated_at":"2026-10-21T09:33:05+05:30","status":"ok","bias":"bearish","confidence":"moderate","headline":"Gap-up faded in the first 15 min — sell rallies below 22,950","summary":"Opened +45 vs GIFT-implied +60; three red opening candles.","levels":{"trigger":22880,"invalidation":22955,"next_reference":22845,"or_high":22950,"or_low":22880,"first_candle_high":22950,"first_candle_low":22905,"prev_high":23175.25,"prev_low":22845,"prev_close":22888.95,"cpr_pivot":22969.7,"cpr_tc":23010.3,"cpr_bc":22929.1},"gap":{"actual_open_pts":45,"gift_implied_pts":60},"factors":[{"name":"Opening range","read":"bearish","note":"Three red candles after a gap-up"}],"us30":{"close":46612,"change_pts":-38,"change_pct":-0.08,"driver":"Flat ahead of earnings"},"error":null}'
```

## "Check bias" button (`/api/bias/run`)

On-demand Claude note under the chart (`public/bias-panel.js`, a `<bias-panel>` web component;
`server/bias.cjs`, mounted in `server.ts` right after the Today's Bias routes). The numbers are
computed in code from the same snapshot as `/api/market-snapshot` (built in-process, no HTTP hop)
plus US futures from Yahoo Finance; Claude (`claude-sonnet-5-5`) only judges and writes the note.

- `GET /api/bias` — latest note (on-demand, or today's 09:35 scheduled note if newer) + today's history.
- `POST /api/bias/run` — fresh note now; `?force=1` skips the 60 s cooldown / "no new candle" reuse.
  No key: the app has no login, so a key in the page would be public. Cost is bounded by the
  cooldown, candle reuse and `BIAS_DAILY_CAP` (default 60 runs/day).
- `POST /api/bias` — unchanged: the scheduled note, key required, stored in sqlite (see Today's Bias).
- Railway: `ANTHROPIC_API_KEY` (required). Optional: `BIAS_MODEL`, `BIAS_EFFORT`, `BIAS_COOLDOWN_S`,
  `BIAS_DAILY_CAP`, `BIAS_TIMEOUT_S`, `BIAS_US=off`, `BIAS_STORE_FILE` (default `data/bias-latest.json`,
  reset on redeploy).

```
curl -s -X POST https://nifty-new-terminal-production.up.railway.app/api/bias/run
curl -s https://nifty-new-terminal-production.up.railway.app/api/bias
```

## Telegram Auto-Trade (`/telegram-signals`, `/api/signals/*`)

Reads ONE Telegram channel as your own account and trades its NIFTY / SENSEX
BUY calls automatically. Code: `server/signal_parser.ts` (reads the messages),
`server/signal_ladder.ts` (moves the stop), `server/signal_trader.ts` (orders,
Telegram, alerts), page `src/pages/TelegramSignals.tsx`.

- **Railway variables:** `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (my.telegram.org →
  API development tools), `TELEGRAM_BOT_TOKEN` (@BotFather — alerts with Exit /
  Keep trailing buttons; without it alerts go to Saved Messages), `SIGNALS_PIN`
  (protects setup and the Practice/Live switch; Off and Exit never need it).
- **Setup on the page:** log in with your phone + Telegram code (once), pick the
  channel, press Start in your bot, then switch Practice or Live.
- **Entry:** waits for the TP/SL message that follows the call, then buys
  `lots` × lot size with a LIMIT at entry-high + `allowAbove` (default 2) only
  while the price is at or below that and above the SL; waits up to `waitMin`
  (10) minutes, else skips. Nearest expiry, exact strike, MIS. Max `maxTrades`
  (3) a day, no entries after `lastEntry` (15:00).
- **Lots per trade:** 1 to 25, or "Max possible" (as many as the funds allow, up
  to `maxLotsCap`; one lot if the funds cannot be read). One lot was not allowed
  from 2 to 16 Nov 2026 and is again. The number saved is only ever changed on
  the page, behind the PIN.
- **Stop and targets** (channel trades): the SL is exactly the message's, armed
  in `premium_exit_rules`. TP1 → SL to the fill price, **and with 2 or more
  lots half of them are sold** (2 → 1, 3 → 1, 4 → 2; a trade holding one lot
  sells nothing at TP1) · TP2 → the SL stays · TP3 → SL to TP1 · at 2 × the fill
  price everything left is sold. Square-off at `squareOff` (15:15). Moving the SL
  on the chart hands the trade to you. (My Order trades keep the older ladder:
  TP2 → SL to TP1, TP3 → SL to TP2 and trailing, no half and no 2 × target.
  The My Order screen was removed on 16 Nov 2026 — see ScalpPro's Limit /
  Trigger; the server's `/api/signals/manual*` path is still there, unused by
  the app.)
- **Ignored:** every other message, messages older than 3 minutes, anything that
  fails the checks (each skip is reported with its reason).
- Tests: `npx tsx server/signal_parser.test.ts` and
  `npx tsx server/signal_trader.e2e.ts` (fake Kite + fake Telegram, no network).

## Expiry Skew (`/expiry-skew`, `/api/skew/*`) — Practice only

Martin's own option-chain indicator. Every 5 minutes it scores two readings
against their last 60 trading days: **skew** (implied volatility of the put 200
points below NIFTY minus the call 200 above) and **flow** (put vs call open
interest and volume added near the money). The first score of ±1.5 between
10:00 AM and 2:30 PM logs a practice buy of the option 200 points in the money,
closed at 3:15 PM. **It never places an order** — it is handed no order function.
Code: `server/expiry_skew_calc.ts` (the calculation, a port of the research
code), `server/expiry_skew.ts` (history, live readings, practice log), page
`src/pages/ExpirySkew.tsx`. The study behind it is the project doc
`option-strategy-search-nov-2026`.

- **History** (the 60 days each reading is scored against) comes from Dhan's
  expired-option feed, loaded in the background at start-up (a few minutes the
  first time) and one day each morning after.
- **Today** comes from Zerodha minute candles with open interest, so Zerodha must
  be logged in before 10:00 AM. A signal bar computed more than four minutes late
  is logged as missed, not traded.
- `GET /api/skew/status` (what the page shows) · `GET /api/skew/day?day=` (stored
  numbers for a day) · `GET /api/skew/days` (history loader) ·
  `GET /api/skew/compare?day=` (one past day built from Zerodha and from Dhan,
  side by side) · `POST /api/skew/settings {enabled}`.
- The rule is frozen (14 Nov 2026). Do not tune it while it is on test.
- Tests: `npx tsx server/expiry_skew.test.ts` (the calculation against the
  research numbers on a real day) and `npx tsx server/expiry_skew.e2e.ts` (the
  whole engine replaying that day with a fake Zerodha and a fake Dhan).

## NIFTY futures feed recorder (`/api/research/fut-ticks`)

Keeps every update of the front-month NIFTY future (price, last quantity, volume,
best bid/ask, OI) in its own database file `fut_ticks.db`, 09:15 AM – 3:40 PM, for
45 days — the raw material for judging a footprint chart on evidence. Records
only. `GET /api/research/fut-ticks/days` lists what is stored;
`GET /api/research/fut-ticks?day=YYYY-MM-DD` returns a day (prices ×100).
Code: `server/fut_recorder.ts`. Test: `npx tsx server/fut_recorder.test.ts`.

## Trade Journal: charges and capital (`/journal`, `/api/journal`)

Every journal trade carries what it cost (brokerage, STT, exchange and SEBI fees,
stamp duty, GST), what it made after that, and the account balance once it was
closed; every day carries what the account opened with and what was left.

- **Charges** are Zerodha's own calculation for each executed order (Kite Connect
  "virtual contract note", `POST /charges/orders`), shared among the journal rows
  that order opened or closed, by quantity. So an exit taken in two parts costs
  two brokerages, as it does at the broker. Fetched once per order and kept.
- **Rates stay current by themselves.** Once a trading day, on the first import
  that has orders, a reference buy and sell go through the same calculator and
  every rate is read back out of the answer. If a rate has moved, a new rate card
  starts that day and the journal page says what changed; older trades keep the
  rates of their own day. The written-down rates in `server/trade_charges.ts`
  are only the fallback.
- **"est."** on the page marks a figure worked out by the formula instead of
  asked from Zerodha: trades from before 16 Nov 2026, a carried position's entry,
  a row corrected by hand, or a moment the calculator could not be reached. The
  formula matched Zerodha to the paisa on six orders on 16 Nov 2026 (including
  Zerodha's whole-rupee rounding of stamp duty per order).
- **Capital** is Zerodha's opening balance for the day (funds call), stored once
  per day between 9:00 AM and 6:00 PM IST, plus funds added and less funds
  withdrawn. "Capital after" a trade is that plus everything closed so far, after
  charges. Zerodha does not give past days' balances, so days before 16 Nov 2026
  show charges and net only.
- Realized P&L on the page and in the Excel export is still gross, so it matches
  the Kite app; Charges and Net P&L sit beside it. The export has the same
  columns and a Days sheet.
- Nothing here places, changes or cancels an order.

Code: `server/trade_charges.ts`; wiring in `server.ts` (journal import, read,
correction, export); page `src/pages/TradeJournal.tsx`.
Test: `npx tsx server/trade_charges.test.ts`.

## Trade Journal: the page is Lemonn's Positions screen (v315)

`src/pages/TradeJournal.tsx`, arithmetic in `src/lib/journalStats.ts`. Martin
sent four pictures of Lemonn — Positions, the wallet, Orders, Historical P&L —
and asked for the journal to be laid out as they are, "100% exact". Every size
on the page is measured off those pictures (1290px wide: a 430pt phone at 3
pixels a point) and the page's own pictures were measured back against them;
the ink is within a third of a point of Lemonn's. Surfaces and text are the
app's theme (dark and light), the chips and the reds, greens and blues are
Lemonn's. Nothing the old page knew was dropped. Three screens:

- **`/journal`** — the title and one round button (the wallet); then:
  - **The card.** Total Returns (the two arrowheads switch it to Net Returns,
    after charges — remembered), D | W | M | Y, Unrealised and Realised
    Returns, and a row Lemonn does not have: Total Trades, Win Rate, Charges.
    Under a line, the week's five days as dots (red a loss, green a profit,
    blue today; the eye hides the colours) and "P&L Analysis".
  - **Open | History.** Until one is tapped it is Open when a trade is open and
    History otherwise. Under it the trades, a day to a row, newest first, the
    newest open; ten days at a time, then "Load more". A trade's card has when
    it went in and out, a chip for how it ended (Open, Target, Stop, Manual,
    Kite …) and one for Buy or Sell, the contract as Lemonn writes it
    ("NIFTY 17 Nov 26 - 25250 CE"), Qty, Entry and Exit prices, and what it
    made (an open trade: what it is making, live). A tap opens the rest:
    charges and their breakdown, gross, net, the balance after, what the chart
    showed at the entry, Correct price, and Delete (two taps). A day's
    "Opened … Left …" line closes its cards.
  - **Filter** — All, Today, 7 days, 30 days or a custom range; Calls or Puts;
    Profit or Loss — and the three actions the old header had: Import from
    Kite, Refresh, Excel (for the range chosen; "All" is from the first trade).
- **`/journal/funds`** — the wallet button: Zerodha's Available Margin, Used
  Margin, and under "View details" the rest of its margin statement, with the
  account's id. Lemonn's has Deposit, Withdraw and All Transactions; Zerodha
  gives an app none of those, so they are not there.
- **`/journal/analysis`** — Historical P&L: Today's | Week | Month | Year, each
  stepped back and forth, a total card (green, or red for a loss), and a
  breakdown — the month as a calendar, a week's days, a month's weeks, a
  year's months — whose cells are coloured by what they made. A tap on a cell
  goes one step closer; a day lists its trades. The two round buttons jump to
  a date and download the period as Excel.

**The card's day turns over at 9:00 AM IST, not at midnight** (`sessionDay`).
Midnight in India is 10:30 PM in Dubai, and the evening is when a day's trades
are looked at; "D" stays on the session that has just ended through the night,
as a broker's positions page does. What names a date — "Today", "Yesterday",
the calendar's Today cell — still goes by the date in India.

The whole journal is loaded once (`/api/journal?limit=20000`) and every period
is cut from it in the browser. What is open comes from `/api/positions-live`,
the banner's own question, every five seconds while the page is up; when a
position opens or closes the journal is read again. Nothing on the server
changed. Test: `npx tsx src/lib/journalStats.test.ts`.

## Trade guard: every order that opens a trade

`server/trade_guard.ts`. Martin's own rules — no new trade before 10:00, 4 trades
a day, stop for the day at ₹3,000 loss. A rule can be tightened at once and
relaxed only from the next trading day. It is checked for:

- the order ticket and Quick Trade (`POST /api/orders` with `journal: true`);
- My Order — the count and loss rules when it is created, every rule when it
  fires (server path only; its screen was removed on 16 Nov 2026);
- armed orders (`server/triggers.ts`), since 16 Nov 2026 — the same two checks.
  One refused at its level is marked FAILED with the rule as the reason
  ("… No order sent.") and is announced as "Order NOT placed".

An order that CLOSES a position is never checked: an armed sell against a long
that is held, an armed buy against a short. If the positions cannot be read a
buy is treated as an entry and a sell is let through. The Telegram auto-trade
has its own limits and is not touched.

**What counts as one of the day's trades** (`countEntries`): every filled order
on NFO / BFO that opened or added to a position — a buy from flat or on top of a
long, a sell from flat or on top of a short, and an order bigger than the
position it closes (it turns it over). An order that only brings a position back
towards flat is an exit and is never counted. Each contract is followed through
the day in the order its orders filled, starting from what was held overnight.
Orders placed in the Kite app count; the Telegram auto-trade's do not. (Until
v305 it was "filled buys", which missed a short until it was bought back.)

`npx tsx server/trade_guard.test.ts`, `npx tsx server/triggers.test.ts`.

## Home: open-interest totals over every strike

The Home screen's "Open Interest Distribution" card adds up **every strike** of the
nearest expiry, so it matches other apps and NSE. The option chain itself only
carries strikes near spot (NIFTY: within 1,500 points), so the far strikes' OI is
read once a minute in the background (`getLiveOptionChain` in
`server/kite_service.ts`, field `oiAll`) and added per contract. The card says
what it is showing ("all 201 strikes · put : call 0.88"); for the first seconds
after a restart, or if that read fails for five minutes, it shows the near-strike
totals and says "strikes near spot". Everything that decides — the Home decision,
PCR Context, max pain, the zones — still uses the strikes near spot.
Test: `npx tsx server/analytics_engine.test.ts`.

## Chart: price range fits itself, compact axes on phones

`src/pages/AdvancedChart.tsx`. The price scale **auto-fits** the candles on screen,
so scrolling back in time or zooming never leaves them off the top or bottom of
the pane. The rules are the charting library's (and TradingView's): while auto-fit
is on, a vertical drag in the chart body does nothing; **dragging the price axis**
takes over by hand (the body can then be dragged up and down too); a double-tap on
the axis, the jump-to-latest button or a reload hands it back.
While a trade is open and the latest candle is on screen, the fit also keeps the
trade in view: the entry, the armed SL and TP on the traded option's chart, and
their mirrors on the spot chart. A level that would stretch the range past five
times the candles' own is left out (it would flatten the candles), a little room
is left beyond the stop and the target so they can be dragged further out, and
the range holds still while a line is being dragged.
On phones (under 768px wide) both axes are drawn at 10px, the price axis is 52px
wide, and tick labels drop ".00" — sizes measured off the Lemonn app. Desktop text
is unchanged. The indicators list closes on a tap anywhere on the chart.

## Chart: a change of timeframe is fast

Measured on 16 Nov 2026: a change to a timeframe the server had nothing fresh
for took 1.4 s (15m), 2.1 s (3m) or 3.6 s (1m) on the server alone — about
0.65 s plus 0.3 s per thousand candles — because every refresh asked the broker
for the whole window again, and for an index twice (its volume comes from a
futures contract).

- **`server/history_tail.ts`** — the full window is fetched once a day per
  instrument and interval and kept in memory; a refresh asks only for today's
  candles and puts them on the end. Same list as a full fetch (`npx tsx
  server/history_tail.test.ts`). Daily candles are always fetched in full.
  `/api/diagnostics` → `historyTail` counts both kinds and the candles each
  carried.
- **One download, not two** — the chart and the "decision" read ask for the same
  address at the same instant on every change; they now share the download
  (`fetchTaShared` in `src/pages/AdvancedChart.tsx`).
- **The timeframes you use are kept ready** — the last three you chose are
  remembered (`timeframesRecent` in the browser). While a chart is on screen the
  other two are fetched in the background, 3 s after the chart loads and every
  3 minutes while the market is open. A change to one of them paints at once
  from memory and the newest candles follow a moment later; what is painted
  first is never more than about 3 minutes old.

## Chart on a phone: fills down to the tool bar

`src/pages/AdvancedChart.tsx`.

- **No strip under the option chart.** The row of "in the money / break even /
  time cost / hope value / IV" chips went on 16 Nov 2026, and the app no longer
  calls `/api/option-analytics` (the endpoint is still on the server). Delta,
  theta a day and IV are behind the **i** button on the option chart.
- **The chart ends exactly where the row of five begins**, whatever is above
  it. The positions banner that appears while a trade is on pushes the page
  down; the chart gives up exactly that much and takes it back when the trade
  is exited. Since v311 this is ordinary layout: the first screen's height is
  measured (from the page's top to the fixed Option Chain | ScalpPro buttons),
  the row of five has its own room at the foot of it, and the chart has what
  is left. (Until v310 the tool bar was fixed over the page's foot and the
  chart was sized to the bar's top on the screen; an index chart with the bias
  card shown lost a 48px band to that sum, which it has back.)
- **Any chart re-fits itself when it is moved**, not only when it is resized
  ("THE CHART MOVED WITHOUT CHANGING SIZE").

## Chart on a phone: header, a row of five, Settings

`src/pages/AdvancedChart.tsx` ("THE LEMONN LAYOUT ON A PHONE"). Below 768px wide
the chart page is laid out the way the Lemonn chart screen is. Every control
runs the code its old button ran — only where it is has changed. The desktop
tool bar and the split view are untouched.

- **Header:** a search button at the left, which opens the symbol search in the
  header with its results below, the chart's name (the index and option
  choosers), and at the right a globe that opens Market context (v314: it was
  a pull tab half-way down the chart's right edge, which the desktop keeps;
  Martin asked for it at the top right, where search used to be). Under it, the live price with the day's change (against the last
  close of the previous session) and the clock. The "Advanced Trading Chart"
  title row is gone on a phone.
  - **No back arrow** (v312). It stood at the left until Martin had it removed
    and search moved into its place; the app's bottom bar goes everywhere it
    went. ScalpPro keeps its own back arrow.
  - **The index tab is one width** (v313): half the row, whether an option's
    chart is open beside it or not. With no option chart open it used to run
    the whole row and shrink when one was opened; Martin asked for it to stay
    the same. The half an option's tab would take is simply left empty.
  - **The two choosers are folder tabs** (v309; Martin, of ScalpPro's top row:
    "Use the same design at the top for the main nifty screen"). The chart on
    screen is the tab, in the chart's own colour, so the tab, the price under
    it and the chart are one piece; the other chart's name is plain words
    beside it. A name switches to that chart; its chevron opens its list. On
    the desktop they are the two outlined boxes they were.
- **A row of five under the chart:** Range, Interval, Indicators, Drawings,
  Settings.
  - **Range** — 1D, 2D, 5D, 1M, All: how many sessions back from the newest
    candle are on screen. The button shows the choice until the timeframe or
    the chart changes.
  - **Interval** — the same chooser as before, drawn as the value with its name.
- **Settings** holds what used to fill the right of the bar: Trailing SL (on the
  option chart of an open trade; On/Off at the end of the row), Trade guard
  (today's count at the end of the row, red while entries are blocked), SL & TP
  (the levels new trades get), Reload, and Sync positions (from Zerodha).
  My order was a row here on an index chart until 16 Nov 2026, when Martin asked
  to "remove My order screen so that I can place limit/trigger orders directly
  from the charts" — that is ScalpPro's Limit / Trigger now. No My Order was
  waiting on the live app when the screen went.
- **Few words.** Martin, 16 Nov 2026: "as simple as the lemon app ... Keep the
  texts such as descriptions etc to minimal or avoid it wherever possible." The
  sheets here have no headings and no descriptions, and a row's name is two
  words at most. New screens follow the same rule.
- **No Quick Trade on a phone** (v310). From v301 it was a round ⚡ button
  floating over the chart; Martin, 17 Nov 2026, with ScalpPro's bar to trade
  from: remove it, it is of no use any more. So on a phone's chart page Quick
  Trade is never on: no strike menu and no BUY / SELL pill on a tap, and **the
  SL and TP chips of an open trade do not move here** — they are labels, and a
  press on one says "Move SL / TP in ScalpPro". They were not let loose
  instead: that no chart gesture changes an order while Quick Trade is off is
  his own rule of 30 Oct, and a thumb scrolling this page must not be able to
  move a stop. They move on ScalpPro, as they always have without the switch.
  The desktop's tool bar keeps its ⚡ button and everything it switches on.
- **App Diagnostics is a screen of its own** (v314). The panel the Diag tab
  opens runs from under the app header to 8px above the app's bottom bar on
  every page — the chart page too, where it is drawn over the chart's own tool
  bar (the row of five and Option Chain | ScalpPro) — on a plain sheet of the
  app's background, in a frame of its own, so its foot is seen to end above
  the bottom bar. The bottom bar is never covered: Diag closes it and every
  tab works. (Through v313 it stopped at the chart's tool bar, where its
  readout was cut off and looked as though it carried on under the buttons;
  Martin asked twice for it to show above them.) Desktop keeps the floating
  card.
- **The bar does not jump when you come back from Home** (v310). The page fades
  in, and the fade the animation library gives starts from a transform — which
  makes the page, for that half second, the box its fixed bar is placed
  against. The bar sat 112px too high and then dropped. The page's fade is
  opacity only now (`page-fade-in` in `src/index.css`).
- **The chart keeps its layers to itself** (`max-md:isolate`): the trade chips,
  line tools and the like are no longer painted on top of an open sheet (the
  chips used to lie across the Trade guard sheet). The RSI pane does the same,
  so the strike menu, which is taller than a short phone chart, lies over the
  pane and every row of it can be pressed.
- **Option Chain | ScalpPro**, fixed above the app's bottom bar: Option Chain
  opens the Chain page, ScalpPro the two-chart screen (below). They were the
  second row of the tool bar until v311; the row of five now scrolls with the
  page and these two stay.

## Chart on a phone: the page scrolls down to cards

`src/components/ChartCards.tsx`, `src/pages/AdvancedChart.tsx` ("THE PHONE'S
PAGE ENDS WHERE THE FIXED BUTTONS BEGIN", "THE ROW OF FIVE IS PART OF THE PAGE
NOW"), `src/App.tsx`. Martin, 17 Nov 2026, with three screenshots of Lemonn's
chart screen scrolled down: "I want a vertical scrolling screen in the charts
section which scrolls down to show the things shown in the screenshot."

- **The first screen is what the chart page was:** header, price, chart, the
  row of five, ending at Option Chain | ScalpPro. Nothing on it has moved.
- **Swipe up** from anywhere that is not the chart — the row of five, the two
  buttons, the bottom bar, the header — and the page scrolls. A drag on the
  chart is still the chart's. The row of five goes up with the chart; Option
  Chain | ScalpPro and the bottom bar stay.
- **A small header comes down** once the page's own has scrolled away: the
  chart's name over its price and the day's change. Its arrow returns to the
  top.
- **A button of the row of five brings the page back to the top first**, so its
  sheet opens above the row as it always has.
- **The cards**, in Lemonn's order:
  - **Your Positions** — today's P&L (`/api/positions-live`, the banner's own
    figure); a tap opens the Trade Journal. No order history, as he said.
  - **Open Interest (OI)** — put and call open interest of every strike of the
    expiry, a bar split at their share, and the put : call ratio. **Calls are
    red and puts are green, as on Home** (v317; he asked for the call OI "in red
    like in the homepage"): each total is in its own colour and so is its end of
    the bar. Lemonn's card has the colours the other way round, and this one did
    until then — the same totals were red on one page and green on the next.
    The sides did not move: puts on the left, calls on the right.
  - **Daily Performance** — the low and high of the latest session of the chart
    on screen, with a bolt where the last price stands between them. On an
    option's chart it is the option's own day. Read off the chart's candles: no
    request.
  - **Top Options (By Trade Volume)** — the five most traded contracts of the
    expiry, All | Call | Put. "Price" at the right switches each row between
    its price and its volume. A tap on a row opens that option's chart.
- **Zerodha has no "most traded" list.** It gives each contract's volume for
  the day (`volume` in a quote); the list is the app's option chain
  (`/api/option-chain`, which already carries it) sorted by that. The chain
  covers the strikes within 1,500 points of NIFTY, where the most traded
  contracts always are.
- **An option's chart shows its index's cards** (the index is read off the
  option's symbol). GIFT NIFTY and the other reference charts have no option
  chain here: they show Your Positions and Daily Performance.
- **It asks only while a card is on screen** — positions every 5 seconds, the
  chain every 15 — and not at all at rest, when the cards are under the fold.
- **Measured, not judged by eye.** His screenshots are 1290px wide, a 430pt
  phone at 3 pixels a point; every size and distance in the cards is a pixel
  count off them, and each text's size is the Manrope size whose width it has.
  The surfaces and text are the app's theme (so the light theme works); the
  red, green, lime and blue are Lemonn's.

## The phone's bottom bar

`src/components/Header.tsx`. Home, Chart, Journal, News, then Diag and More.
The third tab was the Option Chain until 16 Nov 2026 (Martin: "remove the option
chain screen from the bottom tab and replace it with trade journal"); the chain
is one tap from the chart page (the button under the chart) and in the More
sheet, which holds every page that is not a tab. The bar is not shown on the
ScalpPro screen.

## ScalpPro: two charts and a Buy / Sell bar (phone)

`src/pages/ChartWorkspace.tsx` (`ScalpScreen`) and `src/pages/AdvancedChart.tsx`
("THE SCALPPRO SCREEN", the `scalp` prop). Opened by the ScalpPro button under
the chart; laid out the way Lemonn's ScalpPro is. It is the same two panes the
desktop split view uses, stacked.

- **Top chart: the index. Bottom chart: an option** — the one last on screen in
  this session, or, with none, the at-the-money Call of the nearest expiry. Each
  has its name and live price above it, written as Lemonn writes them
  ("25,291.10 146.80 ▲ (0.58%)"), and its own interval in the corner. There are
  no zoom buttons (v303 had Lemonn's; Martin asked for them to go): a pinch
  zooms, as on every chart.
- **The look is Lemonn's, measured** (v307; Martin: "100% match the UI ... make
  sure the text size and the button sizes match them as it is 100%"). His
  screenshot of Lemonn is 430pt wide at 3 pixels a point, so every size on this
  screen is a pixel count off it divided by three; they are written where they
  are used (`data-scalp-head`, "THE SCALPPRO BAR", `ScalpScreen`). In short:
  - **no grid lines** on these two charts (every other chart keeps its grid);
  - the name and price lines are **on the chart's own surface**, and the strip
    between the charts and the bar are the page's darker one;
  - **the screen is set in Manrope, Lemonn's own font** (v308; v307 used the
    phone's system font), not the app's fixed-width one. Martin asked to "copy
    the same fonts as in the screenshot", and the font could be named: the
    widths of Lemonn's texts are Manrope's at whole-pixel sizes to within a
    point. It is free (Open Font Licence) and loaded by a `<link>` in
    `index.html` — not by the `@import` in `src/index.css`, which is not in the
    stylesheet the build produces; the two ScalpPro charts draw their figures
    in it too (`SCALP_CHART_FONT`). If it cannot be fetched the screen shows
    the system font;
  - names, prices, buttons and the switch are 12px (capitals 8.67pt tall), the
    quantity 13px, "Req" 10px extra-bold and "Funds" 8px — small, and theirs;
    Buy is 36pt tall, Sell 34pt with a 1pt outline, both ending 4pt from the
    screen's edge; the stepper's circles are 32pt; amounts always show two
    decimals;
  - **the top row** is Lemonn's (v308): a back arrow and a tab cut like a
    folder's, reading ScalpPro, in the charts' colour so it runs into the chart
    below. Their "Add more strategies" button is left out at his word;
  - **the time axis** (v308): its line runs on over the interval label in the
    corner, there is a small mark above each time, and it is 30pt tall.
- **The app's bottom bar is not shown on this screen**, as Lemonn's is not on
  its ScalpPro. The back arrow at the top returns to the chart page and the bar.
  - Tap the index name for NIFTY 50 / BANK NIFTY / SENSEX.
  - Tap **Call** or **Put** after the option's name to flip to the other side of
    the same strike and expiry.
- **The handle between the charts** drags either one up to the whole screen;
  where it is left is kept on that phone (`scalpSplit`).
- **The bar at the bottom** trades the option in the lower chart. Its look is
  Lemonn's — a lime Buy with dark words, Sell as an outline:
  - **Buy at Mkt / Sell at Mkt place the order on one tap. There is no ticket
    and no confirmation** — Martin's answer, 16 Nov 2026, when asked whether
    they should confirm first. A second tap within 1.2s, or while the first is
    still being sent, is ignored.
  - **− 65 / 1 lot +** sets the size (1 to 25 lots, kept as `scalpLots`).
  - **Req** under each button is the margin that order needs; **Funds** is what
    is available. An order that needs more than there is says "Not enough
    funds" and is not sent.
  - While a trade is open in that contract, the button that would go against it
    becomes **Exit** (one tap, the whole position); the other still adds.
- **It is the order ticket's own path** (`handleOrderSubmit`): the trade guard,
  the journal entry and the automatic SL / TP all apply exactly as they do to an
  order from the ticket. The guard's refusal is shown as it is elsewhere.
- **SL and TP chips move without Quick Trade** on this screen (it has no Quick
  Trade button); everywhere else they still need it — which since v310 means
  the desktop, because a phone's chart page has no Quick Trade either and its
  chips stay put.
- **No "i" on the option chart** (v310; Martin: "Remove it."). The round Greeks
  and gearing button beside the price axis, and the panel it opens, are not on
  this screen; Lemonn has nothing there. The chart page keeps both.
- A reload stays on ScalpPro (`scalpPro` in the session); the back arrow returns
  to the index chart.
- **On every chart (v308):** times on the axis are 12-hour with no am / pm
  ("9:30", "2:15" — a session never has the same hour twice), each with a small
  mark above it; and the button that brings the chart back to the latest candle
  is Lemonn's — a white square with a blue turning arrow, in the middle of the
  chart just above the time axis on a phone.
- **Market | Limit/Trigger** above the buttons (v307). On Limit/Trigger each
  chart gets an **At Price** line at the live price, with a chip (✕ · At Price ·
  six dots) and the price in a box on the axis:
  - drag a chip to set the price. The option chart's line is a price of the
    option; the index chart's line ("At Price · 25300 CE") is a level of the
    index. The one dragged last is the one in use (blue outline);
  - the buttons name what the order is: with the line above the live price
    **Buy Trg | Sell Lmt**, below it **Buy Lmt | Sell Trg**; on the index line
    both are **Trg**. "Req" follows the option line's price;
  - a tap on one **arms an order that waits** — nothing goes to the broker
    until the price gets there, then a MARKET order is sent
    (`server/triggers.ts`, the armed-order engine the chart page already used).
    The waiting order is a chip on its line ("B 0/65 LMT") with a ✕ that
    cancels it; the switch goes back to Market;
  - ✕ on an At Price chip, the Market half of the switch, or changing the
    option puts the mode away without placing anything.
- **What a waiting order is, and is not.** It is held by this app's server, not
  by the exchange: it fires only while the server is running and logged in to
  the broker, in market hours, and it lapses at the close. One armed after the
  close is refused ("Market closed") rather than accepted and dropped. The
  trade guard checks it when it is armed and again when it fires, and the size
  is checked against the funds at that moment.
  - **A level on the index** is stored with `watch_token` (the index's token)
    beside the option's own: the server compares the index's ticks to the level
    and, when it is touched, buys or sells the option at market. `GET
    /api/triggers` shows it as `@ NIFTY 50 25305.65`.
  - Test: `npx tsx server/triggers.test.ts` (sections 8 and 9 are these two).
- Not here yet: the ≡+ button (Range, Indicators, Drawings, Settings), the
  Positions · Orders · Option chain row, and dragging SL / TP out of the entry
  line when the automatic ones are switched off.

## Chart: the open trade's chips (Exit, P&L, SL, TP)

`src/pages/AdvancedChart.tsx` ("TRADE CHIPS"). With a trade open, its own chart
shows it the way the Lemonn app does:

- **On the entry line:** `Exit`, then the position with its live P&L
  (`25200 CE · 1 lot  -₹24`). Tap the position to tuck Exit away, tap again to
  bring it back. Exit takes **two taps** (`Exit` → `Confirm exit` for 3 seconds)
  and goes through the positions bar's own exit, so there is one exit path.
- **On the stop and the target:** a red `SL` and a green `TP` chip (`TP1`… on a
  Telegram ladder), with what the level is worth beside it
  (`-10.0% · -₹920`, and `R:R 1:2.00` on the target). When a line is too close to
  the entry line to fit under it, its chip parks straight after the entry row.
- **Moving a level:** drag its chip. Only the chip is a handle — a press on the
  line itself is an ordinary press on the chart. Chips move **only while Quick
  Trade is on** (they then show chevrons); with it off a press says so. (On
  ScalpPro they always move. On a phone's chart page they never do — it has no
  Quick Trade since v310 — and a press says "Move SL / TP in ScalpPro".) Inside
  the pane the line follows the finger to the tick; push past the top or bottom
  edge and the chart slides that way until the finger comes back.
- **A leg that is switched off** shows as a grey `SL off` / `TP off` beside the
  position (tap: opens TP & SL). A trade running free shows both, and keeps its
  entry line.
- On the **spot chart** the mirrored lines carry the same chips, with the premium
  they stand for (`≈ ₹127.50`).

Nothing here changes which levels are armed, the entry wall, or where a drop is
sent; it replaces the on-line pills and the old "grab the line anywhere" drag.

## Chart: the price axis does not get narrower (v322)

`src/pages/AdvancedChart.tsx` ("THE PRICE AXIS DOES NOT GET NARROWER", "NO
MARKERS, NO MARKER LAYER"). Martin, 17 Nov 2026, with a recording of ScalpPro's
index chart: "There's also some kind of glitch in the chart". On every tick the
price scale was drawn one frame taller, the labels and zones the frame after
where that scale would have put them, and then all was back.

What it was, from the recording's frames and the charting library's code:

1. Every tick made the chart lay itself out afresh. The library's series
   markers are a layer that asks for a full layout whenever the candles' data
   changes, and it was attached to every chart with an empty list.
2. Laid out afresh, the library gives the price axis the width its labels need
   at that moment. In Manrope that depends on which digits they are (its "1" is
   3.9px wide at the chart's size, its "0" 6.1px): for the range in the
   recording the rule gives an axis 2px narrower than for a range fifty points
   taller.
3. The one-minute chart's first bar of the day, with a long lower wick, sat
   within those 2px of the pane's left edge.

So each tick the axis was laid out 2px narrower, the plot took that bar in, the
range dropped to fit its wick, the new labels needed the 2px back, the library
(which widens at once and never narrows by itself) laid out again, and the bar
was out. It needed that bar at that edge, so it came and went, and could not be
made to happen on the test copy.

- **The axis only ever grows.** Whatever width it has once been given is its
  minimum until the chart is built again (another contract or interval).
- **The marker layer is attached only when there is a divergence to mark**, so
  a tick no longer makes a chart without one lay itself out again.
- The temporary self-check from v320 (`diag_chart_blink`) is gone. It never
  reported: the blink needs that one geometry, which did not come back while it
  was watching.

## Market Context sidebar is a straight picker wheel (v355)

Martin, with a picture of a picker wheel: "I want to change my side bar to this exact
design but in a straight vertical scrolling instead of circular as shown. Each indices
should be shown separately also separated as Indian, US, UK etc as it's currently".
Each market is one row (`WheelRow` in `src/components/MarketContext.tsx`): its name and
price on the left, the day's change in a round-ended tile on the right. The row at the
middle of the panel is picked out (name in an outlined chip, tile outlined in the
accent), the rest fade with distance, and the list snaps a row to the middle; a line
runs down the right with a handle at the middle. Sections (Indian, US, UK, Global) keep
their headings, which still fold on a tap; a tap on a row still opens its chart.

## Chart: index menu, the chosen option survives ScalperX, Range and Interval lists (v354)

- **Index menu.** Martin: "Remove the US 30 and Gift nifty from this list and move it to
  global market sidebar. And rearrange the list in this way. Nifty50, Sensex, Bank
  Nifty". The menu is NIFTY 50, SENSEX, BANK NIFTY. The Market Context sidebar (the
  globe) has a "GIFT Nifty" row at the head of Indian Indices (quoted from Zerodha's NSE
  IX contract in the same one quote) and its "Dow Fut" row; tapping either opens the
  chart's own GIFT NIFTY / US30 chart (`open-index-chart`, `indexChartOpen`).
- **Cards under the chart.** They already asked for the chosen index's chain; the
  previous index's numbers stood in until it arrived. They no longer do.
- **The chosen option.** Martin: "When I select an option chart from the list in the
  chart screen and then move to scalperX screen and later come back the option chart i
  selected changes to some other chart". `selectedInstrument` is shared with ScalperX's
  lower chart and was cleared on leaving it. The chart page keeps its own copy
  (`chartPageInstrument`), which leaving ScalperX puts back.
- **Range and Interval.** Martin: "use the same dropdown list for time frame as you used
  for Range. Do not use built in browser list. Also when I tap the range or time frame
  button again, the list should disappear". The phone's Interval, and ScalperX's corner
  interval, open the app's own list; a second tap on Range or Interval closes it (the
  press closed it through the layer behind and the click reopened it).

## News: smaller cards on a phone (v353)

Martin: "Reduce the sizes of fonts inside the news cards to accommodate more news cards
on the screen. Currently only 3 cards are available to read on the screen". On a phone
the headline is 13px (was 16), the chips 9px, the time 10px, with tighter padding and
gaps: 5 whole cards fit where 3 did. The desktop keeps its sizes.

## ScalperX: the order row is pills (v352)

Martin, with a picture of ScalperX's order row: "Turn all these buttons and shapes to
pill shape", then "Except the plus and minus buttons keep them as it is". Buy, Sell,
Exit and the Market | Limit/Trigger switch (its frame and both halves) have round ends;
sizes are unchanged. The − and + were already round and are untouched.

## ScalperX: Buy at Mkt is the accent colour (v351)

Martin: "Also change the buy at market button color to accent color". ScalperX's Buy
at Mkt (and its "Buy at" form when a price is set) was Lemonn's lime with black words;
it is the accent with white words. Exit stays red.

## Chart: Option Chain and ScalperX are the journal's pill size (v350)

Martin, with a picture of the journal's Open / History: "Use this size for buttons Option
chain and ScalperX in the chart screen at the bottom. They look a little thicker to me."
The two are 32 tall with round ends and 12px Medium words, as the journal's tabs are
(were 40 tall, 8px corners, 13px SemiBold). The row they sit in keeps its height.

## White pills and buttons take the accent too; the screen stays on (v349)

- Martin, with pictures of the journal's Open / History, the news chips and the heatmap's
  bar: "Use the accent colors for these type of buttons as well". The chosen pill or chip
  and the white buttons (Ok, Okay, Done, ScalperX, the TP & SL confirm) are filled with
  the accent with white words; the white-edged pills (Category, Index, the expiry) have
  an accent edge.
- Martin: "make sure my display remains on and doesn't go to sleep whenever my web app
  is open". `src/main.tsx` holds a screen wake lock while the app is the visible page,
  and asks again whenever it comes back or is touched. Browsers without one (iPhone
  home-screen apps before iOS 18.4) are unaffected.

## Everything coloured takes the accent colour (v348)

Martin: "I want all the colorful things like icons, buttons, cards texts etc to be
changed to my accent color from the app ... Don't change anything else except the
colors. The once that use Red and Green (Buy/Sell) can be left as it is". Amber, blue,
sky, cyan, indigo, pink, yellow and violet classes and the Lemonn-measured blues (bias
button and sheet, TP & SL sheet, journal chips, option chain sheet, heatmap tick) are
now `primary` / `var(--primary)`, which is Settings' Global Accent Color. Left alone:
red and green everywhere, the lime Buy buttons, and what is drawn on charts (candles,
indicator lines, zones, drawings, graph lines), which need to be told apart. New UI
takes its colour from `primary`, not a literal.

## Home ends with a futures heatmap; a long press's lines stay with the +; seven screens retired (v347)

- **Futures heatmap** (`src/components/FuturesHeatmap.tsx`, `server/futures_heatmap.ts`,
  `GET /api/futures-heatmap?expiry=YYYY-MM-DD`). Martin, with a screen recording of one:
  "I want this exact futures heat map in my homepage below at the end". At the end of
  the home page: "Futures Heatmap", the pill-and-chips bar (Index ⇕: Nifty 50, Sensex,
  Nifty Bank, Nifty Financial Services, Nifty Midcap 50, Nifty 100, Nifty 500; Sector ⇕:
  Auto, Banks, Metals, Finance, IT, Pharma, FMCG, Energy, Oil & Gas, Realty, Media, PSU
  Banks, Pvt Banks, Healthcare, Consumer Durables), the expiry pill (a sheet of the
  expiries) and Price ⇕, then the chosen stocks' futures — three a row on a phone, edge
  to edge, highest change first: the stock, its change on the day, its price, in six
  shades (2% and more, 1 to 2, 0 to 1, and the same below nought). Price ⇕ turns it to
  OI: the change in open interest since the previous day's close and the build-up (long
  build-up, short covering, short build-up, long unwinding). Members: NSE's index lists
  (`archives.nseindia.com/content/indices/ind_*list.csv`, kept a day); the Sensex's 30
  are written out in the server file (BSE rejigs in June and December). Futures:
  Zerodha's NFO contract list. Prices: one Zerodha quote of every stock future of the
  expiry, kept 5 s; the page asks every 5 s while the market is open, every minute
  otherwise. Previous OI: NSE's F&O bhavcopy for the last trading day before the
  session, read out of its zip with zlib. Every size and colour is measured off the
  recording (3 pixels a point); the bar is ChipBar with `look="heatmap"`.
- **Long press.** Martin: "On the chart when I tap and hold, the horizontal & vertical
  lines disappear as soon as I lift my finger, but the plus button remains for a few
  seconds. I want the lines to remain for a few seconds along with the plus button".
  After the lift the app puts the library's crosshair back where it was (same price,
  same bar, same axis labels); it goes with the + and the O H L C line 3.5 s later, or
  at once on the next touch. Past the newest bar, where there is no bar time to hand
  the library, the chart's overlay draws the two lines in the same look.
- **Retired screens.** Martin, with the More sheet's icons crossed out in red: "Remove
  all these screens marked in red from the app" — Live Signal, Option Chain, Reports,
  AI Pilot, Signal Alerts, Index History, Option Value. Gone from the More sheet and
  the desktop rail, their pages deleted; a saved link to one opens the home page. The
  option chain the chart opens is the sheet and stays (Gap Scorecard's "Stage order →
  Option Chain" now opens it). The chart's SIGNAL badge and the server's endpoints are
  unchanged.

## News filters are the pill-and-chips bar; TP & SL leaves the Indicators list (v346)

- **News** (`src/components/ChipBar.tsx`). Martin, with a picture ("NIFTY 50 ⇕ |
  Bullish Bearish Volatile …"): "change the news categories and the filter
  button to exactly this design shown in the screenshot". The "Filters:" label
  is a pill ("Category ⇕" / "Sentiment ⇕") that switches what the chips pick
  by: the six categories as before, or Bullish / Bearish / Neutral. Measured
  off his picture: pill 34 tall with a white edge, a 1pt line, chips 32 tall
  (chosen white with black words, the rest a #373737 edge), 12px. The futures
  heatmap uses the same bar.
- **TP & SL.** Martin: "Also remove the TP & SL setting from the indicators
  list". The row is gone. The sheet opens from Settings → SL & TP on the phone,
  as before, and on the desktop from a new SL & TP button on the tool bar (the
  row was the desktop's only way to it).

## News: no "Why this matters for NIFTY" box on the cards (v345)

Martin, with a picture of a card: "Remove the why this matters for nifty part
for every news card to make them compact". Each card is now its tags, the
headline and the time with the link — 182 px tall for the first card at phone
size. The server still sends `whyItMatters`; only the card stopped showing it.

## Home page: Open Interest, Trend Summary and Supporting Evidence are gone (v344)

Martin, with pictures of the three: "Remove these 3 cards from the homepage".
The home page is now Today's Bias, the NIFTY 50 price and the Final AI Decision.
The figures only those blocks used (the all-strike OI totals and split, the
trend direction / strength / ADX summary) are no longer worked out there; the
decision is worked out exactly as before.

## The home page opens without waiting for FII / DII (v343)

Martin: "The app when opened for the first time takes a lot of time to load.
Especially the homepage." Timed on the live app (phone size, read-only): the
home page's grey placeholders stayed 9-10 s on a first open and 7.5-8 s on a
second. Three causes, three fixes:

- **FII / DII.** The home page drew nothing until `/api/fii-dii` answered, and
  that read NSE's archive afresh on every call (6.7-7.1 s), every 10 s. The
  server now keeps the last good read (`server/fii_service.ts`): handed out at
  once, read again behind the answer past 30 minutes, shared by asks that
  arrive together, a failure never replacing a good read, warmed as the server
  starts. The home page no longer waits for it at all (it only ever went into
  the decision as `fiiDiiData?.bias`, a field the endpoint does not send, so the
  decision is unchanged), and the home page and chart ask every 5 minutes.
- **The app loaded twice on a first open.** The service worker, installing,
  took the page over and `main.tsx` reloaded on that. It now reloads only when
  a worker replaces another.
- **Code asked for again on every open.** Everything was sent `max-age=0`. The
  build's files under `/assets` are named by their contents, so they are now
  sent `max-age=31536000, immutable`; `index.html` (which names them) and
  `sw.js` are still asked for each time, so deploys are picked up as before.

## Chart (phone): the bias button sits over the price figures (v342)

Martin, with a picture of the button 16pt in from the edge: "In the chart
screen move the bias card icon a little to wards the left and make it sit
directly over the strike price. It looks a little off. The scalperX screen icon
does not require any changes". It is centred over the price axis's figures,
40.7pt in from the screen's edge (measured on his picture; the axis keeps to the
right edge on any width), 8pt left of where it was; the market clock moves with
it. ScalperX's button is unchanged.

## ScalpPro is called ScalperX (v341)

Martin: "Also change the ScalpPro name to ScaperX everywhere in my app" — asked
which he meant, ScalperX. Changed wherever the name shows: the button under the
phone chart, the screen's tab, the message "Move SL / TP in ScalperX", and the
Trade guard sheet's note. The code's own names for it (`scalp`, `ScalpScreen`,
`openInScalpPro`, `terminal:scalp`) and this README's history are unchanged.

## Chart: the bias is a button on the index chart, with Lemonn's sheet (v340)

`src/components/BiasCheck.tsx`. Martin, with two pictures of Lemonn's ScalpPro:
"Remove the nifty bias card indicator for the indicator list and add it on the
spot chart like shown in the screenshot. Once loaded the bias should appear as
shown in the 2nd screenshot. Add the button to both spot charts in the charts
screen as well as the scalper pro screen exactly as shown in the 1st
screenshot".

- **The button** (Lemonn's chart-line square, 33pt, dark navy going lighter to
  the right, blue-grey edge) is on every index chart: at the right end of the
  phone chart's price line, 8pt left of ScalpPro's menu button on its index
  chart, and before the shield on the desktop's index half. Not on an option's
  chart, as the card was not.
- **A tap** does what the card's Check bias did: a fresh read from the server
  (`POST /api/bias/run`, 10-20 s; the last read at once if it is under a
  minute old or no new candle has closed). The button turns while it reads.
- **The sheet** comes up when the read is in: the bias (green, red, or blue for
  neutral) with its confidence and time, NIFTY 50 and its change at that
  moment, the read's lines as points, its closing "not a trade signal" line in
  the disclaimer's box, and Okay. Measured off Lemonn's: sizes, colours, the
  glow and edge, and its SemiBold text; set against the same words, every line
  is within half a point of Lemonn's. Lemonn's "Analyzed by Dash" line is left
  out. On a desktop it is a box in the middle.
- **A failed read** says why in a message; today's earlier read is shown if
  there is one.
- **Gone:** the Check bias card under the chart (phone) and under both halves
  (desktop), its × and the hide flag, the Indicators row "NIFTY Bias card", and
  the script that loaded the card (`public/bias-panel.js` stays in the repo,
  unloaded). "Today's Bias Levels" (the lines on the chart) is unchanged.

## Chart: S and R sit in the middle of their rings (v339)

Martin, of v336 on his iPhone: "The R and S are not perfectly centered inside
the circle." The letter was placed by its box (centre and "middle"), and each
browser works out "middle" from the font's ascent and descent in its own way:
worked out from Manrope's measures, Safari put the letter about 1px low and
Chrome about 0.3px high. The ink the letter covers is measured instead, at ten
times the size (Chrome gives these measures in whole pixels), and put on the
ring's centre. On the test copy both letters measure within 0.1px of the centre.

## Chart (phone): the row of five has Lemonn's icons (v338)

`src/components/BarIcons.tsx`. Martin, with a picture of Lemonn's row: "Use the
same icons for my app as well." Range is a dotted frame over a measured line,
Indicators a script *fx*, Drawings a pencil leaving a line, Settings a cog with
a solid hub; Interval shows the interval, as before. Lemonn's icons are its own
drawings, so these are drawn here to the same idea. ScalpPro's menu uses the
same four, and the desktop's Indicators and Drawings buttons too.

## Chart: the bias lines are named Bias and Invalidation (v337)

Martin: "change Bias trigger/High and Invalidation/Low to just Bias and
Invalidation." The trigger is usually the opening range's high or low and the
invalidation the other, so each price carried two names on the axis. The
trigger's line is named **Bias**, and an opening-range line at the trigger's or
the invalidation's price is not drawn. An opening-range line at a price of its
own still is (OR high / OR low).

## Chart: support and resistance are S and R in a ring (v336)

Martin: "change the RESISTANCE and SUPPORT text to just R and S inside a
stroked circle." The labels at the left end of the two lines were the words in
a filled pill. Each is now its letter in the line's colour inside an 18px ring
of that colour, the ring filled with the chart's background so the line does
not run through the letter. On an option's chart the label also carries the
index level it stands for ("S 25200"), so the ring there is as long as that
needs. PDH, PDL and the other labels are as they were.

## No messages while the search is open (v335)

Martin: "do not show any alert or notifications when I search in the search bar
because it blocks my search". The app's messages (toasts) come down from the
top, onto the search field. While a search is open the body carries
`data-search-open` and the toaster is not drawn (`src/index.css`). A message
still due when the search closes is shown then; sounds and Telegram are as
they were.

## Chart (phone): pull down to refresh; Reload is gone from Settings (v334)

`src/components/PullRefresh.tsx`. Martin, with a picture of Lemonn's spinner:
"enable the pull down to refresh chart in the main chart screen instead of
taping reload in the settings. Remove the reload option from settings once
it's added."

- With the page at its top, a drag down that begins anywhere but on a chart
  (the header, the price, the row of five) brings a round arrow down from the
  top at half the finger's pace. Past 56px (112px of finger) it turns solid;
  letting go there does what Reload did: the chart reloads and the app is
  loaded afresh. Short of it, nothing happens.
- A drag begun **on the chart** still moves the chart. A field, a list that
  scrolls by itself, a sheet, or a page that is scrolled down, start no pull.
- Settings (phone) no longer has **Reload**. The desktop's halves and ScalpPro
  keep their refresh buttons.

## Search no longer sets off the "high frequency" warning (v333)

Martin, after v332: "I get a error warning when I search and add options to
list" — the toast named `/api/instruments/search`, 6 calls in 15 seconds. Each
pause in typing is one call, so looking up a few strikes in a row passes the
limit of 5. The search is answered from the contract list the server keeps in
memory (one fetch from Zerodha a day), so it asks the broker nothing; it is now
on the warning's list of endpoints that cannot cause a 429
(`SERVER_CACHED_ENDPOINTS` in `src/lib/apiInterceptor.ts`).

## Search: smaller results, and a + that puts one on the chart list (v332)

Martin, 17 Nov 2026, with a picture of the results: "The search results fonts
can be reduced to half the size. Also add a plus icon next to it to add them to
the list beside the nifty chart in the main charts screen."

- **Smaller.** A result's two lines are 11px over 9px (were 16px over 12px), in
  rows 42 tall (were 59). 8px, half to the letter, is too small to read on a
  phone. Shares and funds, which are listed as they were, are the same sizes.
- **The +** beside each result puts it on the list under the tab beside the
  index's (the option charts' list), and does nothing else: the chart on screen
  stays, the search stays open and the keyboard up, so several can be lined up
  from one search. On the list it is a green tick; a tap takes it off, as the
  list's own × does (the chart on screen then moves to the last one left, or to
  the index). An index has no + (it is on the index tab's menu).
- **Desktop:** the option half's search has the + on options only, as that
  half takes only options. The index half has no list of its own, so its search
  has no +; an option opened from it opens the option half, whose search has it.
- **The list holds 10** (was 5, from when each was a tab across the top). Over
  10, the oldest goes, never the one on screen.
- **Found while verifying (desktop):** an option picked in the index half's
  search also landed in a list of the index half's own, so the index half grew a
  tab of the option beside NIFTY 50 that nothing kept up to date. The index half
  no longer keeps a list (it never meant to; see the comment on `openCharts`).

## Sync positions on the Journal; the bottom bar closes App Diagnostics (v331)

- **Sync positions** moved from the chart's Settings (and the desktop chart's
  tool bar) to a round button beside the Journal's wallet, 14pt from it. Martin:
  "Move the refresh positions button to the journal screen beside the wallet
  icon at the top right of the screen". It asks the open-positions card (mounted
  for the whole app) to read Zerodha's positions again (`sync_positions_request`).
  The card says what it found, and the arrows turn while it works.
- **App Diagnostics (phone)** is put away by any other button of the bottom bar.
  Martin: "when app diagnostics screen is open, taping on any of the other icons
  at the bottom does not automatically make it disappear." The panel belongs to
  the shell, not to a page, so going to another page left it showing. Each other
  button now sends `close_diagnostics`. Diag still opens and closes it.

## SL & TP: Lemonn's "Set Auto TP/SL" sheet (v330)

`TpSlDefaultsModal` and `exitPricesFor` in `src/pages/AdvancedChart.tsx`. Martin,
17 Nov 2026, with a picture of Lemonn's sheet: "Change the SL & TP UI to the
exactly the one shown in the screenshot."

- **The sheet**, measured off his picture: from the foot of the screen (a card
  in the middle on a desktop), "Set Auto TP/SL", then a card each for Auto TP
  and Auto SL. Each card has its switch, "Trigger at" with a stepper (− value +),
  and the estimate in green or red. "Trailing stop loss" sits at the foot of the
  SL card, then Save. Text is 12px except the title (18) and Save (16), as in
  Lemonn's. Every measured part is within a point of his picture.
- **Trigger at: Points or Percentage**, each leg on its own. Points are premium
  points from the entry; Percentage is a share of the entry, which is what his
  saved defaults are and stay. Each unit keeps its own number. One helper,
  `exitPricesFor`, turns the defaults into levels everywhere they are used: a
  new trade's automatic arming, the order box's preview, and Save on an open
  trade.
- **Mkt**: automatic exits go at market (a limit through the price, chased until
  filled, `server/exit_order.ts`). Nothing else can be chosen, so a tap says so.
- **The switches and Save do what the old box's did:** a leg switched off never
  closes the trade; both off lets it run free; with a trade open, Save re-arms
  it, and the line under the title says so.
- The numbers are typed as text, digits only, as the trade guard's are (v325).

## Option charts: every indicator in the list, drawn on the option (v329)

`src/pages/AdvancedChart.tsx` (EVERY ROW ON AN OPTION CHART TOO, at the list;
INDEX LEVELS ON AN OPTION CHART, beside the chain query). Martin, 17 Nov 2026:
"Why doesn’t the indicators list in the option chart in scalper pro screen show
all the indicators. Fix it." The option chart's list showed 6 of the 23 rows
(v324). It shows all 23, and each draws on an option chart:

- **On the option's own candles:** Previous Day High/Low, 15 min High-Low,
  BOS-CHoCH, Directional Zones, Fair Value Gaps, Demand/Supply Zones, Reversal
  Pin Bars, Bollinger Bands.
- **The index's levels, at this option's price for them:** Support-Resistance
  Lines, OI Bars, H Levels (with their 50% lines) and Today's Bias Levels are
  levels of the index. On an option chart each is drawn where the option would
  trade with the index at that level, now. The option's implied volatility is
  worked out from its own live price at the index's live price, then held while
  the index alone moves to the level (Black-Scholes, as in the Option Chain's
  Greeks). Each label keeps the index level (`RES 25500`, `RED OUTER 25450`).
  The lines drift a little through the day as volatility and time change, and
  are recalculated every second. They are not alerted on.
- **GIFT Divergence:** a mark on the option's candle of that time, pointing the
  way the signal says this option should go (a bullish divergence points up on
  a call, down on a put). It announces only from the index chart.
- **Level Touch, Zone Tap and Breakout-Fakeouts alerts:** the option chart's own
  switches now (they were the index chart's). When on, they judge the option's
  own levels, zones and candles, and each alert names the option.
- **NIFTY Bias card:** the one card, as on the index chart.
- Everything starts **off** on option charts, as since v324. BOS-CHoCH's own
  "Show BOS" setting, which that clearing had turned off, is on again (once).
- **Found while doing it:** Level Touch Alerts never announced PDH or PDL, on any
  chart. The level list read names the PDH/PDL data does not have, so the two
  levels never entered it, nor the breakout check that uses the same list. Fixed.

## ScalpPro: the index's name and the option's name open the Option Chain (v328)

`src/pages/AdvancedChart.tsx` (THE NAMES OPEN THE OPTION CHAIN),
`src/components/OptionChainSheet.tsx` (`ChainStart`). Martin, 17 Nov 2026, with
a picture of ScalpPro: "When I tap on the nifty 50 text or the Option Strike
price (NIFTY17NOV25450) text in the scaler pro screen it should open the option
chart. Taping on CALL/PUT already changes from CALL to PUT and vice versa".

- **The index's name** (NIFTY 50) opens the chain on that index, nearest
  expiry. **The option's name** opens it on the option's own index and expiry.
  A price tapped there swaps the option on the screen, as from the chart page.
- **What did not change:** Call / Put still flips the side. The ⬍ after the
  index's name, which was part of the name's button, is a button of its own and
  still lists the indices.
- Nothing moved: each button reaches past what it shows by padding given back
  as a negative margin, so the two lines are where Lemonn's are (name 13.5pt
  down, price 31.5pt, heading 57.5pt; the ⬍ 3pt after the name).
- Any screen can open the chain on an index and expiry:
  `terminal:option-chain` with `{ underlying: 'NIFTY' | 'BANKNIFTY' | 'SENSEX',
  expiry: 'YYYY-MM-DD' }`, either left out. An expiry the server no longer lists
  gets the nearest.

## Search: a strike's own index first, results in words, a × and a tap outside (v327)

`server/instrument_search.ts` (tests: `npx tsx server/instrument_search.test.ts`),
`searchLabel` in `src/lib/optionName.ts` (tests: `npx tsx src/lib/optionName.test.ts`),
`src/components/SymbolSearch.tsx`. Martin, 17 Nov 2026, with a picture of
"23500" searched and six SENSEX50 contracts above NIFTY's:

> The search shows strikes for SENSEX first even though SENSEX is not in the range of types strike price. Show the Nifty, bank nifty or SENSEX options in the search based on the nearest strike price. Show the search in this format
> NIFTY 17th (w) NOV 23500 CE
> 17 NOV WEEKLY
> Also there's no close button inside the search to close the empty search bar. Also close it when I tap outside the search bar.

- **Whose strike it is.** The search used to return the first fifty matches in
  the order of Zerodha's contract file, which begins with BSE. Now the
  contracts of NIFTY, Bank Nifty and SENSEX come first, and among them the
  index a typed strike belongs to: the one whose price is nearest it (23500 is
  NIFTY's, 57000 Bank Nifty's, 83000 SENSEX's). Then the nearest expiry, then
  the strike nearest the index's price (a part-typed "254" gives 25450 and
  25400 before anything further out), then the call before the put. An index's
  price is its last tick; with none, the middle strike of its nearest expiry.
  Everything else the search found (SENSEX50, shares with that strike) is
  still found, after these, in the old order.
- **An index's name** — nifty, nifty 50, banknifty, bank nifty, nifty bank,
  sensex — gives the index, its futures, then its options from the money
  outward. "nifty" used to give fifty funds with the word in their name.
- **In words.** An option or a future is two lines: `NIFTY 17th (w) NOV 23500
  CE` over `17 NOV WEEKLY`; a monthly has no `(w)` and reads `MONTHLY`
  (`NIFTY 23rd NOV 23500 PE` / `23 NOV MONTHLY`); a future reads `NIFTY 23rd
  NOV FUT`. The year is on the second line only when it is not this year. The
  lines are made from the row's own name, expiry date, strike and type; only
  weekly-or-monthly is read off the symbol. Shares, indices and funds are
  listed as they were.
- **Several words** are matched one by one — the name, the strike, CE / PE /
  FUT, the month, the day, weekly / monthly — so the line as it is shown, or
  part of it (`nifty 23500`, `23500 ce`, `sensex 83000 pe`), finds the
  contract. As one run of letters these found nothing.
- **×** is in the field whenever it is open: with text it clears the text, as
  before; with none it closes the search (on a desktop, back to the icon).
- **A tap outside closes it,** the chart included: it listened for a mouse
  press, which a phone only makes up after a touch that nothing claimed, and
  the chart claims its touches. It listens for the touch itself now. The tap
  still does what it would have done where it landed.
- **A contract that has expired is not listed.** The server keeps Zerodha's
  file for a day from when it read it, so the morning after an expiry it still
  holds yesterday's contracts, and with the nearest expiry first they would
  have headed the list. A contract is listed through its last day (India's).
- **As it was:** a symbol typed whole is the first result — the chart finds an
  open position's contract that way — with NSE's listing before BSE's; and a
  search with none of the three names and no strike in it (`reliance`, `nifty
  it`, `bank`) gives what it gave, in the order it had.

## Option Chain: Lemonn's chain, as a sheet over the chart (v326)

`src/components/OptionChainSheet.tsx`, `src/lib/optionGreeks.ts` (tests:
`npx tsx src/lib/optionGreeks.test.ts`), `src/pages/OptionChain.tsx`. Martin,
16 Nov 2026: "I also want to completely redesign the option chain screen same
as in the lemon app. So remove the option chain screen already present in my
app completely and redesign it as shown in the videos with the Greeks button
and horizontal inward scrolling when Greeks are enabled. I also want the option
strike chart to open/selected for scalp pro when I tap in the strike price in
the option chain." The old page (the table with OI bars, zones and the NIFTY |
SENSEX switch) is gone.

- **Where it is:** the chart page's Option Chain button brings it up as a sheet
  over the chart, from 152pt down, as Lemonn's comes up over ScalpPro; a tap
  above it puts it away. `/option-chain` (the desktop's side bar, old links)
  shows the same chain filling the page. Any screen can open the sheet by
  announcing `terminal:option-chain`.
- **What is on it,** measured off his recording: a row of controls (All, the
  expiry, the Greeks switch); a line of four facts (the trend, PCR, Max Pain,
  ATM IV); the table. Strike is a fixed column 88pt wide down the middle; rows
  are 54pt. Greeks off: one column a side, the price with its change on the day
  under it. Greeks on: eight columns a side — LTP, OI, IV, Delta, Gamma, Vega,
  Theta, Rho, counting outward from the Strike — two in view, and the two sides
  slide **towards each other** under the Strike as either is dragged, coming to
  rest on a column. All (with Greeks on) jumps to a column.
- **In the rows:** in-the-money cells are shaded; the bar along the foot of a
  row is that strike's open interest against the largest on its side (calls
  red, puts green); the tags are Max Pain, OI Support and OI Resistance; the
  white pill between two strikes is the index and its change on the day.
- **A tap on a price opens that option in ScalpPro** (on a desktop, in the
  option half): the call side of a row is its Call, the put side its Put, the
  strike itself the one that is out of the money.
- **IV and the Greeks are worked out here** — the broker's quotes carry none —
  by the model Lemonn's own figures fit: Black-Scholes on the spot, 10% interest,
  clock time to 3:30 PM IST on the expiry day over a 365-day year, Theta a
  calendar day, Vega and Rho a percentage point. Against the recording: twenty
  IVs within 0.04, Vega, Theta and Rho within half a percent. A price under
  what the option is worth exercised (a stale quote, deep in the money) implies
  no volatility and shows "—".
- **Data:** `GET /api/option-chain?withAnalytics=1` every five seconds, option
  ticks between reads, and the index's daily candles once for yesterday's
  close. Nothing on the server changed. The index is the chart's
  (`chartUnderlying`).

## Trade guard's sheet, a tap outside, and ScalpPro that does not scroll (v325)

Martin, 17 Nov 2026, with two pictures from his phone.

- **Trade guard: Save is always in sight** (`src/components/TradeGuard.tsx`).
  "Can't find the save button". On a phone the shield is a row of the chart's
  Settings list and its sheet was drawn inside that list, which sits under the
  app's bottom bar and the Option Chain | ScalpPro buttons — so the foot of the
  sheet, with Cancel and Save, was behind them. The sheet is drawn on the page
  itself now, above those bars; only the rules scroll, Cancel and Save stay put.
- **The two numbers are typed as text.** "Unable to change the Max trade per
  day": the box read "05". A number field holding a number shows 0 when rubbed
  out, and the next digit went after it. Digits only now, nothing in front.
  What saving does is unchanged: a stricter rule applies at once, a looser one
  from the next trading day.
- **A tap outside closes what is behind it too.** "whenever i tap on any part
  of the chart, any list or setting that was open has to disappear" — with the
  guard's sheet open, a tap outside closed the sheet and left the Settings list
  it was opened from. The list (the phone's Settings, ScalpPro's menu) closes
  with the sheet, however the sheet is closed. The line editor and the H Levels
  box, the two settings boxes a tap outside did not close, close on one too.
- **ScalpPro does not scroll** (`ScalpScreen` in `src/pages/ChartWorkspace.tsx`).
  "sometimes the scalp pro screen moves up making the top heading hidden.
  Disable screen vertical scrolling in the scalp pro screen". The screen is
  sized to fill the window, but for a moment it can be taller than it (the
  positions line appears above it when a trade opens), a finger on the heading
  or the Buy / Sell bar then moved the page, and because the screen's top was
  measured in the window, a page that had moved made the screen that much
  taller and so stayed moved. While the screen is up the page cannot scroll or
  bounce and is put back at its top if found moved; a finger on the screen is
  not the browser's to scroll with (the charts read their own touches, a list
  in a menu is a scroller of its own); and the top is measured on the page.

## Chart: an option chart's indicators are its own, and were all cleared once (v324)

`src/pages/AdvancedChart.tsx` (`indGet` / `indSet`, "opt:" keys,
`optionIndicatorsClearedOnce`). Three messages, because the first two were
misread:

- 16 Nov: "Remove all indicators in the option premium chart by default."
  v309 gave an option chart a set of switches of its own, saved under `opt:` +
  the switch's name, every one off until switched on there.
- 17 Nov, 10:46 AM: "Indicators are still applied to option charts. I want them
  All removed by default. Only spot should keep the indicators". They were on
  in his phone's storage: what is switched on in an option chart's list is on
  for every option chart. v321 took that for "none on an option chart, ever"
  and took the list away.
- 17 Nov, 1:07 PM: "I wanted the indicator option for option charts. I just
  wanted all the indicators cleared by default".

What it is now:

- An **option chart** — the chart page's option tab, ScalpPro's lower chart, the
  desktop's option half — has its **own Indicators list and its own switches**
  again, kept apart from the index chart's and not shared between devices.
- **Everything that was on for option charts is cleared once** on each device,
  the first time v324 loads there (the saved `opt:` switches are removed, and
  the switches in the desktop option half's own copy are put off). After that
  what he switches on for option charts stays on.
- **An option chart's list holds only what can be drawn on one:** Institutional
  Levels, Breaker Blocks & Liquidity, Swap-Sweep, Session Breaks, Volume and
  RSI. The rest are drawn on an index chart only (they always were — each is
  held back where it is drawn), and a switch for something that can never draw
  is not shown; that was already the rule for BOS-CHoCH and OI Bars. The three
  alert rows and the two bias rows are not shown there either: they are the
  index chart's, not part of the option charts' set.
- The index chart's switches, settings and stars are untouched by any of it.

## ScalpPro: "Req" under Buy is scaled from the broker's own price (v321)

`src/pages/AdvancedChart.tsx` ("THE PRICE THE BUY FIGURE IS FOR"). From v320 the
figure under Buy follows the premium between the broker's answers: the answer
is scaled by how far the price has moved since it was asked. v320 took "the
price it was asked at" to be the chart's last price at that moment. That is not
always this contract's price — 400 ms after ScalpPro opens it can be nothing
(the figure then stood still for thirty seconds) or still the candle of what
was on that chart before — and it is never the price the broker used: the
server asks about a market order, which the broker prices at its own last
price. For an option the price the figure is for is now the figure divided by
the lot. Anything that is not an option keeps the price sent, because what it
needs is a margin, not a price times a quantity.

## Exit: the order is followed until it is filled (v319)

`server/exit_order.ts` (tests: `npx tsx server/exit_order.test.ts`), used by every
exit the server places — the chart's Exit, ScalpPro's, a stop or a target.
On 17 Nov at 9:35 AM an Exit sent one sell as a limit order half a percent under
the last price, and never looked at it again; the premium was falling faster
than that, so the order rested unfilled while the app said "exit placed".

- The exit is a limit order **3% through the last price** (a floor under the
  bid — it fills at the bid), then **read every 600 ms and re-priced** towards
  the market while it is still open; eight looks, about ten seconds at most.
- It is reported as done **only when the broker says it is filled**. If it is
  not, the answer says so and the position stays shown as open.
- **A second Exit never sends a second order**: exits for one contract run one
  at a time, each reading the position afresh (the second finds it closed), and
  an earlier exit order still resting for exactly what is open is taken up and
  followed instead of a new one being placed.
- If the broker refuses a re-price, the order is cancelled and, once the broker
  confirms it is off, what was left of it is sent again.
- **Exit on the chart closes every open position** (he asked: "exit all
  positions when I tap on exit in the chart").

## After an Exit ScalpPro closes; Indicators closes on a second tap; ScalpPro's charts and Req (v320)

- An exit he tapped, once the broker has filled it, closes the ScalpPro screen
  and leaves the chart page on the index — the same thing the screen's back
  arrow does (`ActivePositions.tsx`). A stop or a target closing the trade does
  not move the screen.
- On a phone the press of a second tap on the Indicators button landed on the
  see-through layer behind the list, which closed it, and the click that
  followed opened it again. That click is now let go (`indClosedAtRef`).
- **ScalpPro: a chart stops squeezing at 192pt and is covered instead** (off a
  recording of Lemonn's). Dragging the handle makes a chart shorter down to
  192pt — its plot and time axis; past that the pane's edge comes up over the
  chart's foot, until only the name and price are left. The chart box has that
  minimum and sits in a box of the pane's real height that cuts it off
  (`ScalpClip`, `SCALP_CHART_MIN`); the Buy / Sell bar is below that box and is
  never cut.
- **ScalpPro: "Req" under Buy follows the premium.** The broker is still asked
  what one lot needs every 30 seconds; between two answers the figure is scaled
  by how far the price has moved, four times a second. What a Sell needs is
  margin, not premium, and stays the broker's own figure.
- The temporary self-check for the chart's blink that shipped with this was
  removed in v322, where the blink is explained and fixed.

## The positions banner is one line: the overall P&L (v319)

`src/components/ActivePositions.tsx`. The card with each position's details,
Set Auto-Exit and 1-Click Exit is gone, with the strip's count, Exit and chevron:
one line, "Overall P&L" and the day's net figure, shown while a position is
open. The component still does everything else it did — reads positions,
notices one taken or closed outside the app, and places the exit the chart asks
for. Exit is on the chart's trade line and on ScalpPro's bar.

## Chart: the index chart's indicators are the same on every device (v318)

`src/lib/indicatorSync.ts` (the whole of it, with its tests in
`indicatorSync.test.ts`), started by `src/pages/ChartWorkspace.tsx`. Martin,
16 Nov 2026: "Anywhere I change or add an indicator to the spot chart should
sync in all devices". Every indicator's switch and settings were values in the
browser's own storage, so the phone and the desktop each had their own.

- **What is shared:** the index chart's switches, each indicator's settings
  (colours, widths, periods, levels), the three alert switches in the same list
  and the stars — the names in `SWITCH_KEYS` and `SETTING_KEYS`.
- **What is not, on purpose:** an option chart's switches (the `opt:` names —
  he asked for the spot chart); the SL & TP defaults (they shape orders); what
  belongs to one screen (the RSI pane's height, the bias card's ×); a device's
  own bookkeeping (`indicatorLinesThin`).
- **Each value is shared on its own, newest change wins** — never a device's
  whole set at once. Nothing was sent when this shipped: a device's values are
  taken as read the first time it runs, and only what is changed afterwards
  travels. So two devices that differed stay different in whatever has not been
  touched since; the first change to a value makes it the same everywhere.
- **His iPhone's whole set went to every device, once (v323).** He had asked
  for that in the same message — "I also want the indicators I have used in the
  mobile app in iOS to be synced to all devices including laptops and pc's" —
  and sharing changes alone never does it. The first time an iPhone opens the
  app after v323 it sends every shared name as it stands there, stamped newer
  than anything in the document; every other device takes it like any other
  change, within twenty seconds of being open. A mark on the server,
  `chart_indicators_seed`, says it has been done: no phone does it twice, and
  nothing changed on any device afterwards is written over by it. What a
  device held before it took a set that size is kept on that device under
  `indSync:before`. To have a phone send its set again, clear the mark
  (`PUT {"value":null}` to `/api/settings/chart_indicators_seed`). It does
  nothing while the sharing is switched off.
- **Where it is kept:** one small document, `chart_indicators`, in the server's
  existing settings store (`/api/settings/:key` — nothing on the server changed):
  `{ name: { v: value, at: time } }`.
- **A change here** is noticed by looking — the values are compared every two
  seconds with what was there before — because they are saved from some eighty
  places. It is on the server within about two seconds.
- **A change elsewhere** is read when the chart page opens, when the app comes
  back to the front, and every twenty seconds. It is written to storage at once;
  the index chart is then **built afresh** to show it (that is how a chart reads
  its settings), but only at a quiet moment: nothing touched for four seconds,
  no list, sheet or dialog open on any chart, no drawing half made, no Long /
  Short Position box on a chart (the box is not saved, so a rebuild would take
  it away), Quick Trade's minute not running, the app in front. Only the index
  chart is rebuilt — on ScalpPro and on the desktop the option's chart is left
  alone; on the phone's chart page the option tab that was open is still the
  one shown. Lines and drawings are saved and come back with the chart; its
  zoom and scroll start again, as when the page is opened.
- **Two devices saving in the same instant:** each writes the whole document, so
  the second write can leave the first one's change out. The device that still
  holds the newer value sees that on its next read and puts it back (`mend`).

**The desktop's two halves.** Each half keeps its own indicators. They used to
save every setting under the same plain names, each keeping a copy of its own
(`paneIndicators:spot` / `:option`) to put back on load — which wrote the copy
over the plain names. With sharing that had two faults, both found by running
it: a value that had just arrived from the phone was overwritten by the index
half's copy and sent back as a change (the phone's RSI, turned off, came back
on); and where the halves differed in a setting, the plain name flipped between
the two on every load. So now **the index half is the plain names** and keeps no
copy — it is the same chart as the phone's — and **the option half never writes
the plain names it keeps in its own copy** (inside `AdvancedChart` the name
`localStorage` is a small object, `chartStore`, that holds those writes back for
that half only). The index half's old copy is put into the plain names once, on
the first load of this version on a desktop, and removed
(`adoptSpotHalfCopy`); nothing is sent by that.

**Switching it off without a deploy.** The value `true` under
`chart_indicators_off` in the same settings store stops the sharing on every
device within twenty seconds — nothing sent, taken or rebuilt; each device keeps
its own storage as it is — and removing it starts it again, when whatever was
changed meanwhile is sent. It exists because the app is not deployed during
market hours:
`curl -X PUT -H 'Content-Type: application/json' -d '{"value":true}' <app>/api/settings/chart_indicators_off`

Run: `npx tsx src/lib/indicatorSync.test.ts`.

## Chart: the indicators that are on are at the top of the list (v317)

He asked for "the selected/used indicators" to be moved to the top of the list.
The order, in every place the list is shown (the chart page, each half of the
desktop, ScalpPro's menu), is: on and starred, on, starred, the rest — each
group in the list's own order. So what is in use is always at the top, and a
star lifts a row within its own group, not above the ones that are on.

**The order is the one the list opened with.** An earlier version moved a row the
moment it was switched, which reshuffled the list under the finger mid-tap; that
is why only a star moved a row for a while. A row switched while the list is
open stays where it is, and has moved the next time the list is opened
(`rowOrder` and `indOnAtOpen` in `src/pages/AdvancedChart.tsx`). A star still
moves its row at once, within its group — that is what a star is tapped for.

## ScalpPro: each chart's menu (v316)

On ScalpPro a chart has no tool bar — the header and the row of five belong to
the chart page. Each of its two charts has a button at the top right of its
name instead (Lemonn's ≡+), which opens a sheet over the lower 62% of the
screen: a rail of four tiles down the left — **Range, Indicators, Drawings,
Settings** — and the open tile's rows beside it. (Lemonn's rail also has Zing
and Templates; Martin asked for these four.) It opens on Indicators. Sizes are
measured off his picture of Lemonn's: the sheet from 37.5% down, a 96pt rail,
79 x 79pt tiles 9pt apart, rows 33.5pt tall and 12.6pt apart.

- Each chart has its own menu and what is done in it is done to that chart:
  the option chart's indicators are the option chart's (all off until one is
  turned on), the index chart's are the index chart's.
- **The rows are the chart page's own lists, not copies.** The indicators list,
  the drawing tools and the settings rows are the same elements the chart
  page's tool bar opens, drawn inside the sheet (`MenuPortal` in
  `src/pages/AdvancedChart.tsx`) and given Lemonn's look by `.scalp-menu-list`
  and `.scalp-menu-rows` in `src/index.css`. A switch added to one is in the
  other. Only Range is written out again.
- A range or a drawing tool, once picked, puts the sheet away (the next taps
  are the drawing's). An indicator's switch leaves it up. An indicator's gear
  puts it away and opens that indicator's settings over the chart, as on the
  chart page. A tap on the dimmed chart closes it.
- Settings has what applies to one chart there: Trade guard (index chart),
  Reload, Sync positions, and Trailing SL on the option chart while a trade is
  open. There is no Quick Trade switch — ScalpPro has no Quick Trade.

## Charts carry no TradingView mark

The charts are drawn with TradingView's Lightweight Charts. The library puts its
mark in the corner of each chart; since v312 it does not (`attributionLogo:
false` in the options both charts are made from, `src/pages/AdvancedChart.tsx`)
— Martin asked for the marks to go, as on Lemonn's charts. The library's licence
asks for its notice and a link to tradingview.com on a page of the app, and the
mark was how it carried them, so they are now a line at the foot of the Control
page (`src/pages/TerminalControl.tsx`, `data-credit="charts"`). **The two go
together: do not remove that line without switching the mark back on.**

## The app's font is Manrope

`src/index.css` (`--font-sans`, `--font-mono`), `index.html` (the font's
`<link>`). Martin, 17 Nov 2026: "use the Manrope fonts all over the app." It is
Lemonn's font; ScalpPro had it from v308.

- Every page, sheet and message is in Manrope, and so is everything drawn on a
  chart: both scales, the crosshair's labels, and the labels painted over the
  candles (CHoCH, FVG, the 15 min pills, the R:R tags). The bias card under the
  chart (`public/bias-panel.js`) too.
- **Figures still line up.** What used to be set in the fixed-width font
  (`font-mono`) asked for columns of numbers that line up and prices that do not
  shuffle sideways as they tick. Manrope's ordinary figures are each as wide as
  they need to be, so `font-mono` now asks for its equal-width figures
  (`tabular-nums`).
- The font is fetched by the `<link>` in `index.html`. A font `@import` in the
  stylesheet never reached the built app — which is why the JetBrains Mono the
  app asked for until v309 never arrived on the live build, and each device
  showed its own fixed-width font. If Manrope cannot be fetched the app falls
  back to the system font.
- A custom font chosen in the app's settings still wins, as before.

## Chart: indicator lines are thin and solid by default

Every indicator line on the chart is 1px and solid unless its own settings say
otherwise: support/resistance, PDH/PDL, H-levels, the 50% level, RSI and its
levels, the middle Bollinger band, session breaks, bias levels, BOS/CHoCH,
institutional levels, breakers and liquidity grabs, divergences. (Before: a mix
of 2px, dashed and dotted.) Where two lines were told apart by solid against
dashed they are now told apart by colour or strength, and by their labels.
Trade lines (entry, SL, TP, armed triggers), the last-price line and hand-drawn
lines are not indicators and keep their own styles.
Styles are saved per device the moment the chart loads, so a device that has
been used holds the old defaults as if they had been chosen. They are put back
to thin and solid **once** per device (`indicatorLinesThin` in localStorage, set
at the top of `src/pages/AdvancedChart.tsx`), including each split-view half's
own copy; anything restyled after that stays as set.

## Chart: your own lines (tap and hold, plus, drag)

`src/pages/AdvancedChart.tsx` ("HIS OWN LINES, THE LEMONN WAY").

- **Add:** tap and hold on the chart, then tap the round **+** beside the price
  axis (hover and click it on a desktop). The line is thin and yellow and goes
  where the crosshair was. The + is a 20px circle on every screen (v312; a
  phone's was 28px until Martin asked for it smaller); on a phone a touch up to
  8px outside the circle still counts.
- **A long press is the only thing that brings the + up on a phone, and it does
  not stay** (v309). The crosshair goes when the finger lifts; the + and the
  candle's O H L C / Vol line stay three and a half seconds more — long enough
  to tap the + — and are then put away. A new touch on the chart puts them
  away at once. A tap or a pan never shows them. (Before, all three stayed on
  the chart until the next tap.)
  - **Fixed in v310:** once the + had been tapped, the chart believed a pointer
    was resting on it for good (a finger never "leaves" a button the way a
    mouse does). From then on a long press drew the crosshair twice — the
    chart's and a second dashed one on top — and a tap elsewhere no longer put
    them away. Only a mouse can rest on the + now.
- **A line that is selected** (just added, or tapped) shows a handle in the
  middle and a small bar of tools at the top left: colour, thickness (1-4px),
  copy, the full editor (price, style, label, alert) and delete. A tap anywhere
  else lets go of it.
- **Move:** drag the handle, or the selected line itself. With a mouse any line
  can be dragged directly. With a finger only the selected one can, so a swipe
  that starts near a line scrolls the chart instead of moving the line.
- **A line belongs to the chart it was drawn on.** Lines made before 16 Nov 2026
  carry no chart and still show on every chart, as they always did.
- The two halves of a split view share the list as it changes (they used to
  overwrite each other's additions).
- The tool bar moves to another corner of the chart when the line's handle would
  be underneath it (a line near the top of a phone chart).

## Chart: drawing tools (trend line, rectangle, Fibonacci, text)

`src/lib/chartDrawings.ts` (the shapes and their arithmetic; test with
`npx tsx src/lib/chartDrawings.test.ts`) and `src/pages/AdvancedChart.tsx`
("DRAWINGS").

- **The pencil-and-ruler button** on the chart's tool bar (it was the risk:reward
  button) opens **Drawing Tools**: Horizontal Line, Trend Line, Rectangle,
  Fibonacci Retracement, Long Position, Short Position, Text.
- **Placing one:** pick the tool, then tap the chart — once for a horizontal
  line, a position box or text; twice (two points) for a trend line, a rectangle
  or a Fibonacci. A chip at the top says what the next tap is for; its cross
  cancels. A tap that places a drawing never opens an order ticket.
- **A drawing that is selected** (just placed, or tapped) shows a dot on each of
  its points — drag one to reshape it — a round handle in the middle that moves
  the whole of it, and a tool bar: colour, thickness (size, for text), copy and
  delete, plus "change the text" for text. A tap anywhere else lets go of it.
  With a keyboard, Delete removes it and Escape lets go.
- **A drawing is only ever moved by its handles**, never by its body: a swipe
  that starts inside a rectangle scrolls the chart.
- **Quick Trade on:** a tap in the middle of a rectangle or a Fibonacci goes
  through to the chart (so it can open the order ticket); its lines still select.
- **Where it lives:** on the chart (instrument) it was drawn on, at the same
  times on every timeframe, saved in the browser under `chartDrawings` (the
  newest 300). The last colour and thickness used for each kind of drawing are
  what the next one of that kind starts with.
- **Position boxes** are the risk:reward box as before; with one on the chart the
  sheet's first row removes it. Capital for the rupee figures is at the bottom of
  the sheet.


## Messages (toasts): one at a time, each one clean

`src/lib/sonnerShim.ts` (every `import { toast } from "sonner"` in the app goes
through it). Status messages share one id, so a new one takes the place of the
one before it instead of stacking. The library does that by merging the new
message into the old, so the shim names every field a message can carry as
empty unless the call sets it: a message never shows a second line, a colour or
a lifetime left over from an earlier one. A message that is on its way out takes
no touches (`src/index.css`), so it cannot swallow a tap meant for the chart.
