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
  TP2 → SL to TP1, TP3 → SL to TP2 and trailing, no half and no 2 × target.)
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

## Trade guard: every order that opens a trade

`server/trade_guard.ts`. Martin's own rules — no new trade before 10:00, 4 trades
a day, stop for the day at ₹3,000 loss. A rule can be tightened at once and
relaxed only from the next trading day. It is checked for:

- the order ticket and Quick Trade (`POST /api/orders` with `journal: true`);
- My Order — the count and loss rules when it is created, every rule when it
  fires;
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
- **The option chart ends exactly where the fixed tool bar begins**, whatever is
  above it. The positions banner that appears while a trade is on pushes the
  page down; the chart gives up exactly that much and takes it back when the
  trade is exited. (It used to keep the shorter size after an exit, leaving an
  empty band under the chart, and on entry could run under the tool bar.) The
  clearance is measured ("THE PART OF THIS PAGE THAT LIES UNDER THE FIXED TOOL
  BAR"), not a fixed number.
- **Any chart re-fits itself when it is moved**, not only when it is resized
  ("THE CHART MOVED WITHOUT CHANGING SIZE").

## Chart on a phone: header, a row of five, Settings, floating Quick Trade

`src/pages/AdvancedChart.tsx` ("THE LEMONN LAYOUT ON A PHONE"). Below 768px wide
the chart page is laid out the way the Lemonn chart screen is. Every control
runs the code its old button ran — only where it is has changed. The desktop
tool bar and the split view are untouched.

- **Header:** a back arrow (the screen you came from, or Home), the chart's name
  (the index and option choosers), and a search button that opens the symbol
  search in the header with its results below. Under it, the live price with the
  day's change (against the last close of the previous session) and the clock.
  The "Advanced Trading Chart" title row is gone on a phone.
- **A row of five under the chart:** Range, Interval, Indicators, Drawings,
  Settings.
  - **Range** — 1D, 2D, 5D, 1M, All: how many sessions back from the newest
    candle are on screen. The button shows the choice until the timeframe or
    the chart changes.
  - **Interval** — the same chooser as before, drawn as the value with its name.
- **Settings** holds what used to fill the right of the bar: Trailing SL (on the
  option chart of an open trade; On/Off at the end of the row) or My order (on
  an index chart), Trade guard (today's count at the end of the row, red while
  entries are blocked), SL & TP (the levels new trades get), Reload, and Sync
  positions (from Zerodha).
- **Few words.** Martin, 16 Nov 2026: "as simple as the lemon app ... Keep the
  texts such as descriptions etc to minimal or avoid it wherever possible." The
  sheets here have no headings and no descriptions, and a row's name is two
  words at most. New screens follow the same rule.
- **Quick Trade floats.** A round ⚡ button over the chart: a tap switches it (on
  for 1 minute, as before), a drag moves it anywhere, and it stays where it is
  put on that phone (`quickTradeFab` in the browser). It starts at the top right
  of the chart. It steps aside while a sheet or menu is open, while a drawing
  tool is armed, while a line or drawing is selected and while the strike menu
  is up — in each of those a tap belongs to something else, and the button would
  otherwise sit on top of that thing's own controls.
- **The chart keeps its layers to itself** (`max-md:isolate`): the trade chips,
  line tools and the like are no longer painted on top of an open sheet (the
  chips used to lie across the Trade guard sheet). The RSI pane does the same,
  so the strike menu, which is taller than a short phone chart, lies over the
  pane and every row of it can be pressed.
- **A second row in the bar:** Option Chain (opens the Chain page) and ScalpPro
  (below).

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
  Trade button); everywhere else they still need it.
- A reload stays on ScalpPro (`scalpPro` in the session); the back arrow returns
  to the index chart.
- Not here yet: Limit / Trigger orders, the Positions · Orders · Option chain
  row, and dragging SL / TP out of the entry line when the automatic ones are
  switched off.

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
  Trade is on** (they then show chevrons); with it off a press says so. Inside
  the pane the line follows the finger to the tick; push past the top or bottom
  edge and the chart slides that way until the finger comes back.
- **A leg that is switched off** shows as a grey `SL off` / `TP off` beside the
  position (tap: opens TP & SL). A trade running free shows both, and keeps its
  entry line.
- On the **spot chart** the mirrored lines carry the same chips, with the premium
  they stand for (`≈ ₹127.50`).

Nothing here changes which levels are armed, the entry wall, or where a drop is
sent; it replaces the on-line pills and the old "grab the line anywhere" drag.

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
  where the crosshair was.
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
