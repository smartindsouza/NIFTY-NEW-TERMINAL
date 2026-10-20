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
