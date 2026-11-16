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
- **Stop:** exactly the message's SL, armed in `premium_exit_rules` (TP leg off).
  TP1 → SL to the fill price · TP2 → SL to TP1 · TP3 → SL to TP2 and you are
  asked "Exit now / Keep trailing"; Keep trails in (TP3 − TP2) steps. Square-off
  at `squareOff` (15:15). Moving the SL on the chart hands the trade to you.
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

