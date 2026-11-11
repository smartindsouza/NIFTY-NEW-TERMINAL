// CHART FROM THE MARKET CONTEXT SIDEBAR (11 Nov 2026).
//
// Martin: "whatever is in the sidebar is available in Zerodha — when I click one,
// open its chart using Zerodha's data." Each sidebar row key maps to a Zerodha
// instrument, resolved from Kite's full instrument dump (never a hardcoded token,
// MCX futures roll every month):
//   • Indian rows  → the NSE/BSE index itself.
//   • US/UK/Asia   → Kite's GLOBAL indices (the "Global Indices" watchlist).
//   • Commodities  → the nearest-expiry MCX future.
// Rows with no Zerodha equivalent (FTSE 250, KOSPI, Brent) return available:false
// and the sidebar leaves them unclickable. Every chart opened this way is
// reference-only: the chart page hides order controls for it.

import { filterInstrumentsAnyExchange } from './kite_service';

type Ref = { exchange: string; match: string; label: string; kind: 'NSE' | 'GLOBAL' | 'MCX'; mcxFut?: boolean };

// Indian rows use the exact Kite index tradingsymbol (same names the sidebar
// already quotes as "NSE:<name>").
const MAP: Record<string, Ref> = {
  BANKNIFTY: { exchange: 'NSE', match: 'NIFTY BANK', label: 'NIFTY BANK', kind: 'NSE' },
  FINNIFTY: { exchange: 'NSE', match: 'NIFTY FIN SERVICE', label: 'FIN NIFTY', kind: 'NSE' },
  MIDCAP100: { exchange: 'NSE', match: 'NIFTY MIDCAP 100', label: 'MIDCAP 100', kind: 'NSE' },
  SMLCAP100: { exchange: 'NSE', match: 'NIFTY SMLCAP 100', label: 'SMALLCAP 100', kind: 'NSE' },
  MICROCAP250: { exchange: 'NSE', match: 'NIFTY MICROCAP250', label: 'MICROCAP 250', kind: 'NSE' },
  AUTO: { exchange: 'NSE', match: 'NIFTY AUTO', label: 'NIFTY AUTO', kind: 'NSE' },
  COMMODITIES: { exchange: 'NSE', match: 'NIFTY COMMODITIES', label: 'NIFTY COMMODITIES', kind: 'NSE' },
  CONSUMPTION: { exchange: 'NSE', match: 'NIFTY CONSUMPTION', label: 'NIFTY CONSUMPTION', kind: 'NSE' },
  ENERGY: { exchange: 'NSE', match: 'NIFTY ENERGY', label: 'NIFTY ENERGY', kind: 'NSE' },
  FMCG: { exchange: 'NSE', match: 'NIFTY FMCG', label: 'NIFTY FMCG', kind: 'NSE' },
  INFRA: { exchange: 'NSE', match: 'NIFTY INFRA', label: 'NIFTY INFRA', kind: 'NSE' },
  IT: { exchange: 'NSE', match: 'NIFTY IT', label: 'NIFTY IT', kind: 'NSE' },
  MEDIA: { exchange: 'NSE', match: 'NIFTY MEDIA', label: 'NIFTY MEDIA', kind: 'NSE' },
  METAL: { exchange: 'NSE', match: 'NIFTY METAL', label: 'NIFTY METAL', kind: 'NSE' },
  PHARMA: { exchange: 'NSE', match: 'NIFTY PHARMA', label: 'NIFTY PHARMA', kind: 'NSE' },
  PSUBANK: { exchange: 'NSE', match: 'NIFTY PSU BANK', label: 'PSU BANK', kind: 'NSE' },
  PVTBANK: { exchange: 'NSE', match: 'NIFTY PVT BANK', label: 'PRIVATE BANK', kind: 'NSE' },
  REALTY: { exchange: 'NSE', match: 'NIFTY REALTY', label: 'NIFTY REALTY', kind: 'NSE' },
  VIX: { exchange: 'NSE', match: 'INDIA VIX', label: 'INDIA VIX', kind: 'NSE' },
  SENSEX: { exchange: 'BSE', match: 'SENSEX', label: 'SENSEX', kind: 'NSE' },
  SPX: { exchange: 'GLOBAL', match: 'US500', label: 'US500 (S&P 500)', kind: 'GLOBAL' },
  NDX: { exchange: 'GLOBAL', match: 'US100', label: 'US100 (Nasdaq 100)', kind: 'GLOBAL' },
  DJI: { exchange: 'GLOBAL', match: 'US30', label: 'US30 (Dow)', kind: 'GLOBAL' },
  DJI_IDX: { exchange: 'GLOBAL', match: 'US30', label: 'US30 (Dow)', kind: 'GLOBAL' },
  FTSE: { exchange: 'GLOBAL', match: 'UK100', label: 'UK100 (FTSE 100)', kind: 'GLOBAL' },
  HSI: { exchange: 'GLOBAL', match: 'HANGSENG', label: 'HANG SENG', kind: 'GLOBAL' },
  GOLD: { exchange: 'MCX', match: 'GOLD', label: 'GOLD (MCX)', kind: 'MCX', mcxFut: true },
  SILVER: { exchange: 'MCX', match: 'SILVER', label: 'SILVER (MCX)', kind: 'MCX', mcxFut: true },
  OIL: { exchange: 'MCX', match: 'CRUDEOIL', label: 'CRUDE OIL (MCX)', kind: 'MCX', mcxFut: true },
};
export const chartRefKeys = () => Object.keys(MAP);

const memo = new Map<string, { at: number; v: any }>();
export async function resolveChartRef(key: string): Promise<any> {
  const r = MAP[key];
  if (!r) return { available: false, reason: 'no Zerodha equivalent' };
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  let inst: any = null;
  if (r.mcxFut) {
    // Nearest unexpired future of that commodity (the big contract, not MINI/M).
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const futs = (await filterInstrumentsAnyExchange((i: any) => i.exchange === 'MCX' && i.name === r.match && i.instrument_type === 'FUT'))
      .map((i: any) => ({ i, exp: i.expiry ? new Date(i.expiry).toISOString().slice(0, 10) : '' }))
      .filter((x: any) => x.exp >= today && new RegExp(`^${r.match}\\d`).test(String(x.i.tradingsymbol)))
      .sort((a: any, b: any) => a.exp.localeCompare(b.exp));
    inst = futs[0]?.i || null;
  } else {
    inst = (await filterInstrumentsAnyExchange((i: any) => i.exchange === r.exchange && String(i.tradingsymbol).toUpperCase() === r.match))[0] || null;
  }
  const v = inst
    ? { available: true, token: String(inst.instrument_token), tradingsymbol: inst.tradingsymbol, exchange: inst.exchange, label: r.label, kind: r.kind }
    : { available: false, reason: `${r.match} not found on ${r.exchange} in the Zerodha instrument list` };
  memo.set(key, { at: Date.now(), v });
  return v;
}

export function registerChartRef(app: any) {
  app.get('/api/chart-ref', async (req: any, res: any) => {
    try {
      const key = String(req.query.key || '');
      if (key === '_all') {
        const out: any = {};
        for (const k of Object.keys(MAP)) out[k] = await resolveChartRef(k);
        return res.json(out);
      }
      res.json(await resolveChartRef(key));
    } catch (e: any) { res.status(500).json({ available: false, reason: e?.message || String(e) }); }
  });
}
