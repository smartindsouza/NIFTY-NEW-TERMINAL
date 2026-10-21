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
