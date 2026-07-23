import axios from 'axios';

export async function getFiiData() {
  try {
    // Helper to format date as DDMMYYYY
    const formatDate = (date: Date) => {
      const d = String(date.getDate()).padStart(2, '0');
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const y = date.getFullYear();
      return `${d}${m}${y}`;
    };

    const history = [];
    let latestData = null;
    let actualDateStr = '';

    // Loop backwards to find the last available end-of-day file
    // Check up to 12 days back to get ~5 trading days
    for (let i = 0; i < 12; i++) {
        if (history.length >= 5) break;

        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - i);

        // Skip weekends
        if (targetDate.getDay() === 0 || targetDate.getDay() === 6) continue;

        const dateStr = formatDate(targetDate);
        const url = `https://archives.nseindia.com/content/nsccl/fao_participant_oi_${dateStr}.csv`;

        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/csv,application/vnd.ms-excel,application/csv,*/*'
                },
                timeout: 5000
            });

            if (response.status === 200 && response.data) {
                const lines = response.data.split('\n');
                let fiiLong = 0, fiiShort = 0;
                let diiLong = 0, diiShort = 0;

                for (const line of lines) {
                    if (line.startsWith('FII,')) {
                        const cols = line.split(',');
                        fiiLong = parseInt(cols[1], 10) || 0;
                        fiiShort = parseInt(cols[2], 10) || 0;
                    }
                    if (line.startsWith('DII,')) {
                        const cols = line.split(',');
                        diiLong = parseInt(cols[1], 10) || 0;
                        diiShort = parseInt(cols[2], 10) || 0;
                    }
                }

                if (fiiLong > 0 || fiiShort > 0) {
                   const netFii = fiiLong - fiiShort;
                   const netDii = diiLong - diiShort;
                   const fiiLongRatio = parseFloat(((fiiLong / (fiiLong + fiiShort)) * 100).toFixed(2));

                   history.unshift({
                       date: targetDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
                       fiiNetFutures: netFii,
                       diiNetFutures: netDii,
                       fiiLongRatio
                   });

                   if (!latestData) {
                       latestData = {
                          fiiLongRatio,
                          trend: fiiLongRatio > 50 ? "BULLISH" : "BEARISH",
                          longContracts: fiiLong,
                          shortContracts: fiiShort,
                          lastUpdated: targetDate.toISOString()
                       };
                       actualDateStr = dateStr;
                   }
                }
            }
        } catch (e: any) {
            if (e.response && (e.response.status === 404 || e.response.status === 403)) {
                continue;
            }
            console.warn(`Warning checking NSE data for ${dateStr}:`, e.message);
        }
    }

    if (!latestData) {
         // HONEST FALLBACK: NSE archives unreachable or no recent file found.
         // Report it plainly instead of fabricating numbers — this page informs
         // real trading decisions, so no data is always better than fake data.
         return {
           status: "UNAVAILABLE",
           message: "NSE participant OI report could not be fetched (checked the last 12 days). Showing no data rather than simulated data.",
           data: { history: [] }
         };
    }

    return {
      status: "SUCCESS",
      message: `Parsed direct from NSE Archives (${actualDateStr})`,
      data: {
         ...latestData,
         history
      }
    };
  } catch (error: any) {
    // HONEST FALLBACK: unexpected failure. Same principle — never simulate.
    return {
      status: "UNAVAILABLE",
      message: `NSE participant OI fetch failed: ${error?.message || String(error)}. Showing no data rather than simulated data.`,
      data: { history: [] }
    };
  }
}


// ---------------------------------------------------------------------------
// CASH-SEGMENT FII/DII activity (provisional, in Rs crore) — the figure most
// public websites show. Source: NSE's own fiidiiTradeReact API. NSE's main
// site requires a cookie handshake and sometimes refuses datacenter IPs, so
// this NEVER fabricates: on failure it returns the last good fetch flagged
// stale, or an explicit unavailable marker. 30-min cache.
let cashCache: { data: any; at: number } | null = null;

export async function getCashFiiDii(): Promise<any> {
    if (cashCache && Date.now() - cashCache.at < 30 * 60 * 1000) return cashCache.data;
    try {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
        const home = await axios.get('https://www.nseindia.com/', {
            headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
            timeout: 8000,
        });
        const cookies = ((home.headers['set-cookie'] as any) || []).map((c: string) => c.split(';')[0]).join('; ');
        const r = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', {
            headers: {
                'User-Agent': ua, 'Accept': 'application/json',
                'Referer': 'https://www.nseindia.com/reports/fii-dii',
                ...(cookies ? { Cookie: cookies } : {}),
            },
            timeout: 8000,
        });
        const arr = Array.isArray(r.data) ? r.data : [];
        const pick = (cat: string) => arr.find((x: any) => String(x.category || '').toUpperCase().includes(cat));
        const num = (v: any) => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
        const fii = pick('FII'); const dii = pick('DII');
        if (!fii && !dii) throw new Error('unexpected NSE response shape');
        const data = {
            date: (fii && fii.date) || (dii && dii.date) || null,
            fii: fii ? { buy: num(fii.buyValue), sell: num(fii.sellValue), net: num(fii.netValue) } : null,
            dii: dii ? { buy: num(dii.buyValue), sell: num(dii.sellValue), net: num(dii.netValue) } : null,
            source: 'NSE provisional — cash segment, Rs crore',
            fetchedAt: Date.now(),
        };
        cashCache = { data, at: Date.now() };
        return data;
    } catch (e: any) {
        if (cashCache) return { ...cashCache.data, stale: true };
        return { unavailable: true, error: e?.message || String(e) };
    }
}
