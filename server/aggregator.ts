export function aggregateCandles(candles: any[], targetIntervalMin: number, baseIntervalMin: number) {
  if (targetIntervalMin <= baseIntervalMin) return candles;
  
  const aggregated: any[] = [];
  let currentBucket: any = null;

  for (const c of candles) {
    const d = new Date(c.date);
    // Convert to IST
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istd = new Date(d.getTime() + istOffset);
    
    // Determine bucket index
    let bucketId = "";
    
    if (targetIntervalMin < 1440) {
      // Intraday
      const y = istd.getUTCFullYear();
      const m = istd.getUTCMonth();
      const day = istd.getUTCDate();
      
      const minsSinceMidnight = istd.getUTCHours() * 60 + istd.getUTCMinutes();
      const tradeTimeMin = Math.max(0, minsSinceMidnight - (9 * 60 + 15)); // mins since 09:15
      
      const bucketIdx = Math.floor(tradeTimeMin / targetIntervalMin);
      bucketId = `${y}-${m}-${day}-B${bucketIdx}`;
    } else if (targetIntervalMin === 1440) {
      bucketId = `${istd.getUTCFullYear()}-${istd.getUTCMonth()}-${istd.getUTCDate()}`;
    } else if (targetIntervalMin === 1440 * 7) { // 1 Week
      let dayOrig = istd.getUTCDay(); // 0 is Sunday
      let diff = istd.getUTCDate() - dayOrig + (dayOrig === 0 ? -6 : 1); 
      let monday = new Date(istd);
      monday.setUTCDate(diff);
      bucketId = `W-${monday.getUTCFullYear()}-${monday.getUTCMonth()}-${monday.getUTCDate()}`;
    } else if (targetIntervalMin >= 1440 * 28) { // 1 Month
      bucketId = `M-${istd.getUTCFullYear()}-${istd.getUTCMonth()}`;
    }

    if (!currentBucket || currentBucket.id !== bucketId) {
      if (currentBucket) aggregated.push(currentBucket);
      currentBucket = {
        id: bucketId,
        date: c.date, // keep original UTC date of the first candle in bucket
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0
      };
    } else {
      currentBucket.high = Math.max(currentBucket.high, c.high);
      currentBucket.low = Math.min(currentBucket.low, c.low);
      currentBucket.close = c.close;
      currentBucket.volume += (c.volume || 0);
    }
  }
  
  if (currentBucket) aggregated.push(currentBucket);
  
  return aggregated;
}
