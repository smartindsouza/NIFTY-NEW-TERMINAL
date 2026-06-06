import { getLiveOptionChain } from './server/kite_service.js';

async function test() {
  const { getKiteClient } = await import('./server/kite_service.js');
  const kc = getKiteClient();
  console.log("Kite client access token:", kc?.access_token ? "Exists" : "None");
  const data = await getLiveOptionChain();
  console.log("DATA:");
  console.log(data);
}
test().catch(e => console.error(e));
