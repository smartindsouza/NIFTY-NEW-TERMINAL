import { getKiteClient } from './server/kite_service.js';

async function test() {
  try {
    const kc = getKiteClient();
    if (!kc || !kc.access_token) {
        console.log("No token");
        return;
    }
    
    // Attempt to fetch historical data for Nifty 50 (instrument_token: 256265)
    // For 5 minute interval
    const today = new Date();
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const data = await kc.getHistoricalData("256265", "5minute", yesterday, today);
    console.log(data.slice(-5));
  } catch (e) {
    console.error(e);
  }
}

test();
