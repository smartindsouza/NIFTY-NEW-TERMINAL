import { compute_iv } from './black_scholes';

export interface OptionContract {
  strikePrice: number;
  type: 'CE' | 'PE';
  ltp: number;
  chgLtp: number;
  oi: number; // in lakhs
  chgOi: number; // in lakhs
  volume: number;
  iv: number;
  tradingsymbol?: string;
  instrument_token?: number;
  lot_size?: number;
  exchange?: string;
  segment?: string;
  expiry?: string;
  strike?: number;
  option_type?: string;
  source_of_lot_size?: string;
}

export function generateSimulatedChain(spot: number = 22000, expiryDays: number = 2, strikeInterval: number = 50, expiry?: string) {
  const strikes: number[] = [];
  const atm = Math.round(spot / strikeInterval) * strikeInterval;
  for (let i = -15; i <= 15; i++) {
    strikes.push(atm + i * strikeInterval);
  }

  const ceData: Record<number, OptionContract> = {};
  const peData: Record<number, OptionContract> = {};

  const today = new Date();
  
  // Generate 4 weekly expiries starting from today
  const expiries: string[] = [];
  const temp = new Date(today);
  // Find nearest Thursday (day 4)
  const currentDay = temp.getDay();
  let daysToThursday = (4 - currentDay + 7) % 7;
  if (daysToThursday === 0) {
    daysToThursday = 7; // force next Thursday if today is Thursday
  }
  temp.setDate(temp.getDate() + daysToThursday);

  for (let i = 0; i < 4; i++) {
    const thu = new Date(temp);
    thu.setDate(temp.getDate() + i * 7);
    expiries.push(thu.toISOString().split('T')[0]);
  }

  let finalExpiryDate = expiries[0];
  let days = expiryDays;
  if (expiry) {
    finalExpiryDate = expiry;
    const expDate = new Date(expiry);
    const diffTime = expDate.getTime() - today.getTime();
    days = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  } else {
    days = 2; // default nearest
    finalExpiryDate = expiries[0];
  }

  const time_years = Math.max(days / 365.0, 0.001);

  strikes.forEach(strike => {
    // Generate realistic basic values
    const diff = Math.abs(strike - atm) / strikeInterval;
    
    // OI peaks around ATM and out-of-money zones
    const baseOi = Math.max(10, 200 - diff * 10 + Math.random() * 50);
    const oiChg = (Math.random() - 0.4) * 20; 

    // Pricing (simple intrinsic + random time value)
    let cePrice = Math.max(0, spot - strike) + (200 / (diff + 1)) * Math.random();
    let pePrice = Math.max(0, strike - spot) + (200 / (diff + 1)) * Math.random();

    const ceIV = compute_iv(cePrice, spot, strike, time_years, 'CE');
    const peIV = compute_iv(pePrice, spot, strike, time_years, 'PE');

    // Simulate price change. Could be negative or positive.
    const ceChgLtp = (Math.random() - 0.5) * 50;
    const peChgLtp = (Math.random() - 0.5) * 50;

    const isBank = spot > 40000;
    const isFinnifty = spot > 20000 && spot < 23000 && Math.random() > 0.5; // fallback
    const name = isBank ? "BANKNIFTY" : (isFinnifty ? "FINNIFTY" : "NIFTY");
    
    const parsedExp = new Date(finalExpiryDate);
    const yy = String(parsedExp.getFullYear()).slice(-2);
    const mRaw = parsedExp.getMonth() + 1;
    const m = mRaw < 10 ? String(mRaw) : (mRaw === 10 ? 'O' : (mRaw === 11 ? 'N' : 'D'));
    const dd = String(parsedExp.getDate()).padStart(2, '0');
    const expiryShort = `${yy}${m}${dd}`;
    
    let simulatedLotSize = 65; // NIFTY default dynamic lot size
    if (name === "BANKNIFTY") {
      simulatedLotSize = 15;
    } else if (name === "FINNIFTY") {
      simulatedLotSize = 25;
    }

    ceData[strike] = {
      strikePrice: strike,
      type: 'CE',
      ltp: parseFloat(cePrice.toFixed(2)),
      chgLtp: parseFloat(ceChgLtp.toFixed(2)),
      oi: parseFloat(baseOi.toFixed(2)),
      chgOi: parseFloat(oiChg.toFixed(2)),
      volume: Math.floor(baseOi * 10 * Math.random()),
      iv: ceIV,
      tradingsymbol: `${name}${expiryShort}${strike}CE`,
      instrument_token: 1300000 + strike + 1,
      lot_size: simulatedLotSize,
      exchange: 'NFO',
      segment: 'NFO-OPT',
      expiry: finalExpiryDate,
      strike: strike,
      option_type: 'CE',
      source_of_lot_size: 'Kite Simulated Instrument Master'
    };

    peData[strike] = {
      strikePrice: strike,
      type: 'PE',
      ltp: parseFloat(pePrice.toFixed(2)),
      chgLtp: parseFloat(peChgLtp.toFixed(2)),
      oi: parseFloat(baseOi.toFixed(2)),
      chgOi: parseFloat(oiChg.toFixed(2)),
      volume: Math.floor(baseOi * 10 * Math.random()),
      iv: peIV,
      tradingsymbol: `${name}${expiryShort}${strike}PE`,
      instrument_token: 1300000 + strike + 2,
      lot_size: simulatedLotSize,
      exchange: 'NFO',
      segment: 'NFO-OPT',
      expiry: finalExpiryDate,
      strike: strike,
      option_type: 'PE',
      source_of_lot_size: 'Kite Simulated Instrument Master'
    };
  });

  return { 
    spot, 
    strikes, 
    ceData, 
    peData, 
    expiryDate: finalExpiryDate,
    expiryDays: days,
    expiries
  };
}
