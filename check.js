const https = require('https');
https.get('https://kite.trade/docs/connect/v3/market-quotes/', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => { 
    console.log("Docs fetched, length:", data.length);
    const match = data.match(/"oi":.*?,/g);
    console.log("OI matches:", match);
    const prev = data.match(/.[^"]*previous_oi[^"]*./g);
    console.log("Prev matches:", prev);
  });
});
