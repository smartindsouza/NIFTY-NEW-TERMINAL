import { getTechnicalAnalysis } from './server/technical_analysis.js';

async function testta() {
  // Let's pass the spot from kite
  const spot = 23689.5;
  const data = await getTechnicalAnalysis(spot, 5);
  console.log("TA:");
  console.log(data);
}
testta().catch(e => console.error(e));
