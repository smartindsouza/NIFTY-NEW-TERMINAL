import React, { useMemo, useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X, Plus, ChevronDown, Check, Eye, Settings, Edit2 } from "lucide-react";
import { toast } from "sonner";
import { notificationService } from "../lib/notificationService";
import { getDivergences } from "../lib/divergence";
import { calculateBollingerBands } from "../indicators/bollingerBands";
import { format } from "date-fns";
import { SymbolSearch } from "../components/SymbolSearch";
import { Instrument } from "../hooks/useSymbolSearch";
import { 
  createChart, 
  ColorType, 
  CrosshairMode, 
  IChartApi, 
  CandlestickSeries, 
  HistogramSeries, 
  LineSeries, 
  createSeriesMarkers 
} from "lightweight-charts";
import { useMarginPreview, getMarginDiagnostics, patchMarginDiagnostics } from "../hooks/useMarginPreview";
import { getWsDiagnostics, subscribeToTicks, addWsMessageListener } from "../hooks/useWebSocket";
import { useProfiler } from "../hooks/useProfiler";
import { computeMasterSignal, getCandleOiSentiment } from "../../lib/decisionEngine";

// Patch HTMLCanvasElement.prototype.getContext to intercept 2D contexts for rounding corners
if (typeof window !== 'undefined' && !(HTMLCanvasElement.prototype as any).__patched) {
  (HTMLCanvasElement.prototype as any).__patched = true;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = originalGetContext.call(this, type, ...args);
    if (type === '2d' && ctx && !(ctx as any).__patched) {
      (ctx as any).__patched = true;
      const originalFillRect = ctx.fillRect;
      ctx.fillRect = function (x, y, w, h) {
        let style = ctx.fillStyle;
        if (typeof style === 'string') {
          style = style.toLowerCase();
          const isVolume = style.includes('rgba') && style.includes('0.4');
          if (w > 2 && w < 100 && h > 2) {
            ctx.beginPath();
            const radius = isVolume ? Math.min(3, w / 2, h / 2) : Math.min(w / 2, h / 2);
            if (ctx.roundRect) {
              ctx.roundRect(x, y, w, h, isVolume ? [radius, radius, 0, 0] : radius);
            } else {
              ctx.rect(x, y, w, h);
            }
            ctx.fill();
            return;
          }
        }
        originalFillRect.call(ctx, x, y, w, h);
      };
    }
    return ctx;
  };
}

export function calculateZerodhaCharges(action: 'BUY' | 'SELL', quantity: number, price: number) {
  const premium = quantity * price;
  const brokerage = 20.00; // Zerodha flat ₹20 per executed order
  const stt = action === 'SELL' ? (premium * 0.001) : 0; // STT: 0.1% on Option sell premium
  const txnCharge = premium * 0.0003503; // Exchange Transaction Charges (NSE): 0.03503%
  const gst = (brokerage + txnCharge) * 0.18; // GST: 18% of (Brokerage + Txn charge)
  const sebi = premium * 0.000001; // SEBI turnover fee: 0.0001% (₹10/crore)
  const stamp = action === 'BUY' ? (premium * 0.00003) : 0; // Stamp duty: 0.003% on Buy side premium
  const total = brokerage + stt + txnCharge + gst + sebi + stamp;
  
  return {
    brokerage,
    stt,
    txnCharge,
    gst,
    sebi,
    stamp,
    total
  };
}

interface OrderTicketModalProps {
  onClose: () => void;
  ticket: {
    action: 'BUY' | 'SELL';
    optionType: 'CE' | 'PE';
    underlying: string;
    expiry: string;
    strike: number;
    tradingsymbol: string;
    instrument_token: string;
    ltp: number;
    lotSize?: number;
    quantity: number;
    product: 'MIS' | 'NRML';
    orderType: 'MARKET' | 'LIMIT';
    limitPrice: number;
    exchange?: string;
    segment?: string;
    source_of_lot_size?: string;
  };
  expiries: string[];
  onExpiryChange: (newExpiry: string) => void;
  onSubmit: (data: {
    action: 'BUY' | 'SELL';
    tradingsymbol: string;
    quantity: number;
    product: 'MIS' | 'NRML';
    orderType: 'MARKET' | 'LIMIT';
    price?: number;
  }) => void;
  processing: boolean;
  availBalance: number;
  setAvailBalance: (balance: number) => void;
  onRefreshBalance: () => void;
}

function OrderTicketModal({ onClose, ticket, expiries, onExpiryChange, onSubmit, processing, availBalance, setAvailBalance, onRefreshBalance }: OrderTicketModalProps) {
  const [product, setProduct] = useState<'MIS' | 'NRML'>(ticket.product);
  const [orderType] = useState<'MARKET' | 'LIMIT'>('LIMIT'); // Always LIMIT — Kite rejects MARKET orders via API
  const [lots, setLots] = useState<number>(() => {
    const size = ticket.lotSize || 75; // Default to 75 as standard NIFTY lot size if missing
    return Math.max(1, Math.round((ticket.quantity || size) / size));
  });
  const [limitPrice, setLimitPrice] = useState<string>(String(ticket.limitPrice));

  const [isEditingBalance, setIsEditingBalance] = useState(false);
  const [balanceInput, setBalanceInput] = useState(String(availBalance));

  useEffect(() => {
    setBalanceInput(String(availBalance));
  }, [availBalance]);

  const [liveLtp, setLiveLtp] = useState<number>(ticket.ltp);
  const [prevLtp, setPrevLtp] = useState<number>(ticket.ltp);
  const [priceDirection, setPriceDirection] = useState<'UP' | 'DOWN' | 'NEUTRAL'>('NEUTRAL');

  // Auto-fill the LIMIT price from the live premium: BUY slightly above (+0.5%),
  // SELL slightly below (-0.5%), so it fills immediately. Rounded to the 0.05 tick.
  // Updates live as the premium moves — the user never types a price.
  useEffect(() => {
    if (!liveLtp || liveLtp <= 0) return;
    const buffer = ticket.action === 'BUY' ? 1.005 : 0.995;
    const tickRounded = Math.round((liveLtp * buffer) / 0.05) * 0.05;
    setLimitPrice(tickRounded.toFixed(2));
  }, [liveLtp, ticket.action]);

  useEffect(() => {
    let isActive = true;
    const pollLtp = async () => {
      try {
        const spotParam = "";
        const expiryParam = ticket.expiry ? `&expiry=${encodeURIComponent(ticket.expiry)}` : "";
        const res = await fetch(`/api/option-chain?symbol=${encodeURIComponent(ticket.underlying)}${spotParam}${expiryParam}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!isActive) return;
        
        const optionMap = ticket.optionType === 'CE' ? data.ceData : data.peData;
        const contract = optionMap && optionMap[ticket.strike];
        if (contract && typeof contract.ltp === 'number' && contract.ltp > 0) {
          setLiveLtp(contract.ltp);
        }
      } catch (err) {
        console.warn("Polling dynamic option LTP failed:", err);
      }
    };

    pollLtp();
    const intervalId = setInterval(pollLtp, 1500);

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }, [ticket.underlying, ticket.expiry, ticket.strike, ticket.optionType]);

  useEffect(() => {
    if (liveLtp > prevLtp) {
      setPriceDirection('UP');
      const timer = setTimeout(() => setPriceDirection('NEUTRAL'), 800);
      setPrevLtp(liveLtp);
      return () => clearTimeout(timer);
    } else if (liveLtp < prevLtp) {
      setPriceDirection('DOWN');
      const timer = setTimeout(() => setPriceDirection('NEUTRAL'), 800);
      setPrevLtp(liveLtp);
      return () => clearTimeout(timer);
    }
  }, [liveLtp, prevLtp]);

  const [showChargesBreakdown, setShowChargesBreakdown] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const isBuy = ticket.action === 'BUY';
  const lotSize = ticket.lotSize;
  const quantity = lotSize ? (lots * lotSize) : 0;
  const missingContext = !ticket.instrument_token || !ticket.tradingsymbol;

  const currentPrice = orderType === 'LIMIT' ? (parseFloat(limitPrice) || 0) : liveLtp;
  
  const estimatedChargesDetails = calculateZerodhaCharges(ticket.action, quantity, currentPrice);
  
  const marginPreview = useMarginPreview({
    exchange: ticket.exchange || 'NFO',
    tradingsymbol: ticket.tradingsymbol,
    quantity: quantity,
    transaction_type: ticket.action,
    product: product,
    order_type: orderType,
    price: currentPrice,
    variety: 'regular',
    localTotalMargin: quantity * currentPrice,
    localTotalCharges: estimatedChargesDetails.total
  });

  const isKite = !!marginPreview.data;
  const isLocalFallback = !marginPreview.data && !marginPreview.loading;

  const reqAmount = isKite ? marginPreview.data!.total : (quantity * currentPrice);
  const charges = isKite ? marginPreview.data!.charges.total : estimatedChargesDetails.total;

  const [refreshing, setRefreshing] = useState(false);

  const [lotSizingMode, setLotSizingMode] = useState<'AUTO MAX' | 'MANUAL'>('AUTO MAX');

  useEffect(() => {
    localStorage.setItem('lotSizingMode', lotSizingMode);
  }, [lotSizingMode]);

  let costPerLot = 0;
  let maxAffordableLots = 0;
  let calculationSource = 'Unavailable';

  if (isKite && marginPreview.data && lotSize) {
    // Derive per-lot cost from the quantity the margin DATA was actually computed for —
    // NOT the current `lots`. The margin response lags lot changes by a fetch; dividing a
    // stale total by an ever-growing `lots` is what made the figures explode and then settle.
    // Using the data's own quantity keeps per-lot stable even while a new fetch is in flight.
    const dataQty = marginPreview.dataQuantity || quantity;
    const dataLots = dataQty / lotSize;
    if (dataLots > 0) {
      costPerLot = (marginPreview.data.total + marginPreview.data.charges.total) / dataLots;
      calculationSource = 'Kite Margin API';
    }
  } else if (isLocalFallback && lots > 0) {
    costPerLot = (reqAmount / lots) + (charges / lots); // local estimate is linear in lots, so already stable
    calculationSource = 'Local Estimate';
  }

  if (costPerLot > 0) {
    maxAffordableLots = Math.floor(availBalance / costPerLot);
  }

  useEffect(() => {
    if (lotSizingMode !== 'AUTO MAX') return;
    if (costPerLot <= 0) return;
    // costPerLot is now stable, so the target is a fixed point — it converges in one step
    // and no longer oscillates or runs away.
    const targetLots = maxAffordableLots >= 1 ? maxAffordableLots : 1;
    if (lots !== targetLots) setLots(targetLots);
  }, [lotSizingMode, costPerLot, maxAffordableLots, lots]);

  const handleRefreshInstruments = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/instruments/refresh', { method: 'POST' });
      if (res.ok) {
        toast.success("Instruments master refetched and rebuilt successfully!");
        onExpiryChange(ticket.expiry); // forces reload
      } else {
        toast.error("Failed to refresh instruments from Zerodha");
      }
    } catch (err) {
      toast.error("Network error refreshing instruments");
    } finally {
      setRefreshing(false);
    }
  };

  const handleLotsChange = (valStr: string) => {
    const parsed = parseInt(valStr, 10);
    setLots(isNaN(parsed) || parsed < 0 ? 0 : parsed);
  };

  const adjustLots = (diff: number) => {
    if (!lotSize) return;
    setLots(prev => {
      const next = prev + diff;
      return next < 1 ? 1 : next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (missingContext) return;
    if (!lotSize || lotSize <= 0) {
      toast.error(`Lot size unavailable. Refresh instruments.`);
      return;
    }
    if (lots <= 0) {
      toast.error(`Please select at least 1 lot`);
      return;
    }
    onSubmit({
      action: ticket.action,
      tradingsymbol: ticket.tradingsymbol,
      quantity,
      product,
      orderType,
      price: orderType === 'LIMIT' ? parseFloat(limitPrice) : undefined
    });
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-muted p-4 text-foreground/90">
      <div className="bg-card border border-0 rounded-xl w-full max-w-[420px] overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* Header with light green color */}
        <div className="p-4 flex items-center justify-between bg-emerald-100/90 text-emerald-800 border-b border-emerald-200 dark:bg-emerald-950/45 dark:text-emerald-300 dark:border-emerald-800/40">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded tracking-wide ${isBuy ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-350' : 'bg-rose-500/20 text-rose-700 dark:text-rose-350'}`}>
              {ticket.action}
            </span>
            <span className="font-semibold text-sm tracking-wider">
              {ticket.tradingsymbol}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-foreground">
          
          {/* Main option contract metadata visualizer */}
          <div className="grid grid-cols-2 gap-3 bg-card/50 border border-0 p-3 rounded-lg text-xs">
            <div>
              <span className="text-muted-foreground block mb-1">Underlying</span>
              <span className="text-foreground/80 font-medium">{ticket.underlying}</span>
            </div>
            <div className="bg-primary/10 border border-primary/25 p-2 rounded-2xl flex flex-col justify-between">
              <span className="text-primary font-bold text-[10px] uppercase tracking-wider block mb-1">⚠️ Expiry Date</span>
              <select
                value={ticket.expiry}
                onChange={(e) => onExpiryChange(e.target.value)}
                className="w-full bg-muted border border-primary rounded-full px-4 py-1.5 text-xs text-primary font-bold focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer"
              >
                {expiries.map((exp) => (
                  <option key={exp} value={exp} className="bg-card text-foreground">
                    {exp}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="text-muted-foreground block">Strike / Option</span>
              <span className="text-foreground/80 font-medium">{ticket.strike} {ticket.optionType}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">LTP</span>
              <span className={`font-bold font-mono transition-all duration-300 inline-block px-1.5 py-0.5 rounded ${
                priceDirection === 'UP'
                  ? 'text-emerald-800 bg-emerald-100 border border-emerald-200'
                  : priceDirection === 'DOWN'
                  ? 'text-rose-800 bg-rose-100 border border-rose-200'
                  : 'text-primary'
              }`}>
                ₹{liveLtp.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Option Contract Diagnostics Box */}
          <div className="bg-background/45 border border-0/60 rounded-lg p-2.5 text-[11px] font-sans">
            <button 
              type="button"
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className="w-full flex justify-between items-center text-primary/90 font-semibold pb-1 border-b border-0/40 hover:text-primary transition-colors"
            >
              <span>📋 Instrument Master Diagnostics</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-mono">
                  {ticket.exchange || 'NFO'}
                </span>
                <span className="text-[9px] text-primary/75 hover:text-primary font-sans ml-1">
                  ({showDiagnostics ? 'hide' : 'show'})
                </span>
              </div>
            </button>
            
            {showDiagnostics && (
              <div className="space-y-1 text-muted-foreground font-sans leading-normal mt-1.5 animate-in fade-in slide-in-from-top-1">
                <div className="flex justify-between">
                  <span>Trading Symbol:</span>
                  <span className="text-foreground/90 font-mono font-medium">{ticket.tradingsymbol || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span>Instrument Token:</span>
                  <span className="text-foreground/90 font-mono">{ticket.instrument_token || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span>Segment:</span>
                  <span className="text-foreground/90">{ticket.segment || 'NFO-OPT'}</span>
                </div>
                <div className="flex justify-between">
                  <span>Expiry Date:</span>
                  <span className="text-foreground/90 font-mono">{ticket.expiry}</span>
                </div>
                <div className="flex justify-between">
                  <span>Strike Price:</span>
                  <span className="text-foreground/90 font-mono">{ticket.strike}</span>
                </div>
                <div className="flex justify-between">
                  <span>Option Type:</span>
                  <span className={`font-mono font-bold ${ticket.optionType === 'CE' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {ticket.optionType}
                  </span>
                </div>
                <div className="flex justify-between border-t border-0/40 pt-1.5 mt-1 pb-0.5">
                  <span className="font-semibold text-foreground/80">Lot Size from Kite Master:</span>
                  <span className="font-mono text-primary font-bold">
                    {lotSize != null ? lotSize : (
                      <span className="text-rose-400 animate-pulse font-sans font-medium text-[10px]">
                        Unavailable
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Source:</span>
                  <span className="text-[10px] text-primary/70 italic font-medium">
                    {ticket.source_of_lot_size || 'Kite Live Instrument Master'}
                  </span>
                </div>

                <div className="text-[10px] font-semibold text-primary/80 mb-1 border-b border-0/40 pb-0.5 mt-2 pt-1 uppercase tracking-widest">
                   Auto Lot Diagnostics
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Lot Sizing Mode:</span>
                  <span className={`font-mono font-medium ${lotSizingMode === 'AUTO MAX' ? 'text-primary' : 'text-foreground/80'}`}>{lotSizingMode}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cost Per Lot:</span>
                  <span className="font-mono text-primary font-semibold">{costPerLot > 0 ? `₹${costPerLot.toFixed(2)}` : 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Max Affordable Lots:</span>
                  <span className="font-mono text-primary font-semibold">{maxAffordableLots > 0 ? maxAffordableLots : '0'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Selected Lots:</span>
                  <span className="font-mono text-primary/90">{lots}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Auto Lot Calculation Source:</span>
                  <span className="font-mono text-[9px] text-primary/70">{calculationSource}</span>
                </div>
              </div>
            )}
          </div>

          {/* Missing Lot Size Alert Box */}
          {!lotSize && (
            <div className="bg-rose-950/30 border border-rose-500/35 p-3 rounded-lg text-xs flex flex-col gap-1.5 mt-2 animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="flex items-center gap-1.5 text-rose-450 text-rose-400 font-semibold">
                <span>⚠️ Lot size unavailable. Refresh instruments.</span>
              </div>
              <div className="text-muted-foreground text-[11px] leading-relaxed">
                NIFTY options require a dynamic lot size from the latest instrument master. Click below to refresh the cached database.
              </div>
              <button
                type="button"
                onClick={handleRefreshInstruments}
                className={`text-[10px] uppercase font-bold self-start mt-1 cursor-pointer underline transition-all ${refreshing ? 'text-muted-foreground' : 'text-primary hover:text-primary/80'}`}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing Master Cache...' : 'Click to Refetch & Rebuild Master'}
              </button>
            </div>
          )}

          {/* Product Type (MIS vs NRML) */}
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">Product</label>
            <div className="grid grid-cols-2 gap-2 bg-card/40 p-1 rounded-lg border border-0">
              <button
                type="button"
                onClick={() => setProduct('MIS')}
                className={`py-1.5 text-xs font-semibold rounded-md transition-all ${product === 'MIS' ? 'bg-muted text-primary border border-primary/30' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Intraday (MIS)
              </button>
              <button
                type="button"
                onClick={() => setProduct('NRML')}
                className={`py-1.5 text-xs font-semibold rounded-md transition-all ${product === 'NRML' ? 'bg-muted text-primary border border-primary/30' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Overnight (NRML)
              </button>
            </div>
          </div>

          {/* Dynamic input blocks based on selection */}
          <div className="flex flex-col gap-4">
             {/* Lot Sizing */}
             <div className="bg-card/60 p-2.5 rounded-lg border border-0">
                <div className="flex justify-between items-center mb-2">
                   <label className="text-xs font-semibold text-foreground/80">Lot Sizing</label>
                   <div className="flex gap-1 bg-background p-0.5 rounded border border-0 text-[10px]">
                      <button type="button" onClick={() => setLotSizingMode('AUTO MAX')} className={`px-2 py-0.5 rounded font-bold transition-colors ${lotSizingMode === 'AUTO MAX' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground/80'}`}>AUTO MAX</button>
                      <button type="button" onClick={() => setLotSizingMode('MANUAL')} className={`px-2 py-0.5 rounded font-bold transition-colors ${lotSizingMode === 'MANUAL' ? 'bg-muted text-foreground/90' : 'text-muted-foreground hover:text-foreground/80'}`}>MANUAL</button>
                   </div>
                </div>

                {lotSizingMode === 'AUTO MAX' && !isKite && !marginPreview.loading && (
                   <div className="mb-2 text-[10px] text-rose-400 font-semibold bg-rose-950/30 py-1 px-2 rounded border border-rose-900/50">
                     Auto lot sizing unavailable (Kite API failed)
                   </div>
                )}
                
                <div className="flex items-center gap-3">
                   <div className="flex items-center">
                     <button type="button" onClick={() => { setLotSizingMode('MANUAL'); adjustLots(-1); }} className="bg-slate-850 hover:bg-slate-755 text-foreground/80 border border-0 w-8 h-9 rounded-l focus:outline-none flex items-center justify-center font-bold" disabled={lotSizingMode === 'AUTO MAX' && isKite}>-</button>
                     <input type="number" value={lots || ''} onChange={(e) => { setLotSizingMode('MANUAL'); handleLotsChange(e.target.value); }} disabled={lotSizingMode === 'AUTO MAX' && isKite} className={`w-14 text-center bg-card/40 border-y  font-mono text-sm h-9 focus:outline-none focus:border-primary ${lotSizingMode === 'AUTO MAX' && isKite ? 'text-primary cursor-not-allowed' : 'text-foreground'}`} />
                     <button type="button" onClick={() => { setLotSizingMode('MANUAL'); adjustLots(1); }} className="bg-slate-850 hover:bg-slate-755 text-foreground/80 border border-0 w-8 h-9 rounded-r focus:outline-none flex items-center justify-center font-bold" disabled={lotSizingMode === 'AUTO MAX' && isKite}>+</button>
                   </div>
                   
                   <div className="flex flex-1 justify-end gap-1.5 h-9">
                      <button type="button" onClick={() => { setLotSizingMode('MANUAL'); setLots(1); }} className={`px-2 rounded border text-[10px] uppercase font-bold tracking-wider transition-colors hover:bg-slate-700 hover:text-primary ${lotSizingMode === 'MANUAL' && lots === 1 ? 'bg-primary/20 border-primary/25 text-primary' : 'bg-muted/80 border-0/60 text-muted-foreground'}`}>1 Lot</button>
                      <button type="button" onClick={() => { setLotSizingMode('MANUAL'); setLots(Math.max(1, Math.floor(maxAffordableLots / 2))); }} className={`px-2 rounded border text-[10px] uppercase font-bold tracking-wider transition-colors hover:bg-slate-700 hover:text-primary ${lotSizingMode === 'MANUAL' && lots === Math.max(1, Math.floor(maxAffordableLots / 2)) && maxAffordableLots > 2 ? 'bg-primary/20 border-primary/25 text-primary' : 'bg-muted/80 border-0/60 text-muted-foreground'}`} disabled={maxAffordableLots <= 0}>Half</button>
                      <button type="button" onClick={() => { setLotSizingMode('AUTO MAX'); }} className={`px-2 rounded border text-[10px] uppercase font-bold tracking-wider transition-colors hover:bg-slate-700 hover:text-primary ${lotSizingMode === 'AUTO MAX' ? 'bg-primary/20 border-primary/25 text-primary' : 'bg-muted/80 border-0/60 text-muted-foreground'}`}>Max</button>
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-2.5 pt-2 border-t border-0/60 text-[10px]">
                   <div className="flex justify-between">
                     <span className="text-muted-foreground">Total Qty:</span>
                     <span className="font-mono text-foreground/80">{quantity} <span className="text-slate-600 text-[9px]">(x{lotSize})</span></span>
                   </div>
                   <div className="flex justify-between items-center">
                     <span className="text-muted-foreground">Cost/Lot:</span>
                     <span className="font-mono text-emerald-400/90 flex items-center gap-1">
                        {costPerLot > 0 ? `₹${costPerLot.toFixed(1)}` : '...' }
                        {!isKite && costPerLot > 0 && <span className="text-primary/80 text-[8px]" title="Estimated">*Est</span>}
                     </span>
                   </div>
                   <div className="flex justify-between items-center">
                     <span className="text-muted-foreground">Max Afford:</span>
                     <span className="font-mono text-primary flex items-center gap-1">
                        {maxAffordableLots > 0 ? maxAffordableLots : 0} lots
                        {!isKite && maxAffordableLots > 0 && <span className="text-primary/80 text-[8px]" title="Estimated">*Est</span>}
                     </span>
                   </div>
                   <div className="flex justify-between">
                     <span className="text-muted-foreground">Avail margin:</span>
                     <span className="font-mono text-emerald-400/90">₹{availBalance.toFixed(0)}</span>
                   </div>
                </div>
             </div>
             
             {/* Auto LIMIT price — live premium ±0.5%, updates live, no manual typing */}
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Price <span className="text-[9px] text-primary/80 font-semibold">(auto · live {ticket.action === 'BUY' ? '+' : '−'}0.5%)</span>
              </label>
              <input
                type="number"
                step="0.05"
                readOnly
                value={limitPrice}
                className="w-full bg-card/60 border border-0 rounded-md text-center text-xs h-9 focus:outline-none font-mono text-foreground"
              />
              <span className="text-[10px] text-muted-foreground block mt-1">Tick size ₹0.05 · tracks live premium</span>
            </div>
          </div>

          {/* Required vs Available details */}
          <div className="bg-card border border-0/60 p-3 rounded-lg text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-muted-foreground font-medium tracking-wide font-sans">Required Margin:</span>
                <span className="text-foreground font-bold font-mono text-[13px]">
                  ₹{Math.round(reqAmount).toLocaleString('en-IN')}
                </span>
                <button
                  type="button"
                  onClick={() => setShowChargesBreakdown(!showChargesBreakdown)}
                  className="text-muted-foreground font-mono text-xs hover:text-primary focus:outline-none transition-colors inline-flex items-center gap-0.5 cursor-pointer"
                  title="Click to view Zerodha charges breakdown"
                >
                  + ₹{charges.toFixed(2)}
                  <span className={`text-[9px] px-1 py-0.5 rounded ml-1 font-bold font-sans uppercase ${isKite ? 'bg-emerald-500/20 text-emerald-400' : 'bg-primary/20 text-primary'}`}>
                    {isKite ? 'Kite API' : 'Local Calculation'}
                  </span>
                  <span className="text-[9px] text-primary/70 hover:underline font-sans font-normal ml-1">
                    ({showChargesBreakdown ? 'hide' : 'details'})
                  </span>
                </button>
              </div>
              
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-muted-foreground font-medium font-sans">Available Margin:</span>
                {isEditingBalance ? (
                  <div className="flex items-center gap-1.5 bg-background border border-primary/45 rounded px-2 py-0.5 animate-in zoom-in-95 duration-100">
                    <span className="text-muted-foreground text-xs font-mono">₹</span>
                    <input
                      type="number"
                      autoFocus
                      value={balanceInput}
                      onChange={(e) => setBalanceInput(e.target.value)}
                      onBlur={() => {
                        const val = parseFloat(balanceInput);
                        if (!isNaN(val) && val >= 0) {
                          setAvailBalance(val);
                          try {
                            localStorage.setItem('kite_sim_balance', val.toFixed(2));
                          } catch (err) {}
                          toast.success(`Simulated balance updated to ₹${val.toLocaleString('en-IN')}`);
                        }
                        setIsEditingBalance(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const val = parseFloat(balanceInput);
                          if (!isNaN(val) && val >= 0) {
                            setAvailBalance(val);
                            try {
                              localStorage.setItem('kite_sim_balance', val.toFixed(2));
                            } catch (err) {}
                            toast.success(`Simulated balance updated to ₹${val.toLocaleString('en-IN')}`);
                          }
                          setIsEditingBalance(false);
                        } else if (e.key === 'Escape') {
                          setIsEditingBalance(false);
                        }
                      }}
                      className="w-24 bg-transparent border-0 text-foreground text-xs p-0 font-mono focus:outline-none"
                    />
                  </div>
                ) : (
                  <span className={`font-mono font-bold px-2 py-0.5 rounded flex items-center transition-all ${
                    (reqAmount + charges) > availBalance 
                      ? 'text-rose-455 text-rose-400 bg-rose-950/25 border border-rose-500/30' 
                      : 'bg-primary text-primary-foreground border border-primary/20'
                  }`}>
                    <span 
                      onClick={() => setIsEditingBalance(true)}
                      className="cursor-pointer hover:underline flex items-center gap-1"
                      title="Click to edit simulated balance"
                    >
                      ₹{availBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      <Edit2 size={10} className="opacity-70" />
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onRefreshBalance();
                        toast.success("Refreshing Kite account balance...");
                      }}
                      className={`text-[10px] ml-2 cursor-pointer font-sans font-normal transition-all ${
                        (reqAmount + charges) > availBalance 
                          ? 'text-primary hover:text-primary/80' 
                          : 'text-primary-foreground/90 hover:text-primary-foreground'
                      }`}
                      title="Refresh Balance"
                    >
                      <Loader2 className={`w-3.5 h-3.5 ${processing ? 'animate-spin' : ''}`} />
                    </button>
                  </span>
                )}
              </div>
            </div>

            {showChargesBreakdown && (
              <div className="mt-3 pt-2.5 border-t border-0/80 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground font-sans leading-relaxed animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="text-muted-foreground font-medium col-span-2 text-[11px] text-primary flex justify-between items-center pb-1 border-b border-0/40 mb-1">
                  <span className="font-semibold flex items-center gap-2">
                    Charges Breakdown
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase ${isKite ? 'bg-emerald-500/20 text-emerald-400' : isLocalFallback ? 'bg-primary/20 text-primary' : 'bg-rose-500/20 text-rose-400'}`}>
                      {isKite ? 'Kite Margin API' : isLocalFallback ? 'Local Estimate' : 'Margin Unavailable'}
                    </span>
                  </span>
                  <span className="text-[10px] text-muted-foreground italic">NSE F&O Options</span>
                </div>
                
                {isLocalFallback && (
                  <div className="col-span-2 text-primary/90 text-[10px] leading-relaxed bg-primary/10 border border-primary/20 px-2 py-1.5 rounded-md mb-1.5">
                    <strong>⚠️ Fallback Active:</strong> Charges are estimated and may differ from Zerodha.
                  </div>
                )}
                
                {marginPreview.loading ? (
                  <div className="col-span-2 text-center text-muted-foreground py-3 flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    Fetching live charges from Kite...
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between border-b border-0/20 pb-1">
                      <span>Brokerage:</span>
                      <span className="font-mono text-foreground/80">₹{(isKite ? marginPreview.data!.charges.brokerage : estimatedChargesDetails.brokerage).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-0/20 pb-1">
                      <span>Exchange Turnover Fee:</span>
                      <span className="font-mono text-foreground/80">₹{(isKite ? marginPreview.data!.charges.exchange_turnover_charge : estimatedChargesDetails.txnCharge).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-0/20 pb-1">
                      <span>GST:</span>
                      <span className="font-mono text-foreground/80">₹{(isKite ? marginPreview.data!.charges.gst.total : estimatedChargesDetails.gst).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-0/20 pb-1">
                      <span>Stamp Duty:</span>
                      <span className="font-mono text-foreground/80">₹{(isKite ? marginPreview.data!.charges.stamp_duty : estimatedChargesDetails.stamp).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-0/20 pb-1">
                      <span>STT:</span>
                      <span className="font-mono text-foreground/80">₹{(isKite ? marginPreview.data!.charges.transaction_tax : estimatedChargesDetails.stt).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-0/20 pb-1">
                      <span>SEBI Charges:</span>
                      <span className="font-mono text-foreground/80">₹{(isKite ? marginPreview.data!.charges.sebi_turnover_charge : estimatedChargesDetails.sebi).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b-2 border-0/60 pb-1 font-bold pt-1">
                      <span className="text-primary">Total Charges:</span>
                      <span className="font-mono text-primary">₹{(isKite ? marginPreview.data!.charges.total : estimatedChargesDetails.total).toFixed(2)}</span>
                    </div>
                    <div className="col-span-2 text-[10px] text-muted-foreground leading-normal italic mt-0.5 pt-0.5">
                      {isKite 
                        ? "* Sourced from Zerodha Kite Margin API." 
                        : `* Local estimate calculated dynamically. ${marginPreview.error ? 'Kite Error: ' + marginPreview.error : ''}`}
                    </div>
                  </>
                )}
              </div>
            )}

            {(reqAmount + charges) > availBalance && (
              <div className="mt-2.5 pt-3 border-t border-rose-500/20 flex flex-col gap-2 text-[11px]">
                <div className="flex items-center gap-1.5 text-rose-400 font-semibold">
                  <span>⚠️ Insufficient Funds for this transaction</span>
                </div>
                <div className="text-muted-foreground font-medium flex items-center justify-between">
                  <span>Shortfall: <span className="font-mono text-rose-350 font-bold">₹{((reqAmount + charges) - availBalance).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
                  <button
                    type="button"
                    onClick={() => {
                      const required = Math.ceil(reqAmount + charges + 50000);
                      setAvailBalance(required);
                      try {
                        localStorage.setItem('kite_sim_balance', required.toFixed(2));
                      } catch (err) {}
                      toast.success(`Simulated balance increased to ₹${required.toLocaleString('en-IN')} (Required + ₹50K buffer!)`);
                    }}
                    className="bg-emerald-950/45 text-emerald-400 border border-emerald-800/40 px-2 py-0.5 rounded hover:bg-emerald-900/50 transition-all font-bold cursor-pointer font-sans"
                  >
                    Fix Balance
                  </button>
                </div>
                <div className="text-[10px] text-muted-foreground leading-relaxed italic">
                  Tip: Click "Fix Balance" above or click on the Available Margin amount to edit it directly.
                </div>
              </div>
            )}
          </div>

          {/* Warning banner when instrument context is incomplete */}
          {missingContext && (
            <div className="bg-amber-950/25 border border-primary/80 text-primary p-2.5 rounded-lg text-[10px] leading-relaxed">
              <strong>Warning:</strong> Trading symbol or instrument token is missing. Real-time index feed is fallback or simulated. Order placement is restricted to simulated confirmation.
            </div>
          )}

          {/* Actions panel */}
          <div className="pt-3 border-t border-0 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-1.5 text-xs font-semibold rounded bg-muted hover:bg-slate-755 text-foreground/80 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={processing || lots <= 0 || (reqAmount + charges) > availBalance}
              className="flex-1 py-1.5 text-xs font-bold rounded bg-primary hover:bg-opacity-90 disabled:bg-primary/20 text-primary-foreground disabled:text-primary/40 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {processing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isBuy ? 'Confirm BUY' : 'Confirm SELL'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TVStylePicker({
  color,
  opacity,
  thickness,
  lineStyle,
  onColorChange,
  onOpacityChange,
  onThicknessChange,
  onLineStyleChange,
}: {
  color: string;
  opacity?: number;
  thickness?: number;
  lineStyle?: number;
  onColorChange: (c: string) => void;
  onOpacityChange?: (o: number) => void;
  onThicknessChange?: (t: number) => void;
  onLineStyleChange?: (s: number) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const PREDEFINED_COLORS = [
    '#ffffff', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#0f172a',
    '#ef4444', '#f97316', '#fcd34d', '#4ade80', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6',
    '#fca5a5', '#fdba74', '#fef08a', '#86efac', '#6ee7b7', '#67e8f9', '#93c5fd', '#c4b5fd',
    '#f87171', '#fb923c', '#fde047', '#4ade80', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa',
    '#dc2626', '#ea580c', '#eab308', '#22c55e', '#059669', '#0891b2', '#2563eb', '#7c3aed',
    '#991b1b', '#9a3412', '#a16207', '#166534', '#065f46', '#164e63', '#1e3a8a', '#5b21b6',
    '#7f1d1d', '#7c2d12', '#713f12', '#14532d', '#064e3b', '#083344', '#172554', '#4c1d95',
  ];

  return (
    <div className="relative inline-block" ref={containerRef}>
      {/* Trigger Button */}
      <button 
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setIsOpen(!isOpen); }}
        className="flex items-center justify-center border border-0 rounded p-1.5 cursor-pointer bg-transparent hover:bg-accent hover:text-accent-foreground transition-colors h-8 w-14"
      >
        <div className="w-5 h-5 rounded-sm " style={{ backgroundColor: color }} />
      </button>

      {/* Popover */}
      {isOpen && (
        <>
          {/* Invisible overlay for click-outside */}
          <div 
            className="fixed inset-0 z-[999]" 
            onClick={() => setIsOpen(false)}
          />
          <div 
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[240px] bg-popover border border-0 rounded-lg z-[1000] p-4 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-100"
            onClick={e => e.stopPropagation()}
          >
          {/* Top line preview (like screenshot) */}
          <div className="flex items-center gap-3 border border-0 bg-muted rounded p-2">
            <div className="w-6 h-6 rounded " style={{ backgroundColor: color }} />
            {thickness !== undefined && lineStyle !== undefined && (
              <div className="flex-1 flex items-center">
                <div 
                  className="w-full" 
                  style={{ 
                    borderTopWidth: `${thickness}px`, 
                    borderColor: color,
                    borderTopStyle: lineStyle === 0 ? 'solid' : lineStyle === 1 ? 'dashed' : 'dotted'
                  }} 
                />
              </div>
            )}
          </div>

          {/* Color Grid */}
          <div className="grid grid-cols-8 gap-y-1 gap-x-1">
            {PREDEFINED_COLORS.map((c, i) => (
              <div 
                key={c + i}
                onClick={() => {
                  onColorChange(c);
                  setIsOpen(false);
                }}
                className={`w-5 h-5 rounded-sm cursor-pointer border hover:scale-110 transition-transform ${color.toLowerCase() === c.toLowerCase() ? 'border-white' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="w-full h-px bg-white/10 my-1" />

          {/* Custom + Button (Placeholder like screenshot) */}
          <div>
            <button className="text-foreground/70 hover:text-foreground transition-colors flex items-center justify-center p-1 border border-transparent hover:border-0 rounded">
              <Plus className="w-5 h-5" />
            </button>
          </div>

          {/* Opacity */}
          {onOpacityChange && opacity !== undefined && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted-foreground font-medium">Opacity</div>
              <div className="flex items-center gap-3">
                <input 
                  type="range" 
                  min="0" 
                  max="100" 
                  value={opacity}
                  onChange={(e) => onOpacityChange(Number(e.target.value))}
                  className="flex-1 h-1.5 bg-gradient-to-r from-transparent to-[var(--slider-color)] rounded-full appearance-none cursor-pointer outline-none slider-thumb-ring"
                  style={{ '--slider-color': color } as any}
                />
                <div className="text-xs text-foreground/80 w-8 border border-0 bg-muted rounded px-1 py-0.5 text-center">{opacity}%</div>
              </div>
            </div>
          )}

          {/* Thickness */}
          {onThicknessChange && thickness !== undefined && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted-foreground font-medium">Thickness</div>
              <div className="flex border border-0 rounded overflow-hidden h-8">
                {[1, 2, 3].map((lw) => (
                  <button 
                    key={`lw-${lw}`}
                    onClick={() => onThicknessChange(lw)}
                    className={`flex-[1] flex items-center justify-center border-r border-0 last:border-r-0 hover:bg-white/10 transition-colors ${thickness === lw ? 'bg-muted/50' : 'bg-transparent'}`}
                  >
                    <div className="w-5" style={{ height: `${lw}px`, backgroundColor: '#fff' }} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Line style */}
          {onLineStyleChange && lineStyle !== undefined && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted-foreground font-medium">Line style</div>
              <div className="flex border border-0 rounded overflow-hidden h-8">
                {[
                  { val: 0, style: 'solid' },
                  { val: 1, style: 'dashed' },
                  { val: 2, style: 'dotted' }
                ].map((ls) => (
                  <button 
                    key={`ls-${ls.val}`}
                    onClick={() => onLineStyleChange(ls.val)}
                    className={`flex-[1] flex items-center justify-center border-r border-0 last:border-r-0 hover:bg-white/10 transition-colors ${lineStyle === ls.val ? 'bg-muted/50' : 'bg-transparent'}`}
                  >
                    <div className="w-5 border-t-[1.5px]" style={{ borderColor: '#fff', borderTopStyle: ls.style as any }} />
                  </button>
                ))}
              </div>
            </div>
          )}

        </div>
        </>
      )}
    </div>
  );
}

function LineEditorModal({ 
  onClose, 
  lineId, 
  initialPrice,
  initialColor,
  initialLineWidth,
  initialLineStyle,
  initialLabelVisible,
  initialTitle,
  onApply,
  onDelete,
  onChange
}: { 
  onClose: () => void, 
  lineId: number, 
  initialPrice: number,
  initialColor: string,
  initialLineWidth: number,
  initialLineStyle: number,
  initialLabelVisible: boolean,
  initialTitle?: string,
  onApply: (price: number, color: string, lineWidth: number, lineStyle: number, labelVisible: boolean, title: string) => void,
  onDelete: () => void,
  onChange?: (price: number, color: string, lineWidth: number, lineStyle: number, labelVisible: boolean, title: string) => void
}) {
  const [tab, setTab] = useState<'style' | 'coordinates'>('style');
  const [price, setPrice] = useState(Math.round(initialPrice));
  const [color, setColor] = useState(initialColor);
  const [lineWidth, setLineWidth] = useState(initialLineWidth);
  const [lineStyle, setLineStyle] = useState(initialLineStyle);
  const [labelVisible, setLabelVisible] = useState(initialLabelVisible);
  const [title, setTitle] = useState(initialTitle || '');

  const isFirstRender = useRef(true);
  
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (onChange) {
      onChange(price, color, lineWidth, lineStyle, labelVisible, title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, color, lineWidth, lineStyle, labelVisible, title]);

  const predefinedColors = [
    '#ffffff', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827',
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
    '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
    '#f87171', '#fb923c', '#fbbf24', '#fde047', '#a3e635', '#4ade80', '#34d399', '#2dd4bf',
    '#22d3ee', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6',
    '#7f1d1d', '#7c2d12', '#78350f', '#713f12', '#3f6212', '#14532d', '#064e3b', '#134e4a',
    '#164e63', '#0c4a6e', '#1e3a8a', '#312e81', '#4c1d95', '#581c87', '#701a75', '#831843',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card border border-0 rounded-lg w-full max-w-[400px] overflow-visible flex flex-col animate-in zoom-in-95 duration-200 relative">
        <div className="flex items-center justify-between p-4 border-b border-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-foreground">Horizontal line</h2>
            <div className="w-3 h-3 text-muted-foreground ml-1">
               <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="flex px-4 border-b border-0 mt-2 gap-4">
          <button 
            onClick={() => setTab('style')}
            className={`pb-2 text-sm font-medium transition-colors ${tab === 'style' ? 'text-foreground border-b-2 border-white' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Style
          </button>
          <button 
            onClick={() => setTab('coordinates')}
            className={`pb-2 text-sm font-medium transition-colors ${tab === 'coordinates' ? 'text-foreground border-b-2 border-white' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Coordinates
          </button>
        </div>

        <div className="p-4" style={{ minHeight: '160px' }}>
          {tab === 'style' && (
            <div className="space-y-4">
              <div className="flex items-center gap-4 relative">
                <span className="text-sm text-muted-foreground min-w-[50px]">Line</span>
                
                <TVStylePicker 
                  color={color}
                  thickness={lineWidth}
                  lineStyle={lineStyle}
                  onColorChange={setColor}
                  onThicknessChange={setLineWidth}
                  onLineStyleChange={setLineStyle}
                />
              </div>

              <div className="flex items-center gap-4 relative">
                <span className="text-sm text-muted-foreground min-w-[50px]">Text</span>
                <input 
                  type="text" 
                  value={title} 
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. TARGET, TRAP, resistance level text"
                  className="bg-background border border-0 text-sm rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary h-9 flex-1"
                />
              </div>
              
              <label className="flex items-center gap-2 mt-4 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={labelVisible} 
                  onChange={e => setLabelVisible(e.target.checked)}
                  className="rounded border-0 bg-muted/40 dark:bg-black/20 text-blue-500 focus:ring-0"
                />
                <span className="text-sm text-full text-foreground hover:text-foreground">Price label</span>
              </label>
            </div>
          )}
          {tab === 'coordinates' && (
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground min-w-[80px]">#1 (price)</span>
              <input 
                type="number" 
                value={price}
                onChange={e => setPrice(parseInt(e.target.value) || 0)}
                className="bg-muted/50 text-sm text-foreground px-3 py-1.5 rounded border border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500 w-[120px]"
                step="1"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-0 bg-muted">
           <div>
              {/* Left section */}
              <button onClick={onDelete} className="text-sm text-red-500 hover:text-red-400 transition-colors">Delete</button>
           </div>
           <div className="flex gap-2">
             <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-0 hover:bg-accent hover:text-accent-foreground rounded text-foreground transition-colors">Cancel</button>
             <button onClick={() => onApply(price, color, lineWidth, lineStyle, labelVisible, title)} className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium">Ok</button>
           </div>
        </div>
      </div>
    </div>
  );
}

const hexToRgba = (hex: string, alpha: number) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const formatCountdown = (totalSeconds: number) => {
  if (totalSeconds < 0) return "00:00";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  
  const pad = (num: number) => String(num).padStart(2, '0');
  
  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
};

const IST_OFFSET_SECONDS = 5.5 * 60 * 60;
const MARKET_OPEN_SECONDS_IST = (9 * 60 + 15) * 60;
const MARKET_CLOSE_SECONDS_IST = (15 * 60 + 30) * 60;

const getIstDateTime = (unixSeconds: number) => {
  const msInIst = (unixSeconds + IST_OFFSET_SECONDS) * 1000;
  const d = new Date(msInIst);
  return {
    dayOfWeek: d.getUTCDay(),       // 0 = Sun, 1 = Mon, ..., 6 = Sat
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    timeOfDaySec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
  };
};

const isMarketOpen = (unixSeconds: number): boolean => {
  return true;
};

const toUnixSeconds = (value: any): number => {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  return Math.floor(new Date(value).getTime() / 1000);
};

const getMarketAlignedCandleStart = (unixSeconds: number, timeframeMinutes: number) => {
  const duration = timeframeMinutes * 60;
  if (!duration || duration >= 24 * 60 * 60) return unixSeconds;

  const istSeconds = unixSeconds + IST_OFFSET_SECONDS;
  const istMidnight = Math.floor(istSeconds / 86400) * 86400;
  const sessionStart = istMidnight + MARKET_OPEN_SECONDS_IST;
  const elapsedFromOpen = Math.max(0, istSeconds - sessionStart);
  const bucketStartIst = sessionStart + Math.floor(elapsedFromOpen / duration) * duration;

  // Prevent candle start from exceeding the last valid candle start of the daily session (ends at 15:30 IST)
  const sessionEndIst = istMidnight + MARKET_CLOSE_SECONDS_IST;
  const maxCandleStartIst = sessionEndIst - duration;
  const cappedBucketStartIst = Math.min(bucketStartIst, maxCandleStartIst);

  return Math.floor(cappedBucketStartIst - IST_OFFSET_SECONDS);
};

const getNextMarketAlignedClose = (unixSeconds: number, timeframeMinutes: number) => {
  return getMarketAlignedCandleStart(unixSeconds, timeframeMinutes) + timeframeMinutes * 60;
};

// Client-side RSI (Wilder's smoothing / RMA) — mirrors the server's calculateRSI exactly,
// so the live forming-candle RSI matches the server-computed values (and Zerodha's method).
const computeRsiArray = (closes: number[], period: number = 14): number[] => {
  const rsiArray = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsiArray;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  if (loss === 0) rsiArray[period] = 100;
  else if (gain === 0) rsiArray[period] = 0;
  else rsiArray[period] = 100 - (100 / (1 + (gain / loss)));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const currentGain = d > 0 ? d : 0;
    const currentLoss = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + currentGain) / period;
    loss = (loss * (period - 1) + currentLoss) / period;
    if (loss === 0) rsiArray[i] = 100;
    else if (gain === 0) rsiArray[i] = 0;
    else rsiArray[i] = 100 - (100 / (1 + (gain / loss)));
  }
  return rsiArray;
};


function BBEditorModal({
  onClose,
  initialPeriod,
  initialStdDev,
  initialColor,
  onApply
}: {
  onClose: () => void,
  initialPeriod: number,
  initialStdDev: number,
  initialColor: string,
  onApply: (period: number, stdDev: number, color: string) => void
}) {
  const [period, setPeriod] = useState(initialPeriod);
  const [stdDev, setStdDev] = useState(initialStdDev);
  const [color, setColor] = useState(initialColor);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-transparent p-4 animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-card border border-0 rounded-lg w-full max-w-[320px] overflow-visible flex flex-col pt-1 relative"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-foreground">Bollinger Bands Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-foreground/80">Period length:</span>
            <input
              type="number"
              value={period}
              min={2}
              max={100}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 2 && val <= 100) setPeriod(val);
              }}
              className="w-16 bg-background border border-0 rounded px-2.5 py-1 text-foreground text-right focus:outline-none focus:border-cyan-500 text-sm"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-foreground/80">Std Dev:</span>
            <input
              type="number"
              step="0.1"
              value={stdDev}
              min={0.1}
              max={10}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 0.1 && val <= 10) setStdDev(val);
              }}
              className="w-16 bg-background border border-0 rounded px-2.5 py-1 text-foreground text-right focus:outline-none focus:border-cyan-500 text-sm"
            />
          </div>

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-foreground/80">Bands Color</div>
             <TVStylePicker 
               color={color}
               onColorChange={setColor}
             />
          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-0 bg-muted gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-0 hover:bg-accent hover:text-accent-foreground rounded text-foreground transition-colors">Cancel</button>
          <button onClick={() => onApply(period, stdDev, color)} className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium">Ok</button>
        </div>
      </div>
    </div>
  );
}

function OiBarsEditorModal({
  onClose,
  initialMaxBarWidth,
  initialGap,
  initialBarThickness,
  initialCallColor,
  initialPutColor,
  onApply,
  onChange
}: {
  onClose: () => void,
  initialMaxBarWidth: number,
  initialGap: number,
  initialBarThickness: number,
  initialCallColor: string,
  initialPutColor: string,
  onApply: (maxBarWidth: number, gap: number, barThickness: number, callColor: string, putColor: string) => void,
  onChange?: (maxBarWidth: number, gap: number, barThickness: number, callColor: string, putColor: string) => void
}) {
  const [maxBarWidth, setMaxBarWidth] = useState(initialMaxBarWidth);
  const [gap, setGap] = useState(initialGap);
  const [barThickness, setBarThickness] = useState(initialBarThickness);
  const [callColor, setCallColor] = useState(initialCallColor);
  const [putColor, setPutColor] = useState(initialPutColor);

  useEffect(() => {
    if (onChange) {
      onChange(maxBarWidth, gap, barThickness, callColor, putColor);
    }
  }, [maxBarWidth, gap, barThickness, callColor, putColor, onChange]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent p-4 animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-card border border-0 rounded-lg w-full max-w-[320px] overflow-visible flex flex-col pt-1 relative"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-foreground">OI Bars Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-6">
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Gap from Strike Price Line</span>
              <span className="font-mono text-foreground">{gap}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={300}
              step={5}
              value={gap}
              onChange={(e) => setGap(parseInt(e.target.value))}
              className="w-full h-1.5 bg-gradient-to-r from-transparent to-cyan-500 rounded-full appearance-none cursor-pointer outline-none slider-thumb-ring"
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Max Bar Length</span>
              <span className="font-mono text-foreground">{maxBarWidth}px</span>
            </div>
            <input
              type="range"
              min={50}
              max={500}
              step={10}
              value={maxBarWidth}
              onChange={(e) => setMaxBarWidth(parseInt(e.target.value))}
              className="w-full h-1.5 bg-gradient-to-r from-transparent to-cyan-500 rounded-full appearance-none cursor-pointer outline-none slider-thumb-ring"
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Max Bar Width</span>
              <span className="font-mono text-foreground">{barThickness}px</span>
            </div>
            <input
              type="range"
              min={2}
              max={24}
              step={2}
              value={barThickness}
              onChange={(e) => setBarThickness(parseInt(e.target.value))}
              className="w-full h-1.5 bg-gradient-to-r from-transparent to-cyan-500 rounded-full appearance-none cursor-pointer outline-none slider-thumb-ring"
            />
          </div>

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-foreground/80">Call OI Color (CE)</div>
             <TVStylePicker 
               color={callColor}
               onColorChange={setCallColor}
             />
          </div>

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-foreground/80">Put OI Color (PE)</div>
             <TVStylePicker 
               color={putColor}
               onColorChange={setPutColor}
             />
          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-0 bg-muted gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-0 hover:bg-accent hover:text-accent-foreground rounded text-foreground transition-colors">Cancel</button>
          <button onClick={() => onApply(maxBarWidth, gap, barThickness, callColor, putColor)} className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium">Ok</button>
        </div>
      </div>
    </div>
  );
}

function RsiEditorModal({
  onClose,
  initialColor,
  initialLineWidth,
  initialLineStyle,
  initialSmaLineWidth,
  initialSmaLineStyle,
  initialOverbought1,
  initialOverbought2,
  initialOversold1,
  initialOversold2,
  initialSmaColor,
  initialOverboughtColor,
  initialOversoldColor,
  onApply,
  onChange
}: {
  onClose: () => void,
  initialColor: string,
  initialLineWidth: number,
  initialLineStyle: number,
  initialSmaLineWidth: number,
  initialSmaLineStyle: number,
  initialOverbought1: number,
  initialOverbought2: number,
  initialOversold1: number,
  initialOversold2: number,
  initialSmaColor: string,
  initialOverboughtColor: string,
  initialOversoldColor: string,
  onApply: (
    color: string,
    lineWidth: number,
    lineStyle: number,
    smaLineWidth: number,
    smaLineStyle: number,
    overbought1: number,
    overbought2: number,
    oversold1: number,
    oversold2: number,
    smaColor: string,
    overboughtColor: string,
    oversoldColor: string
  ) => void,
  onChange?: (
    color: string,
    lineWidth: number,
    lineStyle: number,
    smaLineWidth: number,
    smaLineStyle: number,
    overbought1: number,
    overbought2: number,
    oversold1: number,
    oversold2: number,
    smaColor: string,
    overboughtColor: string,
    oversoldColor: string
  ) => void;
}) {
  const [color, setColor] = useState(initialColor);
  const [lineWidth, setLineWidth] = useState(initialLineWidth);
  const [lineStyle, setLineStyle] = useState(initialLineStyle);
  const [smaLineWidth, setSmaLineWidth] = useState(initialSmaLineWidth);
  const [smaLineStyle, setSmaLineStyle] = useState(initialSmaLineStyle);
  const [overbought1, setOverbought1] = useState(initialOverbought1);
  const [overbought2, setOverbought2] = useState(initialOverbought2);
  const [oversold1, setOversold1] = useState(initialOversold1);
  const [oversold2, setOversold2] = useState(initialOversold2);
  const [smaColor, setSmaColor] = useState(initialSmaColor);
  const [overboughtColor, setOverboughtColor] = useState(initialOverboughtColor);
  const [oversoldColor, setOversoldColor] = useState(initialOversoldColor);

  useEffect(() => {
    if (onChange) {
      onChange(color, lineWidth, lineStyle, smaLineWidth, smaLineStyle, overbought1, overbought2, oversold1, oversold2, smaColor, overboughtColor, oversoldColor);
    }
  }, [color, lineWidth, lineStyle, smaLineWidth, smaLineStyle, overbought1, overbought2, oversold1, oversold2, smaColor, overboughtColor, oversoldColor, onChange]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent p-4 animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-card border border-0 rounded-lg w-full max-w-[420px] overflow-visible flex flex-col pt-1 relative text-foreground"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-foreground">RSI Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Overbought Levels */}
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Overbought Levels</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-foreground/80">Level 1:</span>
                <input
                  type="number"
                  value={overbought1}
                  min={50}
                  max={95}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 50 && val <= 95) setOverbought1(val);
                  }}
                  className="w-full bg-background border border-0 rounded px-2.5 py-1.5 text-foreground text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-foreground/80">Level 2:</span>
                <input
                  type="number"
                  value={overbought2}
                  min={50}
                  max={95}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 50 && val <= 95) setOverbought2(val);
                  }}
                  className="w-full bg-background border border-0 rounded px-2.5 py-1.5 text-foreground text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Oversold Levels */}
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Oversold Levels</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-foreground/80">Level 1:</span>
                <input
                  type="number"
                  value={oversold1}
                  min={5}
                  max={50}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 5 && val <= 50) setOversold1(val);
                  }}
                  className="w-full bg-background border border-0 rounded px-2.5 py-1.5 text-foreground text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-foreground/80">Level 2:</span>
                <input
                  type="number"
                  value={oversold2}
                  min={5}
                  max={50}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 5 && val <= 50) setOversold2(val);
                  }}
                  className="w-full bg-background border border-0 rounded px-2.5 py-1.5 text-foreground text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Line Colors */}
          <div className="space-y-4 pt-4 border-t border-0">
            
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground/80">RSI Line</span>
              <TVStylePicker 
                color={color}
                thickness={lineWidth}
                lineStyle={lineStyle}
                onColorChange={setColor}
                onThicknessChange={setLineWidth}
                onLineStyleChange={setLineStyle}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground/80">SMA Line</span>
              <TVStylePicker 
                color={smaColor}
                thickness={smaLineWidth}
                lineStyle={smaLineStyle}
                onColorChange={setSmaColor}
                onThicknessChange={setSmaLineWidth}
                onLineStyleChange={setSmaLineStyle}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground/80">Overbought Level</span>
              <TVStylePicker 
                color={overboughtColor}
                onColorChange={setOverboughtColor}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground/80">Oversold Level</span>
              <TVStylePicker 
                color={oversoldColor}
                onColorChange={setOversoldColor}
              />
            </div>

          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-0 bg-muted gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-0 hover:bg-accent hover:text-accent-foreground rounded text-foreground transition-colors">Cancel</button>
          <button 
            onClick={() => onApply(color, lineWidth, lineStyle, smaLineWidth, smaLineStyle, overbought1, overbought2, oversold1, oversold2, smaColor, overboughtColor, oversoldColor)} 
            className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium"
          >
            Ok
          </button>
        </div>
      </div>
    </div>
  );
}

function HLevelsEditorModal({
  onClose,
  initialLevels,
  initialLineStyle,
  initialLineWidth,
  spotPrice,
  initialShowFiftyPercent,
  initialFiftyPercentColor,
  onApply
}: {
  onClose: () => void,
  initialLevels: number[],
  initialLineStyle: number,
  initialLineWidth: number,
  spotPrice?: number,
  initialShowFiftyPercent: boolean,
  initialFiftyPercentColor: string,
  onApply: (levels: number[], lineStyle: number, lineWidth: number, showFifty: boolean, fiftyColor: string) => void
}) {
  const [levels, setLevels] = useState<number[]>(() => {
    return [...initialLevels];
  });
  const [lineStyle, setLineStyle] = useState(initialLineStyle);
  const [lineWidth, setLineWidth] = useState(initialLineWidth);
  const [showFifty, setShowFifty] = useState(initialShowFiftyPercent);
  const [fiftyColor, setFiftyColor] = useState(initialFiftyPercentColor);

  const handleLevelChange = (index: number, valStr: string) => {
    const val = parseFloat(valStr);
    const newLevels = [...levels];
    newLevels[index] = isNaN(val) ? 0 : Math.round(val);
    setLevels(newLevels);
  };

  const autoAlign = () => {
    if (spotPrice && spotPrice > 0) {
      const step = spotPrice * 0.0015; // 0.15% step
      const aligned = [
        Math.round(spotPrice + step * 2), // Red 1
        Math.round(spotPrice + step),     // Red 2
        Math.round(spotPrice + step * 0.5), // Trap 1
        Math.round(spotPrice - step * 0.5), // Trap 2
        Math.round(spotPrice - step),     // Green 1
        Math.round(spotPrice - step * 2), // Green 2
      ];
      setLevels(aligned);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-transparent p-4 animate-in fade-in duration-250">
      <div className="bg-card border border-0 rounded-lg w-full max-w-[420px] overflow-visible flex flex-col animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between p-4 border-b border-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-foreground">H Levels Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {spotPrice && spotPrice > 0 ? (
            <div className="flex items-center bg-card/40 border border-0 rounded p-2 text-xs">
              <span className="text-muted-foreground font-sans">Spot price: <span className="font-mono text-foreground/90 font-medium">{spotPrice.toFixed(2)}</span></span>
            </div>
          ) : null}

          <div className="space-y-3">
            {/* Red zones */}
            <div className="rounded-lg bg-red-950/10 border border-red-900/25 p-3 space-y-2.5">
              <div className="text-xs font-semibold text-red-400 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                Red Zones (Resistance)
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-sans">RED OUTER</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[0] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(0, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-background border border-red-900/30 rounded px-2 py-1 text-foreground text-right focus:outline-none focus:border-red-500 text-sm font-mono h-9"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-sans">RED INNER</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[1] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(1, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-background border border-red-900/30 rounded px-2 py-1 text-foreground text-right focus:outline-none focus:border-red-500 text-sm font-mono h-9"
                  />
                </div>
              </div>
            </div>

            {/* Trap zones */}
            <div className="rounded-lg bg-yellow-950/10 border border-primary/25 p-3 space-y-2.5">
              <div className="text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                Trap Zones (Intraday ranges)
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-sans">TRAP UPPER</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[2] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(2, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-background border border-primary/30 rounded px-2 py-1 text-foreground text-right focus:outline-none focus:border-primary text-sm font-mono h-9"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-sans">TRAP LOWER</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[3] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(3, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-background border border-primary/30 rounded px-2 py-1 text-foreground text-right focus:outline-none focus:border-primary text-sm font-mono h-9"
                  />
                </div>
              </div>
            </div>

            {/* Green zones */}
            <div className="rounded-lg bg-green-950/10 border border-green-900/25 p-3 space-y-2.5">
              <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Green Zones (Support)
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-sans">GREEN INNER</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[4] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(4, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-background border border-green-900/30 rounded px-2 py-1 text-foreground text-right focus:outline-none focus:border-emerald-500 text-sm font-mono h-9"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-sans">GREEN OUTER</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[5] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(5, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-background border border-emerald-500/30 rounded px-2 py-1 text-foreground text-right focus:outline-none focus:border-emerald-500 text-sm font-mono h-9"
                  />
                </div>
              </div>
            </div>

            {/* Line width selection */}
            <div className="space-y-2 pt-1">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-sans text-muted-foreground">Line thickness</div>
              <div className="flex border border-0 rounded overflow-hidden">
                {[1, 2, 3].map((width) => (
                  <div 
                    key={`lw-${width}`}
                    onClick={() => setLineWidth(width)}
                    className={`flex-[1] h-8 flex items-center justify-center cursor-pointer border-r border-0 last:border-r-0 hover:bg-white/10 ${lineWidth === width ? 'bg-white text-black' : 'bg-muted/50 text-foreground'}`}
                  >
                    <div 
                      className={`w-6 border-t-${width === 1 ? '' : width}`} 
                      style={{ 
                         borderTopWidth: `${width}px`,
                         borderColor: lineWidth === width ? '#000' : '#fff'
                      }} 
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Line style selection */}
            <div className="space-y-2 pt-1">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-sans text-muted-foreground">Line style</div>
              <div className="flex border border-0 rounded overflow-hidden">
                {[
                  { val: 0, dash: 'solid', label: 'Solid' },
                  { val: 1, dash: 'dashed', label: 'Dashed' },
                  { val: 2, dash: 'dotted', label: 'Dotted' }
                ].map((ls) => (
                  <div 
                    key={`ls-${ls.val}`}
                    onClick={() => setLineStyle(ls.val)}
                    className={`flex-[1] h-8 flex items-center justify-center cursor-pointer border-r border-0 last:border-r-0 hover:bg-white/10 ${lineStyle === ls.val ? 'bg-white text-black font-semibold' : 'bg-muted/50 text-foreground'}`}
                  >
                    <div 
                      className="w-6 border-t-2" 
                      style={{ 
                         borderStyle: ls.dash as any, 
                         borderColor: lineStyle === ls.val ? '#000' : '#fff'
                      }} 
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* 50% levels customization */}
            <div className="space-y-2 pt-1 border-t border-0 mt-2">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-sans text-muted-foreground mt-2">50% Levels (Midpoints)</div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-sm text-foreground/90">Show 50% levels</span>
                <button
                  onClick={() => setShowFifty(!showFifty)}
                  className={`w-10 h-5 rounded-full relative transition-colors ${showFifty ? 'bg-emerald-500' : 'bg-slate-700'}`}
                >
                  <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${showFifty ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {showFifty && (
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm text-foreground/90">Color</span>
                  <div className="flex gap-2">
                    {['#3b82f6', '#8b5cf6', '#a1a1aa', '#fbbf24', '#f87171'].map(c => (
                      <div
                        key={c}
                        onClick={() => setFiftyColor(c)}
                        className={`w-6 h-6 rounded-full cursor-pointer border-2 ${fiftyColor === c ? 'border-white' : 'border-transparent'}`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-0 bg-muted gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-0 hover:bg-accent hover:text-accent-foreground rounded text-foreground transition-colors font-sans">Cancel</button>
          <button 
            onClick={() => onApply(levels, lineStyle, lineWidth, showFifty, fiftyColor)} 
            className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium font-sans"
          >
            Ok
          </button>
        </div>
      </div>
    </div>
  );
}

function PdhPdlEditorModal({
  onClose,
  initialPdhColor,
  initialPdlColor,
  initialLineWidth,
  initialLineStyle,
  onApply
}: {
  onClose: () => void,
  initialPdhColor: string,
  initialPdlColor: string,
  initialLineWidth: number,
  initialLineStyle: number,
  onApply: (pdhColor: string, pdlColor: string, lineWidth: number, lineStyle: number) => void
}) {
  const [pdhColor, setPdhColor] = useState(initialPdhColor);
  const [pdlColor, setPdlColor] = useState(initialPdlColor);
  const [lineWidth, setLineWidth] = useState(initialLineWidth);
  const [lineStyle, setLineStyle] = useState(initialLineStyle);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent p-4 animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-card border border-0 rounded-lg w-full max-w-[320px] overflow-visible flex flex-col pt-1 relative"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-foreground">PDH & PDL Settings</h2>
            <div className="w-3 h-3 text-muted-foreground ml-1">
               <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-foreground/80">Previous Day High (PDH)</div>
             <TVStylePicker 
               color={pdhColor}
               thickness={lineWidth}
               lineStyle={lineStyle}
               onColorChange={setPdhColor}
               onThicknessChange={setLineWidth}
               onLineStyleChange={setLineStyle}
             />
          </div>

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-foreground/80">Previous Day Low (PDL)</div>
             <TVStylePicker 
               color={pdlColor}
               thickness={lineWidth}
               lineStyle={lineStyle}
               onColorChange={setPdlColor}
               onThicknessChange={setLineWidth}
               onLineStyleChange={setLineStyle}
             />
          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-0 bg-muted gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-0 hover:bg-accent hover:text-accent-foreground rounded text-foreground transition-colors">Cancel</button>
          <button onClick={() => onApply(pdhColor, pdlColor, lineWidth, lineStyle)} className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium">Ok</button>
        </div>
      </div>
    </div>
  );
}

// --- OHLC Info Panel Helpers ---
const createOHLCInfoPanel = (container: HTMLElement) => {
  let panel = container.querySelector('.ohlc-panel') as HTMLDivElement;
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'ohlc-panel absolute top-2 left-2 z-[20] flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono select-none pointer-events-none px-2.5 py-1.5 rounded-full bg-card/90 backdrop-blur border border-0';
    container.appendChild(panel);
  }
  return panel;
};

function SnREditorModal({
  onClose,
  initialSupportColor,
  initialResistanceColor,
  initialLineWidth,
  initialLineStyle,
  onApply
}: {
  onClose: () => void,
  initialSupportColor: string,
  initialResistanceColor: string,
  initialLineWidth: number,
  initialLineStyle: number,
  onApply: (supportColor: string, resistanceColor: string, width: number, style: number) => void
}) {
  const [supportColor, setSupportColor] = useState(initialSupportColor);
  const [resistanceColor, setResistanceColor] = useState(initialResistanceColor);
  const [lineWidth, setLineWidth] = useState(initialLineWidth);
  const [lineStyle, setLineStyle] = useState(initialLineStyle);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent p-4 animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-card border border-0 rounded-lg w-full max-w-[320px] overflow-visible flex flex-col pt-1"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-0">
          <h3 className="text-lg font-medium text-foreground">Support/Resistance Settings</h3>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded text-muted-foreground hover:text-foreground transition-colors">
            <X size={16} />
          </button>
        </div>
        
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-foreground/80">Support Line</div>
             <TVStylePicker 
               color={supportColor}
               thickness={lineWidth}
               lineStyle={lineStyle}
               onColorChange={setSupportColor}
               onThicknessChange={setLineWidth}
               onLineStyleChange={setLineStyle}
             />
          </div>

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-foreground/80">Resistance Line</div>
             <TVStylePicker 
               color={resistanceColor}
               thickness={lineWidth}
               lineStyle={lineStyle}
               onColorChange={setResistanceColor}
               onThicknessChange={setLineWidth}
               onLineStyleChange={setLineStyle}
             />
          </div>
        </div>

        <div className="flex bg-muted p-4 gap-2 border-t border-0 mt-2">
          <button onClick={onClose} className="flex-1 py-1.5 text-sm bg-transparent border border-0 hover:bg-accent hover:text-accent-foreground rounded text-foreground transition-colors">Cancel</button>
          <button 
            className="flex-1 py-1.5 rounded bg-white text-black hover:bg-gray-200 font-medium text-sm transition-colors"
            onClick={() => onApply(supportColor, resistanceColor, lineWidth, lineStyle)}
          >
            Ok
          </button>
        </div>
      </div>
    </div>
  );
}

const formatPrice = (value: any) => {
  return typeof value === 'number' ? value.toFixed(2) : '-';
};

const formatVolume = (value: any) => {
  if (value === undefined || value === null) return '-';
  const num = Number(value);
  if (num >= 10000000) return (num / 10000000).toFixed(2) + 'Cr';
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(2) + 'K';
  return num.toString();
};

const formatChange = (open: number, close: number) => {
  const change = close - open;
  const percent = (change / open) * 100;
  const sign = change > 0 ? '+' : '';
  const signNum = Math.sign(change);
  return {
    text: `${sign}${change.toFixed(2)} (${sign}${percent.toFixed(2)}%)`,
    color: signNum > 0 ? '#22c55e' : signNum < 0 ? '#ef4444' : '#64748b',
  };
};

const updateOHLCInfoPanel = (panel: HTMLDivElement, candle: any, volume: any) => {
  if (!candle || !panel) return;
  const { open, high, low, close, time } = candle;
  const changeInfo = formatChange(open, close);
  
  const date = new Date(time * 1000);
  const timeStr = Intl.DateTimeFormat('en-IN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' 
  }).format(date);

  panel.innerHTML = `
    <span style="color: #cbd5e1; font-weight: 500;">${timeStr}</span>
    <span style="color: #64748b;">O <span style="color: #cbd5e1;">${formatPrice(open)}</span></span>
    <span style="color: #64748b;">H <span style="color: #cbd5e1;">${formatPrice(high)}</span></span>
    <span style="color: #64748b;">L <span style="color: #cbd5e1;">${formatPrice(low)}</span></span>
    <span style="color: #64748b;">C <span style="color: #cbd5e1;">${formatPrice(close)}</span></span>
    <span style="color: #64748b;">Vol <span style="color: #cbd5e1;">${formatVolume(volume)}</span></span>
    <span style="color: ${changeInfo.color}; font-weight: 500;">${changeInfo.text}</span>
  `;
};

const getLatestCandle = (candleData: any[], volumeData: any[]) => {
  if (!candleData || candleData.length === 0) return { candle: null, volume: null };
  const lastIdx = candleData.length - 1;
  return { 
    candle: candleData[lastIdx], 
    volume: volumeData[lastIdx]?.value 
  };
};
// -------------------------------

// -------------------------------
// Order API Diagnostics State
let lastOrderApiStatus = 'Not Called';
let lastOrderId: string | null = null;
let lastExchangeOrderId: string | null = null;
let lastOrderPayload = '';
let lastOrderResponse = '';
let lastOrderError = '';

export function patchOrderDiagnostics(patch: any) {
  if (patch.lastApiStatus !== undefined) lastOrderApiStatus = patch.lastApiStatus;
  if (patch.lastOrderId !== undefined) lastOrderId = patch.lastOrderId;
  if (patch.lastExchangeOrderId !== undefined) lastExchangeOrderId = patch.lastExchangeOrderId;
  if (patch.lastOrderPayload !== undefined) lastOrderPayload = patch.lastOrderPayload;
  if (patch.lastOrderResponse !== undefined) lastOrderResponse = patch.lastOrderResponse;
  if (patch.lastOrderError !== undefined) lastOrderError = patch.lastOrderError;
}

export function getOrderDiagnostics() {
  return {
    lastApiStatus: lastOrderApiStatus,
    lastOrderId,
    lastExchangeOrderId,
    lastOrderPayload,
    lastOrderResponse,
    lastOrderError
  };
}

function OrderDiagnosticsPanel({ testMode, setTestMode }: { testMode: boolean, setTestMode: (val: boolean) => void }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const d = getOrderDiagnostics();

  return (
    <>
      <div className="w-full h-px bg-muted my-2" />
      <div className="flex justify-between items-center mb-1">
        <span className="text-muted-foreground font-semibold uppercase text-[11px]">Kite Order API</span>
        {d.lastApiStatus === 'Success' ? (
          <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold uppercase">Success</span>
        ) : d.lastApiStatus === 'Failed' ? (
          <span className="text-[9px] bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded font-bold uppercase">Failed</span>
        ) : d.lastApiStatus === 'Calling' ? (
          <span className="text-[9px] bg-sky-500/20 text-sky-400 px-1.5 py-0.5 rounded font-bold uppercase">Calling</span>
        ) : (
          <span className="text-[9px] bg-slate-500/20 text-muted-foreground px-1.5 py-0.5 rounded font-bold uppercase">Not Called</span>
        )}
      </div>

      <div className="flex justify-between items-center bg-card border border-0/60 p-2 rounded-lg mt-1 mb-2">
        <span className="text-[10px] text-foreground/80 font-medium tracking-wide">Test Order Placement Mode</span>
        <label className="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" className="sr-only peer" checked={testMode} onChange={e => setTestMode(e.target.checked)} />
          <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after: after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary"></div>
        </label>
      </div>

      <div className="flex flex-col gap-1.5 text-[10px] space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Order API Status</span>
          <span className={`font-mono ${d.lastApiStatus === 'Success' ? 'text-emerald-400' : d.lastApiStatus === 'Failed' ? 'text-rose-400' : 'text-foreground/80'}`}>
            {d.lastApiStatus}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last Order ID</span>
          <span className="text-foreground/80 font-mono text-right truncate max-w-[150px]">
            {d.lastOrderId || 'N/A'}
          </span>
        </div>
        <div className="flex justify-between border-b border-0/40 pb-1">
          <span className="text-muted-foreground">Exchange Order ID</span>
          <span className="text-foreground/80 font-mono">
            {d.lastExchangeOrderId || 'N/A'}
          </span>
        </div>
        
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Request Payload</span>
          <div className="bg-card overflow-x-auto p-1.5 rounded border border-0 text-foreground/80 font-mono whitespace-pre-wrap max-h-32 text-[9px]">
            {d.lastOrderPayload || 'N/A'}
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Response Payload</span>
          <div className="bg-card overflow-x-auto p-1.5 rounded border border-0 text-foreground/80 font-mono whitespace-pre breaks-all max-h-32 text-[9px]">
            {d.lastOrderResponse || 'N/A'}
          </div>
        </div>

        {d.lastOrderError && (
            <div className="flex flex-col gap-0.5 mt-1 border-t border-0/40 pt-1">
              <span className="text-rose-400">Order Error:</span>
              <span className="text-rose-300 font-medium">
                {d.lastOrderError}
              </span>
            </div>
        )}
      </div>
    </>
  );
}

// Add to the top level outside of AdvancedChart
function MarginDiagnosticsPanel({ ticketData, kiteDiagnosticsData }: { ticketData: any, kiteDiagnosticsData: any }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <div className="w-full h-px bg-muted my-1" />
      <div className="flex justify-between items-center mb-1">
        <span className="text-muted-foreground font-semibold uppercase">Kite Margin API</span>
        {getMarginDiagnostics().lastApiStatus === 'Success' ? (
          <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold uppercase">Success</span>
        ) : getMarginDiagnostics().lastApiStatus === 'Failed' ? (
          <span className="text-[9px] bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded font-bold uppercase">Failed</span>
        ) : getMarginDiagnostics().lastApiStatus === 'Calling' ? (
          <span className="text-[9px] bg-sky-500/20 text-sky-400 px-1.5 py-0.5 rounded font-bold uppercase">Calling</span>
        ) : (
          <span className="text-[9px] bg-slate-500/20 text-muted-foreground px-1.5 py-0.5 rounded font-bold uppercase">Not Called</span>
        )}
      </div>
      
      <div className="flex justify-between">
         <span className="text-muted-foreground">Margin Source</span>
         <span className={getMarginDiagnostics().lastResponseTimestamp > 0 ? "text-emerald-400" : "text-primary"}>
            {getMarginDiagnostics().lastResponseTimestamp > 0 ? 'Kite Margin API' : 'Local Estimate'}
         </span>
      </div>
      <div className="flex justify-between">
         <span className="text-muted-foreground">Fallback Count Today</span>
         <span className={getMarginDiagnostics().fallbackCount > 0 ? "text-primary font-bold" : "text-foreground/80"}>
            {getMarginDiagnostics().fallbackCount}
         </span>
      </div>
      {getMarginDiagnostics().fallbackCount > 0 && (
        <div className="flex justify-between text-[10px] mt-0.5">
           <span className="text-muted-foreground truncate mr-2">Last Reason:</span>
           <span className="text-rose-400 text-right truncate max-w-[150px]" title={getMarginDiagnostics().lastFallbackReason}>
             {getMarginDiagnostics().lastFallbackReason}
           </span>
        </div>
      )}
      
      <div className="flex justify-between mt-1">
         <span className="text-muted-foreground">Cache Hit/Miss</span>
         <span className="text-purple-400">{getMarginDiagnostics().hits} / {getMarginDiagnostics().misses}</span>
      </div>
      <div className="flex justify-between">
         <span className="text-muted-foreground">Resp Time / Size</span>
         <span className="text-sky-400">
           {getMarginDiagnostics().lastApiTime > 0 ? `${getMarginDiagnostics().lastApiTime}ms / ${getMarginDiagnostics().lastResponseSize}B` : 'N/A'}
         </span>
      </div>
      
      <div className="mt-2 bg-card/50 p-2 rounded-lg border border-0">
        <span className="text-[10px] uppercase text-muted-foreground font-bold block mb-1.5 text-center tracking-wider">Side-by-Side Comparison</span>
        <div className="grid grid-cols-[1fr_1fr_1fr] text-[10px] gap-x-2 pb-1 border-b border-0/60 mb-1 text-center">
           <span className="text-muted-foreground text-left">Metric</span>
           <span className="text-emerald-400">Kite API</span>
           <span className="text-primary">Local Est</span>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr] text-[10px] gap-x-2 text-center items-center">
           <span className="text-muted-foreground text-left font-medium">Margin</span>
           <span className="text-emerald-300 font-mono">
             {getMarginDiagnostics().totalMargin > 0 ? `₹${Math.round(getMarginDiagnostics().totalMargin)}` : '-'}
           </span>
           <span className="text-primary font-mono">
             {getMarginDiagnostics().localMargin > 0 ? `₹${Math.round(getMarginDiagnostics().localMargin)}` : '-'}
           </span>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr] text-[10px] gap-x-2 text-center items-center mt-1">
           <span className="text-muted-foreground text-left font-medium">Charges</span>
           <span className="text-emerald-300 font-mono">
             {getMarginDiagnostics().totalCharges > 0 ? `₹${getMarginDiagnostics().totalCharges.toFixed(1)}` : '-'}
           </span>
           <span className="text-primary font-mono">
             {getMarginDiagnostics().localCharges > 0 ? `₹${getMarginDiagnostics().localCharges.toFixed(1)}` : '-'}
           </span>
        </div>
        {getMarginDiagnostics().totalCharges > 0 && getMarginDiagnostics().localCharges > 0 && (
           <div className="text-[9px] text-center mt-1.5 pt-1 border-t border-0/60 text-muted-foreground">
             Diff: <span className="font-mono text-cyan-400">₹{Math.abs(getMarginDiagnostics().totalCharges - getMarginDiagnostics().localCharges).toFixed(2)}</span>
           </div>
        )}
      </div>
      
      <div className="mt-3">
        <button 
          onClick={async () => {
            const payload = ticketData ? {
              exchange: ticketData.exchange || 'NFO',
              tradingsymbol: ticketData.tradingsymbol,
              quantity: ticketData.lotSize ? ticketData.lotSize : ticketData.quantity,
              transaction_type: ticketData.action,
              product: ticketData.product || 'NRML',
              order_type: ticketData.orderType || 'MARKET',
              price: ticketData.limitPrice || ticketData.ltp,
              variety: 'regular'
            } : {
              exchange: 'NFO',
              tradingsymbol: 'NIFTY24MAY22000CE',
              quantity: 25,
              transaction_type: 'BUY',
              product: 'NRML',
              order_type: 'MARKET',
              price: 100,
              variety: 'regular'
            };
            patchMarginDiagnostics({
              lastApiStatus: 'Calling',
              lastApiEndpoint: '/api/orders/margins',
              lastApiRequestPayload: JSON.stringify(payload, null, 2)
            });
            try {
              const res = await fetch('/api/orders/margins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });
              const text = await res.text();
              let parsedJson;
              let isParsed = false;
              try {
                parsedJson = JSON.parse(text);
                isParsed = true;
              } catch {
                parsedJson = { success: false, error: 'JSON Parse Error' };
              }
              
              const isSuccess = res.ok && parsedJson.success;
              let marginTotal = 0;
              let marginCharges = 0;
              if (isSuccess && parsedJson.responseBody) {
                 marginTotal = parsedJson.responseBody.total || 0;
                 marginCharges = parsedJson.responseBody.charges?.total || 0;
              }

              patchMarginDiagnostics({
                lastApiStatus: isSuccess ? 'Success' : 'Failed',
                lastApiStatusCode: res.status,
                lastApiResponseBody: text,
                lastFallbackReason: isSuccess ? '' : parsedJson.error || 'API Error',
                lastResponseTimestamp: isSuccess ? Date.now() : undefined,
                totalMargin: marginTotal,
                totalCharges: marginCharges,
                lastApiResponseParsed: isParsed,
                lastApiAppliedToTicket: ticketData ? false : true // Simulating not applied because we're just clicking test button
              });
              
              let out = JSON.stringify(parsedJson, null, 2);
              // alert(`Test Request Details:\\n\\nURL: /api/orders/margins\\nPayload: ${JSON.stringify(payload)}\\n\\nStatus: ${res.status}\\n\\nResponse:\\n${out}`);
            } catch(e: any) {
              patchMarginDiagnostics({
                lastApiStatus: 'Failed',
                lastFallbackReason: e.message,
                lastApiResponseParsed: false
              });
              // alert(`Test Failed: ${e.message}`);
            }
          }}
          className="w-full bg-cyan-900/40 hover:bg-cyan-800/60 text-cyan-300 text-[10px] py-1.5 rounded transition-colors uppercase font-bold tracking-wider"
        >
           Test Kite Margin API
        </button>
      </div>

      <div className="w-full h-px bg-muted my-2" />
      <div className="text-muted-foreground font-semibold uppercase mb-1">Kite API Status</div>
      <div className="flex flex-col gap-1.5 text-[10px] mt-1 space-y-1">
         <div className="flex justify-between">
           <span className="text-muted-foreground">Kite API Keys Configured</span>
           <span className={`font-mono font-bold ${kiteDiagnosticsData?.kiteApiKeysConfigured ? 'text-emerald-400' : 'text-rose-400 animate-pulse'}`}>
             {kiteDiagnosticsData?.kiteApiKeysConfigured ? 'TRUE' : 'FALSE'}
           </span>
         </div>
         <div className="flex justify-between">
           <span className="text-muted-foreground">Kite Access Token Present</span>
           <span className={`font-mono font-bold ${kiteDiagnosticsData?.kiteAccessTokenPresent ? 'text-emerald-400' : 'text-rose-400 animate-pulse'}`}>
             {kiteDiagnosticsData?.kiteAccessTokenPresent ? 'TRUE' : 'FALSE'}
           </span>
         </div>
      </div>

      <div className="w-full h-px bg-muted my-2" />
      <div className="text-muted-foreground font-semibold uppercase mb-1">Margin API Debug</div>
      <div className="flex flex-col gap-1.5 text-[10px] mt-1 space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">API Status</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiStatus === 'Success' ? 'text-emerald-400' : getMarginDiagnostics().lastApiStatus === 'Failed' ? 'text-rose-400' : 'text-foreground/80'}`}>
            {getMarginDiagnostics().lastApiStatus}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last Endpoint</span>
          <span className="text-foreground/80 font-mono">
            {getMarginDiagnostics().lastApiEndpoint || 'N/A'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Last Payload</span>
          <div className="bg-card overflow-x-auto p-1.5 rounded border border-0 text-foreground/80 font-mono whitespace-pre-wrap max-h-32 text-[9px]">
            {getMarginDiagnostics().lastApiRequestPayload || 'N/A'}
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Res Status Code</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiStatusCode === 200 ? 'text-emerald-400' : getMarginDiagnostics().lastApiStatusCode > 0 ? 'text-rose-400' : 'text-foreground/80'}`}>
            {getMarginDiagnostics().lastApiStatusCode || 'N/A'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Last Response Body</span>
          <div className="bg-card overflow-x-auto p-1.5 rounded border border-0 text-foreground/80 font-mono whitespace-pre breaks-all max-h-32 text-[9px]">
            {getMarginDiagnostics().lastApiResponseBody || 'N/A'}
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last Success</span>
          <span className={`font-mono ${getMarginDiagnostics().lastResponseTimestamp > 0 ? 'text-emerald-400' : 'text-foreground/80'}`}>
            {getMarginDiagnostics().lastResponseTimestamp > 0 ? new Date(getMarginDiagnostics().lastResponseTimestamp).toLocaleTimeString() : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Margin API Res Parsed</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiResponseParsed ? 'text-emerald-400' : 'text-foreground/80'}`}>
            {getMarginDiagnostics().lastApiResponseParsed ? 'TRUE' : 'FALSE'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Kite API Total Margin</span>
          <span className="font-mono text-cyan-400">
            {getMarginDiagnostics().totalMargin > 0 ? `₹${getMarginDiagnostics().totalMargin.toFixed(2)}` : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Kite API Total Charges</span>
          <span className="font-mono text-cyan-400">
            {getMarginDiagnostics().totalCharges > 0 ? `₹${getMarginDiagnostics().totalCharges.toFixed(2)}` : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Applied To Order Ticket</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiAppliedToTicket ? 'text-emerald-400' : 'text-foreground/80'}`}>
            {getMarginDiagnostics().lastApiAppliedToTicket ? 'TRUE' : 'FALSE'}
          </span>
        </div>
        {getMarginDiagnostics().lastApiStatus === 'Success' && !getMarginDiagnostics().lastApiAppliedToTicket && (
           <div className="text-rose-400 font-bold border border-rose-500/30 bg-rose-500/10 p-1.5 rounded text-[10px] mt-1 text-center">
             ⚠️ Kite margin response received but not applied to ticket.
           </div>
        )}
        {getMarginDiagnostics().lastFallbackReason && (
            <div className="flex flex-col gap-0.5">
              <span className="text-rose-400">Fallback Trigger Reason:</span>
              <span className="text-rose-300 font-medium">
                {getMarginDiagnostics().lastFallbackReason}
              </span>
            </div>
        )}
      </div>
    </>
  );
}

// Global cache to remember the chart position across tab switches and unmounts
const globalLogicalRangeCache: Record<string, any> = {};

export function AdvancedChart() {
  useProfiler("AdvancedChart");
  const { data: kiteDiagnosticsData } = useQuery({
    queryKey: ['kiteDiagnostics'],
    queryFn: async () => {
      const res = await fetch('/api/diagnostics/kite');
      if (!res.ok) throw new Error('Failed to fetch Kite diagnostics');
      return res.json();
    },
    refetchInterval: 30000
  });

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const rsiContainerRef = useRef<HTMLDivElement>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<any>(null);
  const rsiSeriesRef = useRef<any>(null);
  const rsiSmaSeriesRef = useRef<any>(null);
  const rsiClosesRef = useRef<number[]>([]);
  const volumeSeriesRef = useRef<any>(null);
  const lastCandleTimeRef = useRef<number | null>(null);
  const lastCandleDataRef = useRef<any>(null);
  const chartDataRef = useRef<any>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverTimeOffsetRef = useRef<number>(0);
  
  const [timeframe, setTimeframe] = useState(() => {
    try {
      return localStorage.getItem('timeframe') || "15";
    } catch(e) {}
    return "15";
  });
  const [wsError, setWsError] = useState<string>('');
  const [quickTradeEnabled, setQuickTradeEnabled] = useState(() => {
    try {
      return localStorage.getItem('quickTradeEnabled') === 'true';
    } catch(e) {}
    return false;
  });
  const quickTradeEnabledRef = useRef(quickTradeEnabled);
  useEffect(() => {
    quickTradeEnabledRef.current = quickTradeEnabled;
  }, [quickTradeEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem('quickTradeEnabled', String(quickTradeEnabled));
    } catch(e) {}
  }, [quickTradeEnabled]);

  const [testOrderMode, setTestOrderMode] = useState(() => {
    try {
      return localStorage.getItem('testOrderMode') === 'true';
    } catch(e) {}
    return false;
  });

  useEffect(() => {
    try {
      localStorage.setItem('timeframe', timeframe);
      window.dispatchEvent(new Event('storage'));
    } catch(e) {}
  }, [timeframe]);

  useEffect(() => {
    try {
      localStorage.setItem('testOrderMode', String(testOrderMode));
    } catch(e) {}
  }, [testOrderMode]);
  const [crosshairInfo, setCrosshairInfo] = useState<{ x: number, y: number, price: number } | null>(null);
  const crosshairInfoRef = useRef<{ x: number, y: number, price: number } | null>(null);

  useEffect(() => {
    crosshairInfoRef.current = crosshairInfo;
  }, [crosshairInfo]);
  const [showPdhPdl, setShowPdhPdl] = useState(() => {
    try {
      return localStorage.getItem('showPdhPdl') === 'true';
    } catch(e) {}
    return false;
  });
  const [pdhColor, setPdhColor] = useState(() => {
    try {
      return localStorage.getItem('pdhColor') || '#22c55e';
    } catch(e) {}
    return '#22c55e';
  });
  const [pdlColor, setPdlColor] = useState(() => {
    try {
      return localStorage.getItem('pdlColor') || '#ef4444';
    } catch(e) {}
    return '#ef4444';
  });
  const [pdhPdlWidth, setPdhPdlWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('pdhPdlWidth');
      return saved ? parseInt(saved, 10) : 2;
    } catch(e) {}
    return 2;
  });
  const [pdhPdlStyle, setPdhPdlStyle] = useState(() => {
    try {
      const saved = localStorage.getItem('pdhPdlStyle');
      return saved ? parseInt(saved, 10) : 2; // Dashed
    } catch(e) {}
    return 2; // Dashed
  });

  const [showSnR, setShowSnR] = useState(() => {
    try {
      const saved = localStorage.getItem('showSnR');
      return saved === null ? true : saved === 'true'; // Default true
    } catch(e) {}
    return true;
  });
  const [supportColor, setSupportColor] = useState(() => {
    try {
      return localStorage.getItem('supportColor') || '#22c55e';
    } catch(e) {}
    return '#22c55e';
  });
  const [resistanceColor, setResistanceColor] = useState(() => {
    try {
      return localStorage.getItem('resistanceColor') || '#ef4444';
    } catch(e) {}
    return '#ef4444';
  });
  const [snrWidth, setSnrWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('snrWidth');
      return saved ? parseInt(saved, 10) : 2;
    } catch(e) {}
    return 2;
  });
  const [snrStyle, setSnrStyle] = useState(() => {
    try {
      const saved = localStorage.getItem('snrStyle');
      // Style logic similar to pdh/pdl. Let's use 1 (Dotted) or 2 (Dashed)
      return saved ? parseInt(saved, 10) : 1;
    } catch(e) {}
    return 1;
  });

  useEffect(() => {
    try {
      localStorage.setItem('showPdhPdl', String(showPdhPdl));
    } catch(e) {}
  }, [showPdhPdl]);

  useEffect(() => {
    try {
      localStorage.setItem('showSnR', String(showSnR));
    } catch(e) {}
  }, [showSnR]);

  useEffect(() => {
    try {
      localStorage.setItem('supportColor', supportColor);
    } catch(e) {}
  }, [supportColor]);

  useEffect(() => {
    try {
      localStorage.setItem('resistanceColor', resistanceColor);
    } catch(e) {}
  }, [resistanceColor]);

  useEffect(() => {
    try {
      localStorage.setItem('snrWidth', String(snrWidth));
    } catch(e) {}
  }, [snrWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('snrStyle', String(snrStyle));
    } catch(e) {}
  }, [snrStyle]);

  useEffect(() => {
    try {
      localStorage.setItem('pdhColor', pdhColor);
    } catch(e) {}
  }, [pdhColor]);

  useEffect(() => {
    try {
      localStorage.setItem('pdlColor', pdlColor);
    } catch(e) {}
  }, [pdlColor]);

  useEffect(() => {
    try {
      localStorage.setItem('pdhPdlWidth', String(pdhPdlWidth));
    } catch(e) {}
  }, [pdhPdlWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('pdhPdlStyle', String(pdhPdlStyle));
    } catch(e) {}
  }, [pdhPdlStyle]);
  const [showOiBars, setShowOiBars] = useState(() => {
    try {
      return localStorage.getItem('showOiBars') === 'true';
    } catch(e) {}
    return false;
  });
  const [showRsi, setShowRsi] = useState(() => {
    try {
      const saved = localStorage.getItem('showRsi');
      return saved === null ? true : saved === 'true';
    } catch(e) {}
    return true;
  });

  useEffect(() => {
    try {
      localStorage.setItem('showOiBars', String(showOiBars));
    } catch(e) {}
  }, [showOiBars]);

  useEffect(() => {
    try {
      localStorage.setItem('showRsi', String(showRsi));
    } catch(e) {}
  }, [showRsi]);

  // States for chart-click option strike selection
  const [clickMenu, setClickMenu] = useState<{ x: number, y: number, price: number } | null>(null);
  const [selectedStrikeOnChart, setSelectedStrikeOnChart] = useState<{ strike: number; tradingsymbol: string; optionType: 'CE' | 'PE' } | null>(() => {
    try {
      const saved = localStorage.getItem('selectedStrikeOnChart');
      return saved ? JSON.parse(saved) : null;
    } catch(e) {}
    return null;
  });

  const [activePositions, setActivePositions] = useState<any[]>([]);
  const [isExitingAllTrades, setIsExitingAllTrades] = useState(false);

  const loadActivePositions = () => {
    try {
      const stored = localStorage.getItem('active_positions');
      if (stored) {
        setActivePositions(JSON.parse(stored));
      } else {
        setActivePositions([]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadActivePositions();
    const handleUpdate = () => loadActivePositions();
    window.addEventListener('active_positions_updated', handleUpdate);
    window.addEventListener('storage', handleUpdate);
    return () => {
      window.removeEventListener('active_positions_updated', handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, []);

  useEffect(() => {
    try {
      if (selectedStrikeOnChart) {
        localStorage.setItem('selectedStrikeOnChart', JSON.stringify(selectedStrikeOnChart));
      } else {
        localStorage.removeItem('selectedStrikeOnChart');
      }
    } catch(e) {}
  }, [selectedStrikeOnChart]);
  const [showOrderTicket, setShowOrderTicket] = useState(false);
  const [isProcessingStrikeAction, setIsProcessingStrikeAction] = useState(false);
  const [availableExpiries, setAvailableExpiries] = useState<string[]>([]);
  const [availBalance, setAvailBalance] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('kite_sim_balance');
      return saved ? parseFloat(saved) : 150000.00;
    } catch (e) {
      return 150000.00;
    }
  });
  const [ticketData, setTicketData] = useState<{
    action: 'BUY' | 'SELL';
    optionType: 'CE' | 'PE';
    underlying: string;
    expiry: string;
    strike: number;
    tradingsymbol: string;
    instrument_token: string;
    ltp: number;
    lotSize?: number;
    quantity: number;
    product: 'MIS' | 'NRML';
    orderType: 'MARKET' | 'LIMIT';
    limitPrice: number;
    exchange?: string;
    segment?: string;
    source_of_lot_size?: string;
  } | null>(null);

  // Fetch live available funds from the connected Kite account
  const fetchKiteBalance = async () => {
    try {
      const res = await fetch('/api/margins');
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          if (data && data.success) {
            if (data.live) {
              setAvailBalance(data.balance);
            } else {
              const saved = localStorage.getItem('kite_sim_balance');
              if (saved) {
                setAvailBalance(parseFloat(saved));
              } else {
                setAvailBalance(data.balance);
              }
            }
          }
        } else {
          // If the server served HTML or invalid response (e.g. login gate or pending routes), fallback to simulation balance
          const saved = localStorage.getItem('kite_sim_balance');
          if (saved) {
            setAvailBalance(parseFloat(saved));
          } else {
            setAvailBalance(150000.00);
          }
        }
      } else {
        // Fallback to simulation balance if 500 or other errors
        const saved = localStorage.getItem('kite_sim_balance');
        if (saved) {
          setAvailBalance(parseFloat(saved));
        } else {
          setAvailBalance(150000.00);
        }
      }
    } catch (e) {
      console.error("Error fetching available balance:", e);
      // Fallback on parse/network error
      const saved = localStorage.getItem('kite_sim_balance');
      if (saved) {
        setAvailBalance(parseFloat(saved));
      } else {
        setAvailBalance(150000.00);
      }
    }
  };

  useEffect(() => {
    fetchKiteBalance();
    const interval = setInterval(fetchKiteBalance, 15000); // Poll every 15s to keep funds live
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (showOrderTicket) {
      fetchKiteBalance();
    }
  }, [showOrderTicket]);

  const [showHLevels, setShowHLevels] = useState(() => {
    try {
      return localStorage.getItem('showHLevels') === 'true';
    } catch(e) {}
    return false;
  });

  const [hLevels, setHLevels] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem('hLevels');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 6) {
          return parsed.map(v => Math.round(Number(v)));
        }
      }
    } catch(e) {}
    return [0, 0, 0, 0, 0, 0];
  });

  const [hLevelsStyle, setHLevelsStyle] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('hLevelsStyle');
      return saved ? parseInt(saved, 10) : 1; // Default to 1 (Dashed)
    } catch(e) {}
    return 1;
  });

  const [hLevelsWidth, setHLevelsWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('hLevelsWidth');
      return saved ? parseInt(saved, 10) : 1;
    } catch(e) {}
    return 1;
  });

  const [showFiftyPercentLevels, setShowFiftyPercentLevels] = useState(() => {
    try {
      return localStorage.getItem('showFiftyPercentLevels') === 'true';
    } catch(e) {}
    return false;
  });

  const [fiftyPercentColor, setFiftyPercentColor] = useState(() => {
    try {
      return localStorage.getItem('fiftyPercentColor') || '#a1a1aa';
    } catch(e) {}
    return '#a1a1aa';
  });

  const [isEditingHLevels, setIsEditingHLevels] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('showHLevels', String(showHLevels));
    } catch(e) {}
  }, [showHLevels]);

  useEffect(() => {
    try {
      localStorage.setItem('hLevels', JSON.stringify(hLevels));
    } catch(e) {}
  }, [hLevels]);

  useEffect(() => {
    try {
      localStorage.setItem('hLevelsStyle', String(hLevelsStyle));
    } catch(e) {}
  }, [hLevelsStyle]);

  useEffect(() => {
    try {
      localStorage.setItem('hLevelsWidth', String(hLevelsWidth));
    } catch(e) {}
  }, [hLevelsWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('showFiftyPercentLevels', String(showFiftyPercentLevels));
    } catch(e) {}
  }, [showFiftyPercentLevels]);

  useEffect(() => {
    try {
      localStorage.setItem('fiftyPercentColor', fiftyPercentColor);
    } catch(e) {}
  }, [fiftyPercentColor]);

  const [showBB, setShowBB] = useState(() => {
    try {
      return localStorage.getItem('showBB') === 'true';
    } catch(e) {}
    return false;
  });
  const [bbPeriod, setBbPeriod] = useState(() => {
    try {
      const saved = localStorage.getItem('bbPeriod');
      return saved ? parseInt(saved, 10) : 20;
    } catch(e) {}
    return 20;
  });
  const [bbStdDev, setBbStdDev] = useState(() => {
    try {
      const saved = localStorage.getItem('bbStdDev');
      return saved ? parseFloat(saved) : 2;
    } catch(e) {}
    return 2;
  });

  useEffect(() => {
    try {
      localStorage.setItem('showBB', String(showBB));
    } catch(e) {}
  }, [showBB]);

  useEffect(() => {
    try {
      localStorage.setItem('bbPeriod', String(bbPeriod));
    } catch(e) {}
  }, [bbPeriod]);

  useEffect(() => {
    try {
      localStorage.setItem('bbStdDev', String(bbStdDev));
    } catch(e) {}
  }, [bbStdDev]);
  const [isIndicatorsOpen, setIsIndicatorsOpen] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(() => {
    try {
      return localStorage.getItem('showDiagnostic') === 'true';
    } catch(e) {}
    return false;
  });
  const indicatorsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem('showDiagnostic', String(showDiagnostic));
    } catch(e) {}
  }, [showDiagnostic]);
  const [rsiHoverValue, setRsiHoverValue] = useState<string | null>(null);
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(() => {
    try {
      const saved = localStorage.getItem('selectedInstrument');
      return saved ? JSON.parse(saved) : null;
    } catch(e) {}
    return null;
  });

  useEffect(() => {
    try {
      if (selectedInstrument) {
        localStorage.setItem('selectedInstrument', JSON.stringify(selectedInstrument));
      } else {
        localStorage.removeItem('selectedInstrument');
      }
    } catch(e) {}
  }, [selectedInstrument]);
  
  const [manualLineIds, setManualLineIds] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem('advancedChartLines');
      if (saved) return JSON.parse(saved);
    } catch(e) {}
    return [];
  });
  
  const manualLineIdsRef = useRef<any[]>(manualLineIds);
  useEffect(() => {
    manualLineIdsRef.current = manualLineIds;
  }, [manualLineIds]);
  
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [isEditingPdhPdl, setIsEditingPdhPdl] = useState(false);
  const [isEditingSnR, setIsEditingSnR] = useState(false);
  const [isEditingBB, setIsEditingBB] = useState(false);
  const [isEditingOiBars, setIsEditingOiBars] = useState(false);
  const [isEditingRsi, setIsEditingRsi] = useState(false);

  const logicalRangeRef = useRef<any>(null);

  const cacheKey = `${selectedInstrument?.instrument_token}_${timeframe}`;

  useEffect(() => {
    logicalRangeRef.current = globalLogicalRangeCache[cacheKey] || null;
  }, [cacheKey]);

  const [bbColor, setBbColor] = useState(() => {
    try {
      return localStorage.getItem('bbColor') || '#22d3ee'; // Cyan-400
    } catch(e) {}
    return '#22d3ee';
  });

  const [oiMaxBarWidth, setOiMaxBarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('oiMaxBarWidth');
      return saved ? parseInt(saved, 10) : 250;
    } catch(e) {}
    return 250;
  });

  const [oiBarGap, setOiBarGap] = useState(() => {
    try {
      const saved = localStorage.getItem('oiBarGap');
      return saved ? parseInt(saved, 10) : 0;
    } catch(e) {}
    return 0;
  });

  const [oiBarThickness, setOiBarThickness] = useState(() => {
    try {
      const saved = localStorage.getItem('oiBarThickness');
      return saved ? parseInt(saved, 10) : 8;
    } catch(e) {}
    return 8;
  });

  const [oiCallColor, setOiCallColor] = useState(() => {
    try {
      return localStorage.getItem('oiCallColor') || '#ef4444';
    } catch(e) {}
    return '#ef4444';
  });

  const [oiPutColor, setOiPutColor] = useState(() => {
    try {
      return localStorage.getItem('oiPutColor') || '#22c55e';
    } catch(e) {}
    return '#22c55e';
  });

  const [rsiColor, setRsiColor] = useState(() => {
    try {
      return localStorage.getItem('rsiColor') || '#a855f7'; // Purple-500
    } catch(e) {}
    return '#a855f7';
  });
  const [rsiLineWidth, setRsiLineWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('rsiLineWidth') || '2', 10); } catch(e) {}
    return 2;
  });
  const [rsiLineStyle, setRsiLineStyle] = useState(() => {
    try { return parseInt(localStorage.getItem('rsiLineStyle') || '0', 10); } catch(e) {}
    return 0;
  });
  const [rsiSmaLineWidth, setRsiSmaLineWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('rsiSmaLineWidth') || '1', 10); } catch(e) {}
    return 1;
  });
  const [rsiSmaLineStyle, setRsiSmaLineStyle] = useState(() => {
    try { return parseInt(localStorage.getItem('rsiSmaLineStyle') || '0', 10); } catch(e) {}
    return 0;
  });

  const [rsiOverbought1, setRsiOverbought1] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOverbought1');
      return saved ? parseInt(saved, 10) : 60;
    } catch (e) {}
    return 60;
  });

  const [rsiOverbought2, setRsiOverbought2] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOverbought2');
      return saved ? parseInt(saved, 10) : 65;
    } catch (e) {}
    return 65;
  });

  const [rsiOversold1, setRsiOversold1] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOversold1');
      return saved ? parseInt(saved, 10) : 38;
    } catch (e) {}
    return 38;
  });

  const [rsiOversold2, setRsiOversold2] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOversold2');
      return saved ? parseInt(saved, 10) : 40;
    } catch (e) {}
    return 40;
  });

  const [rsiSmaColor, setRsiSmaColor] = useState(() => {
    try {
      return localStorage.getItem('rsiSmaColor') || '#eab308'; // Default yellow-500
    } catch(e) {}
    return '#eab308';
  });

  const [rsiOverboughtColor, setRsiOverboughtColor] = useState(() => {
    try {
      return localStorage.getItem('rsiOverboughtColor') || '#22c55e'; // Default elegant green
    } catch(e) {}
    return '#22c55e';
  });

  const [rsiOversoldColor, setRsiOversoldColor] = useState(() => {
    try {
      return localStorage.getItem('rsiOversoldColor') || '#ef4444'; // Default elegant red
    } catch(e) {}
    return '#ef4444';
  });

  useEffect(() => {
    try {
      localStorage.setItem('bbColor', bbColor);
    } catch(e) {}
  }, [bbColor]);

  useEffect(() => {
    try {
      localStorage.setItem('oiMaxBarWidth', String(oiMaxBarWidth));
    } catch(e) {}
  }, [oiMaxBarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('oiBarGap', String(oiBarGap));
    } catch(e) {}
  }, [oiBarGap]);

  useEffect(() => {
    try {
      localStorage.setItem('oiBarThickness', String(oiBarThickness));
    } catch(e) {}
  }, [oiBarThickness]);

  useEffect(() => {
    try {
      localStorage.setItem('oiCallColor', oiCallColor);
    } catch(e) {}
  }, [oiCallColor]);

  useEffect(() => {
    try {
      localStorage.setItem('oiPutColor', oiPutColor);
    } catch(e) {}
  }, [oiPutColor]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiColor', rsiColor);
      localStorage.setItem('rsiLineWidth', String(rsiLineWidth));
      localStorage.setItem('rsiLineStyle', String(rsiLineStyle));
      localStorage.setItem('rsiSmaLineWidth', String(rsiSmaLineWidth));
      localStorage.setItem('rsiSmaLineStyle', String(rsiSmaLineStyle));
    } catch(e) {}
  }, [rsiColor, rsiLineWidth, rsiLineStyle, rsiSmaLineWidth, rsiSmaLineStyle]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOverbought1', String(rsiOverbought1));
    } catch(e) {}
  }, [rsiOverbought1]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOverbought2', String(rsiOverbought2));
    } catch(e) {}
  }, [rsiOverbought2]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOversold1', String(rsiOversold1));
    } catch(e) {}
  }, [rsiOversold1]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOversold2', String(rsiOversold2));
    } catch(e) {}
  }, [rsiOversold2]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiSmaColor', rsiSmaColor);
    } catch(e) {}
  }, [rsiSmaColor]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOverboughtColor', rsiOverboughtColor);
    } catch(e) {}
  }, [rsiOverboughtColor]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOversoldColor', rsiOversoldColor);
    } catch(e) {}
  }, [rsiOversoldColor]);
  
  useEffect(() => {
    try {
      localStorage.setItem('advancedChartLines', JSON.stringify(manualLineIds));
    } catch(e) {}
  }, [manualLineIds]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (indicatorsRef.current && !indicatorsRef.current.contains(event.target as Node)) {
        setIsIndicatorsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  
  const manualLinesRef = useRef<any[]>([]);
  const pdhPdlLinesRef = useRef<{ pdh: any; pdl: any } | null>(null);
  const isHoveringButtonRef = useRef(false);
  const draggingLineRef = useRef<{ id: number, startY: number, dragged: boolean, sl?: 'upper' | 'lower' } | null>(null);

  // ===== Phase 2: draggable SL/Target lines feeding the server-side auto-exit watcher =====
  const slLinesRef = useRef<{ kind: 'upper' | 'lower', price: number, instance: any, label: string, color: string }[]>([]);
  const slSeriesRef = useRef<any>(null); // the series instance the SL lines were created on (to detect recreation)
  const chartLevelsRef = useRef<number[]>([]); // all chart levels (H-levels, 50%, PDH/PDL, S/R) for default target
  const oiGlowRef = useRef<Record<number, { call: number, put: number }>>({}); // strike -> last time call/put OI grew (ms)
  const [slActivePos, setSlActivePos] = useState<any>(null);
  const slIsBullish = slActivePos ? ((slActivePos.side === 'BUY' && slActivePos.optionType === 'CE') || (slActivePos.side === 'SELL' && slActivePos.optionType === 'PE')) : true;
  const [slLevels, setSlLevels] = useState<{ upper: number | null, lower: number | null }>({ upper: null, lower: null });
  const [slStopMode, setSlStopMode] = useState<'TOUCH' | 'CLOSE'>('CLOSE');
  const [slTargetMode, setSlTargetMode] = useState<'TOUCH' | 'CLOSE'>('CLOSE');
  const [slRsiLower, setSlRsiLower] = useState<string>('');
  const [slRsiUpper, setSlRsiUpper] = useState<string>('');
  const [slArmedRule, setSlArmedRule] = useState<any>(null);
  const [slSaving, setSlSaving] = useState(false);
  const [slPanelOpen, setSlPanelOpen] = useState(false);
  const [slTrail, setSlTrail] = useState(true);
  const [slTrailCandles, setSlTrailCandles] = useState<string>('3');

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!chartContainerRef.current || !mainSeriesRef.current || !mainChartRef.current) return;
    const rect = chartContainerRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;

    // SL/Target lines take priority for dragging
    for (const sl of slLinesRef.current) {
        const lineY = mainSeriesRef.current.priceToCoordinate(sl.price);
        if (lineY !== null && Math.abs(lineY - y) < 15) {
            draggingLineRef.current = { id: -1, startY: y, dragged: false, sl: sl.kind };
            mainChartRef.current.applyOptions({ handleScroll: false, handleScale: false });
            return;
        }
    }

    let foundLineId = null;
    for (let i = 0; i < manualLinesRef.current.length; i++) {
        const line = manualLinesRef.current[i];
        const lineY = mainSeriesRef.current.priceToCoordinate(line.price);
        if (lineY !== null && Math.abs(lineY - y) < 15) {
            foundLineId = line.id;
            break;
        }
    }

    if (foundLineId) {
       draggingLineRef.current = { id: foundLineId, startY: y, dragged: false };
       mainChartRef.current.applyOptions({ handleScroll: false, handleScale: false });
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingLineRef.current || !mainSeriesRef.current || !chartContainerRef.current) return;
    const rect = chartContainerRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    
    if (Math.abs(y - draggingLineRef.current.startY) > 5) {
       draggingLineRef.current.dragged = true;
    }

    const newPrice = mainSeriesRef.current.coordinateToPrice(y);

    // SL/Target line drag — move the line and update the live readout
    if (draggingLineRef.current.sl) {
       if (newPrice !== null) {
          const kind = draggingLineRef.current.sl;
          const sl = slLinesRef.current.find(s => s.kind === kind);
          if (sl) { sl.price = newPrice; sl.instance.applyOptions({ price: newPrice }); }
          setSlLevels(prev => ({ ...prev, [kind]: Math.round(newPrice) }));
       }
       return;
    }

    if (newPrice !== null) {
       const lineObj = manualLinesRef.current.find((l: any) => l.id === draggingLineRef.current!.id);
       if (lineObj) {
           lineObj.price = newPrice;
           lineObj.instance.applyOptions({ price: newPrice });
       }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    // SL/Target line release — restore scroll and clear (levels already synced during move)
    if (draggingLineRef.current && draggingLineRef.current.sl) {
        if (mainChartRef.current) {
           mainChartRef.current.applyOptions({
              handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
              handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
           });
        }
        setTimeout(() => { draggingLineRef.current = null; }, 150);
        return;
    }

    if (draggingLineRef.current && mainChartRef.current) {
        const id = draggingLineRef.current.id;
        const lineObj = manualLinesRef.current.find((l: any) => l.id === id);
        if (lineObj && draggingLineRef.current.dragged) {
            setManualLineIds(prev => prev.map(l => l.id === id ? { ...l, price: lineObj.price } : l));
        }
        
        mainChartRef.current.applyOptions({
           handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
           handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
        });
        
        setTimeout(() => {
           draggingLineRef.current = null;
        }, 150);
    }
  };

  const handleAddManualLine = () => {
    if (crosshairInfo && mainSeriesRef.current) {
        const price = crosshairInfo.price;
        const newPriceLine = mainSeriesRef.current.createPriceLine({
            price: price,
            color: '#facc15',
            lineWidth: 2,
            lineStyle: 0,
            axisLabelVisible: true,
            title: '',
        });
        const id = Date.now() + Math.random();
        manualLinesRef.current.push({ id, price: price, instance: newPriceLine, color: '#facc15', lineWidth: 2, axisLabelVisible: true, lineStyle: 0 });
        setManualLineIds(prev => [...prev, { id, price, color: '#facc15', lineWidth: 2, axisLabelVisible: true, lineStyle: 0 }]);
        setCrosshairInfo(null);
    }
  };

  // ===== Phase 2: SL/Target auto-exit lines =====

  // Track the active position (first one); only update state when it actually changes
  useEffect(() => {
    const readPos = () => {
      let next: any = null;
      try {
        const raw = localStorage.getItem('active_positions');
        const arr = raw ? JSON.parse(raw) : [];
        next = (Array.isArray(arr) && arr.length > 0) ? arr[0] : null;
      } catch { next = null; }
      setSlActivePos((prev: any) => {
        if (!prev && !next) return prev;
        if (prev && next && prev.symbol === next.symbol && prev.qty === next.qty) return prev;
        return next;
      });
    };
    readPos();
    window.addEventListener('active_positions_updated', readPos);
    window.addEventListener('storage', readPos);
    const iv = setInterval(readPos, 4000);
    return () => {
      window.removeEventListener('active_positions_updated', readPos);
      window.removeEventListener('storage', readPos);
      clearInterval(iv);
    };
  }, []);

  // Poll the server for an armed auto-exit rule on the active position
  useEffect(() => {
    if (!slActivePos) { setSlArmedRule(null); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/exit-rules');
        const data = await res.json();
        if (cancelled) return;
        const rule = (data?.rules || []).find((r: any) => r.tradingsymbol === slActivePos.symbol && r.status === 'ACTIVE');
        setSlArmedRule(rule || null);
      } catch { /* ignore */ }
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [slActivePos]);

  // Create / destroy the two draggable lines for the active position
  useEffect(() => {
    if (!slActivePos) { setSlPanelOpen(false); return; }
    setSlPanelOpen(true);
    const ensure = () => {
      const s = mainSeriesRef.current;
      if (!s) return;
      if (slLinesRef.current.length > 0) {
        if (slSeriesRef.current === s) return; // lines already exist on the current series
        // Series was recreated (timeframe/symbol change). The old price lines are orphaned
        // with the removed series, so drop the stale entries and rebuild on the new series.
        slLinesRef.current = [];
      }
      const cd = chartDataRef.current;
      const candles = cd?.candles || [];
      const spot = cd?.spot || (candles.length ? candles[candles.length - 1].close : 0);
      if (!spot) return;

      let upper: number, lower: number;
      if (slArmedRule) {
        // Restore from an existing armed rule
        const isLong = slArmedRule.trail_dir === 'LONG';
        const upVal = slArmedRule.trail_enabled ? (isLong ? slArmedRule.target_price : slArmedRule.spot_upper) : slArmedRule.spot_upper;
        const loVal = slArmedRule.trail_enabled ? (slArmedRule.trail_dir === 'SHORT' ? slArmedRule.target_price : slArmedRule.spot_lower) : slArmedRule.spot_lower;
        upper = upVal || Math.round(spot * 1.01);
        lower = loVal || Math.round(spot * 0.99);
      } else {
        // Defaults: STOP = previous candle low (bullish) / high (bearish);
        //           TARGET = nearest chart level in the profit direction (H-level / 50% / PDH-PDL / S-R)
        const prev = candles.length >= 2 ? candles[candles.length - 2] : (candles.length ? candles[candles.length - 1] : null);
        const levels = chartLevelsRef.current || [];
        let stopLevel: number, targetLevel: number;
        if (slIsBullish) {
          // CALL: stop sits below spot. Default = previous candle low; if that low is above spot, use spot − 15.
          const prevLow = prev && typeof prev.low === 'number' ? prev.low : null;
          stopLevel = prevLow !== null
            ? (prevLow > spot ? Math.round(spot - 15) : Math.round(prevLow))
            : Math.round(spot * 0.99);
          const above = levels.filter(v => v > spot + 1).sort((a, b) => a - b);
          targetLevel = above.length ? above[0] : Math.round(spot * 1.01);
          upper = targetLevel; lower = stopLevel;
        } else {
          // PUT: stop sits above spot. Default = previous candle high; if that high is below spot, use spot + 15.
          const prevHigh = prev && typeof prev.high === 'number' ? prev.high : null;
          stopLevel = prevHigh !== null
            ? (prevHigh < spot ? Math.round(spot + 15) : Math.round(prevHigh))
            : Math.round(spot * 1.01);
          const below = levels.filter(v => v < spot - 1).sort((a, b) => b - a);
          targetLevel = below.length ? below[0] : Math.round(spot * 0.99);
          upper = stopLevel; lower = targetLevel;
        }
      }

      const uInst = s.createPriceLine({ price: upper, color: '#f43f5e', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: '' });
      const lInst = s.createPriceLine({ price: lower, color: '#10b981', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: '' });
      // For bullish: upper = TARGET, lower = SL (stop). For bearish: mirrored.
      slLinesRef.current = [
        { kind: 'upper', price: upper, instance: uInst, label: slIsBullish ? 'TARGET' : 'SL', color: '#f43f5e' },
        { kind: 'lower', price: lower, instance: lInst, label: slIsBullish ? 'SL' : 'TARGET', color: '#10b981' },
      ];
      slSeriesRef.current = s; // remember which series these lines belong to (for recreation detection)
      setSlLevels({ upper, lower });
    };
    ensure();
    const iv = setInterval(ensure, 1000);
    return () => {
      clearInterval(iv);
      const s = mainSeriesRef.current;
      slLinesRef.current.forEach(l => { try { s && s.removePriceLine(l.instance); } catch {} });
      slLinesRef.current = [];
      slSeriesRef.current = null;
    };
  }, [slActivePos]);

  // When an armed rule is (re)discovered, snap the lines + panel to its values
  useEffect(() => {
    if (!slArmedRule || slLinesRef.current.length === 0) return;
    const u = slLinesRef.current.find(l => l.kind === 'upper');
    const lo = slLinesRef.current.find(l => l.kind === 'lower');
    const isLong = slArmedRule.trail_dir === 'LONG';
    const isShort = slArmedRule.trail_dir === 'SHORT';
    const upperVal = slArmedRule.trail_enabled ? (isLong ? slArmedRule.target_price : slArmedRule.spot_upper) : slArmedRule.spot_upper;
    const lowerVal = slArmedRule.trail_enabled ? (isShort ? slArmedRule.target_price : slArmedRule.spot_lower) : slArmedRule.spot_lower;
    if (u && upperVal) { u.price = upperVal; try { u.instance.applyOptions({ price: upperVal }); } catch {} }
    if (lo && lowerVal) { lo.price = lowerVal; try { lo.instance.applyOptions({ price: lowerVal }); } catch {} }
    setSlLevels({ upper: upperVal || (u ? u.price : null), lower: lowerVal || (lo ? lo.price : null) });
    setSlStopMode(slArmedRule.stop_mode === 'TOUCH' ? 'TOUCH' : 'CLOSE');
    setSlTargetMode(slArmedRule.target_mode === 'TOUCH' ? 'TOUCH' : 'CLOSE');
    setSlRsiLower(slArmedRule.rsi_lower ? String(slArmedRule.rsi_lower) : '');
    setSlRsiUpper(slArmedRule.rsi_upper ? String(slArmedRule.rsi_upper) : '');
    setSlTrail(!!slArmedRule.trail_enabled);
    setSlTrailCandles(slArmedRule.trail_candles ? String(slArmedRule.trail_candles) : '3');
  }, [slArmedRule?.id]);

  const armSlRule = async () => {
    if (!slActivePos) return;
    const upper = slLevels.upper, lower = slLevels.lower;
    const rl = slRsiLower ? parseFloat(slRsiLower) : null;
    const ru = slRsiUpper ? parseFloat(slRsiUpper) : null;
    if (!upper && !lower && !rl && !ru) { toast.error('Set at least one level before arming.'); return; }

    // Unified model: one line is the STOP (loss side), the other is the TARGET (profit side)
    const trailDir: 'LONG' | 'SHORT' = slIsBullish ? 'LONG' : 'SHORT';
    const stopPrice = slIsBullish ? (lower || null) : (upper || null);   // loss side
    const targetPrice = slIsBullish ? (upper || null) : (lower || null); // profit side
    const spotLower = slIsBullish ? stopPrice : null;  // bullish stop = lower line
    const spotUpper = slIsBullish ? null : stopPrice;  // bearish stop = upper line
    const trailEnabled = slTrail;
    if (!stopPrice && !rl && !ru) { toast.error('Set the stop line before arming.'); return; }

    setSlSaving(true);
    try {
      const res = await fetch('/api/exit-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradingsymbol: slActivePos.symbol,
          exchange: 'NFO',
          qty: slActivePos.qty,
          product: slActivePos.product || 'NRML',
          positionSide: slActivePos.side,
          spotLower, spotUpper,
          spotMode: slStopMode, // legacy/compat
          stopMode: slStopMode,
          targetMode: slTargetMode,
          rsiLower: rl,
          rsiUpper: ru,
          timeframe: timeframe || '5',
          trailEnabled,
          trailCandles: parseInt(slTrailCandles, 10) || 3,
          targetPrice,
          trailDir,
        })
      });
      const data = await res.json();
      if (data?.success) {
        toast.success(`Auto-exit armed for ${slActivePos.symbol}`, {
          description: `Stop ${stopPrice || '\u2014'} (${slStopMode === 'CLOSE' ? 'close' : 'touch'}) \u00B7 Target ${targetPrice || '\u2014'} (${slTargetMode === 'CLOSE' ? 'close' : 'touch'})${trailEnabled ? ` \u2192 ${parseInt(slTrailCandles, 10) || 3}-candle trail` : ''}`
        });
        setSlArmedRule({ id: data.id, tradingsymbol: slActivePos.symbol, spot_upper: spotUpper, spot_lower: spotLower, stop_mode: slStopMode, target_mode: slTargetMode, spot_mode: slStopMode, rsi_lower: rl, rsi_upper: ru, trail_enabled: trailEnabled ? 1 : 0, trail_candles: parseInt(slTrailCandles, 10) || 3, target_price: targetPrice, trail_dir: trailDir, status: 'ACTIVE' });
      } else {
        toast.error('Could not arm auto-exit', { description: data?.error || 'Unknown error' });
      }
    } catch (e: any) {
      toast.error('Could not arm auto-exit', { description: e?.message || String(e) });
    } finally { setSlSaving(false); }
  };

  const cancelSlRule = async () => {
    if (!slArmedRule?.id) { setSlArmedRule(null); return; }
    setSlSaving(true);
    try {
      await fetch(`/api/exit-rules/${slArmedRule.id}`, { method: 'DELETE' });
      setSlArmedRule(null);
      toast.success('Auto-exit cancelled');
    } catch (e: any) {
      toast.error('Could not cancel', { description: e?.message || String(e) });
    } finally { setSlSaving(false); }
  };

  const resolveStrikeDetails = async (action: 'BUY' | 'SELL', optionType: 'CE' | 'PE', strikePrice: number, targetExpiry?: string) => {
    setIsProcessingStrikeAction(true);
    
    // Determine the symbol and rounding rules
    const sym = currentSymbol.toUpperCase();
    let strikeInterval = 50;
    if (sym.includes('BANKNIFTY') || sym.includes('BANK')) {
      strikeInterval = 100;
    } else if (sym.includes('FINNIFTY')) {
      strikeInterval = 50;
    } else {
      strikeInterval = 50;
    }
    
    // Round to nearest target strike
    const targetStrike = Math.round(strikePrice / strikeInterval) * strikeInterval;
    
    try {
      // Find instrument: fetch live option chain
      const spotParam = lastSpotValue ? `&spot=${lastSpotValue}` : "";
      const expiryParam = targetExpiry ? `&expiry=${targetExpiry}` : "";
      const res = await fetch(`/api/option-chain?symbol=${encodeURIComponent(currentSymbol)}${spotParam}${expiryParam}`);
      if (!res.ok) throw new Error("Could not fetch option chain details");
      const chainData = await res.json();
      
      // Determine the best available strike from strikes array
      let bestStrike = targetStrike;
      if (chainData && chainData.strikes && chainData.strikes.length > 0) {
        if (!chainData.strikes.includes(targetStrike)) {
          bestStrike = chainData.strikes.reduce((prev: number, curr: number) => {
            return Math.abs(curr - targetStrike) < Math.abs(prev - targetStrike) ? curr : prev;
          });
        }
      }
      
      const optionMap = optionType === 'CE' ? chainData.ceData : chainData.peData;
      const contract = optionMap && optionMap[bestStrike];
      
      if (!contract) {
        toast.error(`No matching option contract found for ${bestStrike} ${optionType}`);
        return;
      }
      
      // Determine lot size from Kite Instrument Master
      const lotSize = (contract && contract.lot_size) ? contract.lot_size : undefined;
      
      // Prefill and open order ticket
      setTicketData({
        action: action,
        optionType: optionType,
        underlying: currentSymbol,
        expiry: chainData.expiryDate || targetExpiry || new Date().toISOString().split('T')[0],
        strike: bestStrike,
        tradingsymbol: contract.tradingsymbol || `${currentSymbol} ${bestStrike} ${optionType}`,
        instrument_token: contract.instrument_token ? String(contract.instrument_token) : "",
        ltp: contract.ltp || 0,
        lotSize: lotSize,
        quantity: lotSize || 0, // default is 1 lot
        product: 'NRML',
        orderType: 'MARKET',
        limitPrice: contract.ltp || 0,
        exchange: contract.exchange,
        segment: contract.segment,
        source_of_lot_size: contract.source_of_lot_size
      });

      if (chainData.expiries && chainData.expiries.length > 0) {
        setAvailableExpiries(chainData.expiries);
      } else if (targetExpiry) {
        setAvailableExpiries([targetExpiry]);
      }
      
      setShowOrderTicket(true);
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || "Error processing strike selection");
    } finally {
      setIsProcessingStrikeAction(false);
    }
  };

  const handleStrikeAction = async (action: 'BUY' | 'SELL', optionType: 'CE' | 'PE', clickedPrice: number) => {
    setClickMenu(null);
    await resolveStrikeDetails(action, optionType, clickedPrice);
  };

  const handleExitAllTrades = async () => {
    if (activePositions.length === 0 || isExitingAllTrades) return;
    
    setIsExitingAllTrades(true);
    const toastId = toast.loading(`Exiting all ${activePositions.length} active trade(s)...`);
    
    try {
      const positionsToExit = [...activePositions];
      let successCount = 0;
      let failCount = 0;
      let finalTotalPnl = 0;

      for (const pos of positionsToExit) {
        const oppositeAction = pos.side === 'BUY' ? 'SELL' : 'BUY';
        
        try {
          const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: oppositeAction,
              tradingsymbol: pos.symbol,
              quantity: pos.qty,
              product: 'MIS',
              orderType: 'MARKET',
              test_mode: !!pos.testMode
            })
          });

          const result = await response.json();
          if (response.ok && (result.success || result.simulated)) {
            successCount++;
            
            const finalPrice = pos.currentPrice || pos.entryPrice;
            const pnl = pos.side === 'BUY'
              ? (finalPrice - pos.entryPrice) * pos.qty
              : (pos.entryPrice - finalPrice) * pos.qty;
            finalTotalPnl += pnl;

            // Record the close in the Trade Journal (Exit-All closes via opposite orders, so it
            // doesn't pass through the server-side close path). Fire-and-forget, never blocks.
            try {
              fetch('/api/journal/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tradingsymbol: pos.symbol, exitPrice: finalPrice, pnl, reason: 'MANUAL (Exit All)' })
              }).catch(() => {});
            } catch (e) { /* ignore */ }

            try {
              const closedHistory = JSON.parse(localStorage.getItem('closed_positions_history') || '[]');
              closedHistory.unshift({
                ...pos,
                exitPrice: finalPrice,
                exitTime: new Date().toISOString(),
                pnl,
                formattedPnl: pnl >= 0 ? `+₹${pnl.toFixed(2)}` : `-₹${Math.abs(pnl).toFixed(2)}`
              });
              localStorage.setItem('closed_positions_history', JSON.stringify(closedHistory));
            } catch (err) {
              console.error(err);
            }
          } else {
            failCount++;
            console.error(`Failed to exit position ${pos.symbol}:`, result.error);
          }
        } catch (err) {
          failCount++;
          console.error(`Network error exiting position ${pos.symbol}:`, err);
        }
      }

      const currentActive = JSON.parse(localStorage.getItem('active_positions') || '[]');
      const remainingActive = currentActive.filter((item: any) => 
        !positionsToExit.slice(0, successCount).some(p => p.id === item.id)
      );
      
      const finalRemaining = failCount === 0 ? [] : remainingActive;
      localStorage.setItem('active_positions', JSON.stringify(finalRemaining));
      window.dispatchEvent(new Event('active_positions_updated'));

      if (failCount === 0) {
        toast.success(`Exited all trades successfully!`, {
          id: toastId,
          description: `All trades closed in Kite. Total P&L: ₹${finalTotalPnl.toFixed(2)}`
        });
      } else {
        toast.warning(`Exited ${successCount} trade(s) with ${failCount} failure(s).`, {
          id: toastId,
          description: `Check details. Partial P&L: ₹${finalTotalPnl.toFixed(2)}`
        });
      }

    } catch (err: any) {
      console.error(err);
      toast.error(`Failed to exit trades: ${err.message}`, { id: toastId });
    } finally {
      setIsExitingAllTrades(false);
    }
  };

  const handleExpiryChange = async (newExpiry: string) => {
    if (!ticketData) return;
    await resolveStrikeDetails(ticketData.action, ticketData.optionType, ticketData.strike, newExpiry);
  };

  const handleOrderSubmit = async (data: {
    action: 'BUY' | 'SELL';
    tradingsymbol: string;
    quantity: number;
    product: 'MIS' | 'NRML';
    orderType: 'MARKET' | 'LIMIT';
    price?: number;
  }) => {
    setIsProcessingStrikeAction(true);
    try {
      // 1. Refetch live margin to ensure values are current
      const currentPrice = data.price !== undefined ? data.price : (ticketData?.ltp || 0);
      let marginTotal = data.quantity * currentPrice;
      let marginCharges = -1; // -1 to differentiate from actual 0
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      
      try {
        const marginRes = await fetch('/api/orders/margins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
             exchange: ticketData?.exchange || 'NFO',
             tradingsymbol: data.tradingsymbol,
             quantity: data.quantity,
             transaction_type: data.action,
             product: data.product,
             order_type: data.orderType,
             price: currentPrice,
             variety: 'regular'
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (marginRes.ok) {
           const resData = await marginRes.json();
           if (resData.success && resData.responseBody) {
               marginTotal = resData.responseBody.total;
               marginCharges = resData.responseBody.charges?.total ?? -1;
           }
        }
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn("Failed to refetch live margin before order:", err);
      }
      
      // Fallback local charge calc if API fails
      if (marginCharges === -1) {
         marginCharges = calculateZerodhaCharges(data.action, data.quantity, currentPrice).total;
         console.log("Using Local Estimate for final order (Kite API unavailable).");
      }
      
      if (marginTotal + marginCharges > availBalance) {
        toast.error("Insufficient Funds for this transaction. Refetched latest margin from Kite.");
        setIsProcessingStrikeAction(false);
        return;
      }

      // 2. Place Order
      patchOrderDiagnostics({
        lastApiStatus: 'Calling',
        lastOrderPayload: JSON.stringify({...data, test_mode: testOrderMode}, null, 2)
      });

      // Build a market-context snapshot for the Trade Journal (Phase 1). Fully optional/defensive —
      // it never blocks the order; the server stores it for later AI review.
      let journalContext: any = null;
      try {
        let oiBias = 'NEUTRAL';
        if (oiData?.strikes) {
          let ceChg = 0, peChg = 0;
          oiData.strikes.forEach((s: number) => { ceChg += oiData.ceData?.[s]?.chgOi || 0; peChg += oiData.peData?.[s]?.chgOi || 0; });
          const net = peChg - ceChg; const total = Math.abs(ceChg) + Math.abs(peChg);
          const strength = total > 0 ? Math.abs(net) / total : 0;
          if (strength > 0.15 && net > 0) oiBias = 'BULLISH';
          else if (strength > 0.15 && net < 0) oiBias = 'BEARISH';
        }
        const candlesNow = chartDataRef.current?.candles || [];
        const lastCandle = candlesNow.length ? candlesNow[candlesNow.length - 1] : null;
        const lastBB = (bbDataRef.current && bbDataRef.current.length) ? bbDataRef.current[bbDataRef.current.length - 1] : null;
        journalContext = {
          optionType: ticketData?.optionType ?? null,
          strike: ticketData?.strike ?? null,
          spot: (chartDataRef.current as any)?.spot ?? null,
          timeframe,
          entryPrice: currentPrice,
          rsi: lastCandle?.rsi14 ?? null,
          bb: lastBB ? { upper: lastBB.upper, middle: lastBB.middle, lower: lastBB.lower } : null,
          oiBias,
          support: (localAnalytics as any)?.supportZone?.strikePrice ?? null,
          resistance: (localAnalytics as any)?.resistanceZone?.strikePrice ?? null,
          pdh: (pdhPdlData as any)?.pdhPrice ?? null,
          pdl: (pdhPdlData as any)?.pdlPrice ?? null,
        };
      } catch (e) { journalContext = null; }

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({...data, test_mode: testOrderMode, journal: true, context: journalContext})
      });
      const result = await res.json();
      
      patchOrderDiagnostics({
        lastApiStatus: res.ok && result.success ? 'Success' : 'Failed',
        lastOrderResponse: JSON.stringify(result, null, 2),
        lastOrderId: result.orderId,
        lastExchangeOrderId: result.exchange_order_id,
        lastOrderError: !res.ok || !result.success ? result.error || 'Failed to place order' : ''
      });

      if (!res.ok || !result.success) {
        throw new Error(result.error || "Order placement failed");
      }
      
      if (result.test_mode) {
        toast.success(`[TEST MODE] ${result.message}`);
        notificationService.add('order', `Order Executed (Test Mode)`, result.message, {
          symbol: data.tradingsymbol || 'Option Contract',
          side: data.action,
          qty: data.quantity,
          price: data.price || currentPrice,
          status: 'Test Filled',
        });
      } else if (result.simulated) {
        toast.success(`[Simulated] ${result.message}`);
        notificationService.add('order', `Order Executed (Simulated)`, result.message, {
          symbol: data.tradingsymbol || 'Option Contract',
          side: data.action,
          qty: data.quantity,
          price: data.price || currentPrice,
          status: 'Simulated Filled',
        });
      } else {
        toast.success(`Order placed successfully on Kite! ID: ${result.orderId}`);
        notificationService.add('order', `Kite Order Placed Successfully`, `Order ID ${result.orderId} filled on Kite for ${data.quantity} qty of ${data.tradingsymbol || 'Option Contract'}.`, {
          symbol: data.tradingsymbol || 'Option Contract',
          side: data.action,
          qty: data.quantity,
          price: data.price || currentPrice,
          status: 'Kite Filled',
        });
      }

      // Save details to active positions for 1-click exit!
      try {
        const activeTrade = {
          id: result.orderId || `ORD-${Date.now()}`,
          symbol: data.tradingsymbol || 'Option Contract',
          side: data.action,
          qty: data.quantity,
          entryPrice: data.price || currentPrice,
          currentPrice: data.price || currentPrice,
          optionType: ticketData?.optionType || (data.tradingsymbol.endsWith('CE') ? 'CE' : data.tradingsymbol.endsWith('PE') ? 'PE' : undefined),
          strike: ticketData?.strike,
          timestamp: new Date().toISOString(),
          testMode: !!result.test_mode
        };
        const currentActive = JSON.parse(localStorage.getItem('active_positions') || '[]');
        currentActive.unshift(activeTrade);
        localStorage.setItem('active_positions', JSON.stringify(currentActive));
        window.dispatchEvent(new Event('active_positions_updated'));
      } catch (e) {
        console.error("Failed to append active position:", e);
      }

      // Update simulated available balance only if not in test mode
      if (!result.test_mode) {
        setAvailBalance(prev => {
          let next = prev;
          if (data.action === 'BUY') {
            next = prev - (marginTotal + marginCharges);
          } else {
             // when selling simulation, it adds reqAmount back? Actually Kite deducts margin or adds premium.
             // Leaving basic logic to not break it
            next = prev + (data.quantity * currentPrice) - marginCharges;
          }
          try {
            localStorage.setItem('kite_sim_balance', next.toFixed(2));
          } catch (e) {}
          return next;
        });
      }

      // Draw horizontal line on price chart for ATM selection ONLY AFTER SUCCESSFUL PLACEMENT
      if (ticketData) {
        setSelectedStrikeOnChart({
          strike: ticketData.strike,
          tradingsymbol: ticketData.tradingsymbol,
          optionType: ticketData.optionType
        });
      }

      setShowOrderTicket(false);
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || "Could not place option trade");
    } finally {
      setIsProcessingStrikeAction(false);
    }
  };

  const instrumentToken = selectedInstrument ? String(selectedInstrument.instrument_token) : "256265";
  const { data: taInfo, isLoading: isLoadingTa, isError: isTaError, error: taError } = useQuery({
    queryKey: ["ta-data-live-chart", timeframe, instrumentToken],
    queryFn: async () => {
      const res = await fetch(`/api/ta?timeframe=${timeframe}&token=${instrumentToken}&symbol=${encodeURIComponent(selectedInstrument ? selectedInstrument.tradingsymbol : "NIFTY 50")}`);
      if (!res.ok) {
        if (res.status === 429) {
          throw Object.assign(new Error("Rate Limit Exceeded"), { status: 429 });
        }
        throw new Error("Network error");
      }
      return res.json();
    },
    // Fetch periodically while visible to sync indicator bias with dashboard
    // using false here and manual update interval below to prevent chart full redraws
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: 10 * 1000,
    gcTime: 10 * 60000,
    enabled: Boolean(timeframe && instrumentToken)
  });

  const { data: liveTa } = useQuery({
    queryKey: ["ta-data-decision", timeframe, instrumentToken],
    queryFn: async () => {
      const res = await fetch(`/api/ta?timeframe=${timeframe}&token=${instrumentToken}&symbol=${encodeURIComponent(selectedInstrument ? selectedInstrument.tradingsymbol : "NIFTY 50")}`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 10000,
    enabled: Boolean(timeframe && instrumentToken)
  });

  const currentSymbol = selectedInstrument ? selectedInstrument.tradingsymbol : "NIFTY 50";
  const lastSpotValue = taInfo && taInfo.candles && taInfo.candles.length > 0 
    ? taInfo.candles[taInfo.candles.length - 1].close 
    : undefined;

  const { data: oiData } = useQuery({
    queryKey: ["oi-data", currentSymbol, lastSpotValue],
    queryFn: async () => {
      const spotParam = lastSpotValue ? `&spot=${lastSpotValue}` : "";
      const res = await fetch(`/api/option-chain?symbol=${encodeURIComponent(currentSymbol)}${spotParam}`);
      if (!res.ok) throw new Error("Network error");
      return res.json();
    },
    refetchInterval: () => document.visibilityState === 'visible' ? 10 * 1000 : false,
    staleTime: 30000,
    gcTime: 10 * 60000,
  });

  const { data: pulseBias } = useQuery({
    queryKey: ["premium-pulse-bias"],
    queryFn: async () => {
      const res = await fetch(`/api/premium-pulse/bias`);
      return res.json();
    },
    refetchInterval: () => document.visibilityState === 'visible' ? 60 * 1000 : false,
    staleTime: 45000,
    gcTime: 10 * 60000,
  });

  const { data: fiiDiiData } = useQuery({
    queryKey: ["fii-dii"],
    queryFn: async () => {
      const res = await fetch("/api/fii-dii");
      if (!res.ok) throw new Error("Network error");
      return res.json();
    },
    refetchInterval: () => document.visibilityState === 'visible' ? 10 * 1000 : false,
  });

  const oiHistoryRef = useRef<{ current: any, prev: any }>({ current: null, prev: null });

  useEffect(() => {
    if (oiData && oiData !== oiHistoryRef.current.current) {
      const prev = oiHistoryRef.current.current; // previous snapshot (before we overwrite it)
      if (prev && prev.ceData && prev.peData && oiData.strikes) {
        const now = Date.now();
        oiData.strikes.forEach((strike: number) => {
          const curC = oiData.ceData[strike]?.oi || 0;
          const curP = oiData.peData[strike]?.oi || 0;
          const prevC = prev.ceData[strike]?.oi || 0;
          const prevP = prev.peData[strike]?.oi || 0;
          if (!oiGlowRef.current[strike]) oiGlowRef.current[strike] = { call: 0, put: 0 };
          if (curC > prevC + 0.01) oiGlowRef.current[strike].call = now; // call OI grew
          if (curP > prevP + 0.01) oiGlowRef.current[strike].put = now;  // put OI grew
        });
      }
      oiHistoryRef.current.prev = oiHistoryRef.current.current;
      oiHistoryRef.current.current = oiData;
    }
  }, [oiData]);

  const localAnalytics = useMemo(() => {
    if (!oiData || !oiData.strikes || !oiData.ceData || !oiData.peData) return null;
    let totalCeOi = 0; let totalPeOi = 0;
    oiData.strikes.forEach((strike: number) => {
      totalCeOi += oiData.ceData[strike]?.oi || 0;
      totalPeOi += oiData.peData[strike]?.oi || 0;
    });
    const pcr = totalPeOi / (totalCeOi || 1);
    
    const topCe = [...oiData.strikes].map((k: number) => oiData.ceData[k]).filter(Boolean).sort((a: any, b: any) => b.oi - a.oi).slice(0,5);
    const topPe = [...oiData.strikes].map((k: number) => oiData.peData[k]).filter(Boolean).sort((a: any, b: any) => b.oi - a.oi).slice(0,5);

    const resistanceZone = topCe.find((c: any) => c.strikePrice >= oiData.spot) || topCe[0] || { strikePrice: oiData.spot };
    const supportZone = topPe.find((p: any) => p.strikePrice <= oiData.spot) || topPe[0] || { strikePrice: oiData.spot };

    return { spot: oiData.spot, supportZone, resistanceZone, pcr, totalCeOi, totalPeOi };
  }, [oiData]);

  const decision = useMemo(() => {
     if (!localAnalytics || (!liveTa && !taInfo)) return null;
     return computeMasterSignal(localAnalytics, liveTa || taInfo, fiiDiiData);
  }, [localAnalytics, liveTa, taInfo, fiiDiiData]);

  const [lastTickMessage, setLastTickMessage] = useState<string>('');
  const lastTickAtRef = useRef(0); // ms timestamp of the last live tick (to know when ticks are fresh)

  // Enforce ONLY the active selected instrument receives dynamic WS price updates
  // Directly updates the lightweight chart series, avoiding full component teardowns/re-renders
  useEffect(() => {
    if (!currentSymbol) return;

    lastCandleTimeRef.current = null;
    lastCandleDataRef.current = null;

    // 1. Subscribe ONLY the active symbol
    subscribeToTicks(currentSymbol);

    // 2. Map high-performance instant tick update to chart instance
    const removeListener = addWsMessageListener((msg) => {
      // Keep track of the server's time compared to our local PC clock
      if (msg && msg.timestamp) {
        let serverSec = 0;
        if (typeof msg.timestamp === 'number') {
          serverSec = msg.timestamp > 1_000_000_000_000 ? Math.floor(msg.timestamp / 1000) : msg.timestamp;
        } else if (typeof msg.timestamp === 'string') {
          serverSec = Math.floor(new Date(msg.timestamp).getTime() / 1000);
        }
        if (serverSec > 0) {
          serverTimeOffsetRef.current = serverSec - Math.floor(Date.now() / 1000);
        }
      }

      const normalize = (s: string) => s.replace(/^(NSE:|BSE:|NFO:)/, '').trim();
      const msgSym = msg.symbol;
      const isMatch = msg.type === "tick" && normalize(msgSym) === normalize(currentSymbol);

      if (isMatch) {
        setLastTickMessage(`${msgSym}: ${msg.candle.close.toFixed(2)}`);
        if (mainSeriesRef.current && msg.candle) {
          const tfMin = parseInt(timeframe) || 5;
          // Synchronize time calculations using the high-precision server/exchange clock
          const tickTime = msg.timestamp || (Math.floor(Date.now() / 1000) + serverTimeOffsetRef.current);
          
          // Ignore incoming ticks when the market is closed (with 2-minute settlement buffer)
          const ist = getIstDateTime(tickTime);
          const isWeekend = ist.dayOfWeek === 0 || ist.dayOfWeek === 6;
          const isStaleAfterHours = ist.timeOfDaySec >= MARKET_CLOSE_SECONDS_IST + 120 || ist.timeOfDaySec < MARKET_OPEN_SECONDS_IST;
          
          if (isWeekend || isStaleAfterHours) {
            return;
          }

          const updateTime = getMarketAlignedCandleStart(tickTime, tfMin);

          if (lastCandleTimeRef.current !== null) {
            if (updateTime < lastCandleTimeRef.current) {
              // Ignore outdated tick that is older than our last advanced candle
              return;
            }
          }

          const currentChartData = chartDataRef.current;
          const seededLastCandle = lastCandleDataRef.current ||
            (currentChartData?.candles?.length ? currentChartData.candles[currentChartData.candles.length - 1] : null);

          let updatedCandle;
          const sameCandle = !!(seededLastCandle && seededLastCandle.time === updateTime);
          if (seededLastCandle && seededLastCandle.time === updateTime) {
            updatedCandle = {
              time: updateTime,
              open: seededLastCandle.open,
              high: Math.max(seededLastCandle.high, msg.candle.close),
              low: Math.min(seededLastCandle.low, msg.candle.close),
              close: msg.candle.close,
              rsi14: seededLastCandle.rsi14,
            };
          } else {
            const prevClose = seededLastCandle ? seededLastCandle.close : msg.candle.close;
            updatedCandle = {
              time: updateTime,
              open: prevClose,
              high: Math.max(prevClose, msg.candle.close),
              low: Math.min(prevClose, msg.candle.close),
              close: msg.candle.close,
              rsi14: seededLastCandle ? seededLastCandle.rsi14 : undefined
            };
            lastCandleTimeRef.current = updateTime;
          }
          lastCandleDataRef.current = updatedCandle;
          lastTickAtRef.current = Date.now();

          try {
            mainSeriesRef.current.update(updatedCandle);
            setWsError(''); // Clear error on successful tick processing
          } catch(e: any) {
            setWsError(`WS TICK ERR: ${e.message} (t=${updateTime}, last=${lastCandleDataRef.current?.time})`);
          }

          // Live RSI + SMA: keep a rolling closes buffer and recompute (Wilder's) each tick
          // so both the RSI line and its SMA track the live premium, like Zerodha.
          try {
            const closes = rsiClosesRef.current;
            if (closes && closes.length > 0) {
              if (sameCandle) {
                closes[closes.length - 1] = updatedCandle.close; // update forming candle
              } else {
                closes.push(updatedCandle.close); // a new candle started
                if (closes.length > 500) closes.shift();
              }
              const rsiArr = computeRsiArray(closes, 14);
              const liveRsi = rsiArr[rsiArr.length - 1];
              if (rsiSeriesRef.current && typeof liveRsi === 'number') {
                rsiSeriesRef.current.update({ time: updateTime, value: liveRsi });
              }
              if (rsiSmaSeriesRef.current && rsiArr.length >= 14) {
                const last14 = rsiArr.slice(-14);
                const avg = last14.reduce((s, v) => s + v, 0) / 14;
                rsiSmaSeriesRef.current.update({ time: updateTime, value: avg });
              }
            }
          } catch (e) { /* RSI is display-only; never block price updates */ }
        }
      }
    });

    return () => {
      removeListener();
    };
  }, [currentSymbol, timeframe]);

  // Bug 1 Fix: Background poll for historical REST data but inject it as updates 
  // instead of rebuilding the chart via chartData (use refetchInterval: false above).
  useEffect(() => {
    if (!currentSymbol || !instrumentToken || !timeframe) return;
    
    let isCancelled = false;
    const tfMin = parseInt(timeframe) || 5;

    const interval = setInterval(async () => {
      // Skip background polling if market is closed
      const now = Math.floor(Date.now() / 1000) + serverTimeOffsetRef.current;
      if (!isMarketOpen(now)) {
        return;
      }

      try {
        const res = await fetch(`/api/ta?timeframe=${timeframe}&token=${instrumentToken}&symbol=${encodeURIComponent(currentSymbol)}`);
        if (!res.ok) return;
        const data = await res.json();
        
        if (!isCancelled && data && data.candles && data.candles.length > 0 && mainSeriesRef.current) {
           const latestCandle = data.candles[data.candles.length - 1];
           const updateTime = getMarketAlignedCandleStart(toUnixSeconds(latestCandle.time), tfMin);

           if (lastCandleTimeRef.current !== null && updateTime < lastCandleTimeRef.current) {
             return; // Older than tick
           }

           const live = lastCandleDataRef.current;
           const ticksFresh = (Date.now() - lastTickAtRef.current) < 10000;
           let updatedCandle;
           if (live && live.time === updateTime && ticksFresh) {
             // Same forming candle, live ticks still flowing: keep the live OHLC.
             // The 15s server snapshot lags the ticks, so don't let it retract the
             // tick-extended high/low or reset the live close (that caused the jump vs Zerodha/TV).
             updatedCandle = {
               time: updateTime,
               open: live.open,
               high: Math.max(live.high, latestCandle.high),
               low: Math.min(live.low, latestCandle.low),
               close: live.close,
               rsi14: latestCandle.rsi14, // server RSI is authoritative
             };
           } else {
             // A new/closed candle, or ticks are stale: trust the server snapshot fully.
             updatedCandle = {
               time: updateTime,
               open: latestCandle.open,
               high: latestCandle.high,
               low: latestCandle.low,
               close: latestCandle.close,
               rsi14: latestCandle.rsi14,
             };
           }
           lastCandleTimeRef.current = updateTime;
           lastCandleDataRef.current = updatedCandle;
           mainSeriesRef.current.update(updatedCandle);

           if (volumeSeriesRef.current) {
             const vol = latestCandle.volume || 0; // real volume only (NIFTY uses current-month futures volume)
             volumeSeriesRef.current.update({
               time: updateTime,
               value: vol,
               color: latestCandle.close >= latestCandle.open ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'
             });
           }

           if (rsiSeriesRef.current && latestCandle.rsi14 !== undefined) {
             rsiSeriesRef.current.update({
               time: updateTime,
               value: latestCandle.rsi14,
             });
           }

           // Keep the live closes buffer aligned with the close we actually drew
           if (rsiClosesRef.current.length > 0) {
             rsiClosesRef.current[rsiClosesRef.current.length - 1] = updatedCandle.close;
           }
           // Refresh the SMA from server-computed RSI values (authoritative, every 15s)
           if (rsiSmaSeriesRef.current && data.candles.length >= 14) {
             const last14 = data.candles.slice(-14);
             if (last14.every((c: any) => typeof c.rsi14 === 'number')) {
               const avg = last14.reduce((s: number, c: any) => s + c.rsi14, 0) / 14;
               rsiSmaSeriesRef.current.update({ time: updateTime, value: avg });
             }
           }
        }
      } catch(e) {
        // ignore fetch error on background interval
      }
    }, 15000); // 15s keeps real Kite OHLC fresh

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [currentSymbol, instrumentToken, timeframe]);

  useEffect(() => {
    if (isTaError && (taError as any)?.status === 429) {
      toast.error("Rate limit exceeded from trading provider. Will retry automatically.");
    }
  }, [isTaError, taError]);

  const isLoading = isLoadingTa;

  useEffect(() => {
    const isNifty50 = !selectedInstrument || selectedInstrument.tradingsymbol === "NIFTY 50";
    if (taInfo && taInfo.rawTop5 && isNifty50) {
      console.log("[NIFTY DIAGNOSTIC] === RAW DATA DUMP (NIFTY 50) ===");
      console.log("[NIFTY DIAGNOSTIC] Selected Instrument Metadata:", {
        trading_symbol: selectedInstrument?.tradingsymbol || "NIFTY 50",
        exchange: selectedInstrument?.exchange || "NSE",
        instrument_token: instrumentToken,
        instrument_type: selectedInstrument?.instrument_type || "EQ",
        segment: (selectedInstrument as any)?.segment || "INDICES",
      });
      console.log("[NIFTY DIAGNOSTIC] First 5 Raw Candles from Kite:", taInfo.rawTop5);
      console.log("[NIFTY DIAGNOSTIC] Raw Volume Field (Candle 0):", taInfo.rawTop5[0]?.volume);
      console.log("[NIFTY DIAGNOSTIC] ================================");
    }
  }, [taInfo, selectedInstrument, instrumentToken]);

  const chartData = useMemo(() => {
    if (!taInfo || !taInfo.candles) return null;
    
    // De-duplicate and sort
    const uniqueCandles: any[] = [];
    const seen = new Set();
    for (const c of taInfo.candles) {
      // Kite candle timestamps or our server timestamps
      const timeSec = getMarketAlignedCandleStart(toUnixSeconds(c.time), parseInt(timeframe, 10) || 5);
      if (!seen.has(timeSec)) {
        seen.add(timeSec);
        uniqueCandles.push({
          ...c,
          time: timeSec, // Override time with unix seconds
          volume: c.volume || 0 // real volume only (NIFTY uses current-month futures volume)
        });
      }
    }
    uniqueCandles.sort((a, b) => a.time - b.time);

    return {
      candles: uniqueCandles,
      spot: taInfo.spot,
    };
  }, [taInfo, timeframe]);

  useEffect(() => {
    chartDataRef.current = chartData;
    const latest = chartData?.candles?.[chartData.candles.length - 1];
    if (!latest) return;
    if (lastCandleTimeRef.current === null || latest.time > lastCandleTimeRef.current) {
      lastCandleTimeRef.current = latest.time;
      lastCandleDataRef.current = latest;
    }
  }, [chartData]);

  const divergences = useMemo(() => {
    if (!chartData || !chartData.candles || parseInt(timeframe) < 15) return [];
    return getDivergences(chartData.candles, 7, 3, timeframe);
  }, [chartData, timeframe]);

  const pdhPdlData = useMemo(() => {
    if (!showPdhPdl || !chartData || !chartData.candles || chartData.candles.length === 0) {
      return { pdhPrice: null, pdlPrice: null, pStartTime: null };
    }
    const candles = chartData.candles;
    const currentCandle = candles[candles.length - 1];
    const currentDateStr = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(currentCandle.time * 1000));
    
    let prevDayStr: string | null = null;
    let pHigh = -Infinity;
    let pLow = Infinity;
    let pStartTime: number | null = null;
    
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      const cDateStr = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(c.time * 1000));
      
      if (cDateStr !== currentDateStr) {
        if (!prevDayStr) {
           prevDayStr = cDateStr;
        }
        
        if (cDateStr === prevDayStr) {
           if (c.high > pHigh) pHigh = c.high;
           if (c.low < pLow) pLow = c.low;
           pStartTime = c.time;
        } else {
           break;
        }
      }
    }
    
    if (prevDayStr && pHigh !== -Infinity) {
      return { pdhPrice: pHigh, pdlPrice: pLow, pStartTime };
    }
    return { pdhPrice: null, pdlPrice: null, pStartTime: null };
  }, [chartData, showPdhPdl]);

  // Collect every chart level (H-levels, their 50% midpoints, PDH/PDL, OI support/resistance)
  // so the SL/Target tool can default the target to the nearest upcoming level.
  useEffect(() => {
    const levels: number[] = [];
    (hLevels || []).forEach(v => { if (v > 0) levels.push(v); });
    const active = (hLevels || []).filter(v => v > 0).sort((a, b) => b - a);
    for (let i = 0; i < active.length - 1; i++) levels.push(Math.round((active[i] + active[i + 1]) / 2));
    if (pdhPdlData?.pdhPrice) levels.push(pdhPdlData.pdhPrice);
    if (pdhPdlData?.pdlPrice) levels.push(pdhPdlData.pdlPrice);
    if (localAnalytics?.supportZone?.strikePrice) levels.push(localAnalytics.supportZone.strikePrice);
    if (localAnalytics?.resistanceZone?.strikePrice) levels.push(localAnalytics.resistanceZone.strikePrice);
    chartLevelsRef.current = levels.filter(v => typeof v === 'number' && v > 0);
  }, [hLevels, pdhPdlData, localAnalytics]);

  const bbData = useMemo(() => {
    if (!chartData || !chartData.candles || !showBB) return [];
    return calculateBollingerBands(chartData.candles, bbPeriod, bbStdDev);
  }, [chartData, showBB, bbPeriod, bbStdDev]);

  // Live BB plumbing: the series above are seeded from closed candles, but must extend to the
  // forming candle on every tick (otherwise the bands freeze at the last server candle).
  const bbUpperSeriesRef = useRef<any>(null);
  const bbMiddleSeriesRef = useRef<any>(null);
  const bbLowerSeriesRef = useRef<any>(null);
  const bbDataRef = useRef<any[]>([]); // latest live BB (incl. forming candle) for the canvas fill
  const bbSigRef = useRef<string>(''); // change-signature so we only recompute when the candle moves

  const lastAlertedDivergenceRef = useRef<string | null>(null);

  useEffect(() => {
    if (divergences.length > 0) {
      const latestDiv = divergences[divergences.length - 1];
      const divKey = `${timeframe}-${latestDiv.type}-${latestDiv.p1.time}-${latestDiv.p2.time}`;
      
      if (lastAlertedDivergenceRef.current !== divKey) {
        lastAlertedDivergenceRef.current = divKey;

        toast(`⚠️ NEW DIVERGENCE DETECTED`, {
          description: (
            <div className="font-mono mt-1 space-y-1">
              <div className="font-bold text-foreground">
                {latestDiv.type === "bullish" ? "Bullish" : "Bearish"} Divergence
              </div>
              <div className="text-muted-foreground mt-2">
                A valid {latestDiv.type} divergence has just formed on the {timeframe}m chart.
              </div>
            </div>
          ),
          duration: 10000,
          closeButton: true,
        });

        notificationService.add(
          "divergence",
          `${latestDiv.type === "bullish" ? "Bullish" : "Bearish"} Divergence Formed`,
          `A valid ${latestDiv.type} divergence has formed on the ${timeframe}m chart.`,
          {
            divType: latestDiv.type,
            timeframe,
          }
        );
      }
    }
  }, [divergences, timeframe]);

  const lastAlertedFiftyPercentLevelRef = useRef<{ level: number, time: number } | null>(null);

  useEffect(() => {
    if (!showFiftyPercentLevels || !hLevels || hLevels.length === 0 || !chartData) return;
    
    const currentPrice = chartData.spot || (chartData.candles && chartData.candles.length > 0 ? chartData.candles[chartData.candles.length - 1].close : null);
    if (!currentPrice) return;

    const activeLevels = hLevels.filter(v => v > 0).sort((a, b) => b - a);
    const midPoints = [];
    for (let i = 0; i < activeLevels.length - 1; i++) {
      midPoints.push(Math.round((activeLevels[i] + activeLevels[i+1]) / 2));
    }

    // Use a small point distance for approaches (e.g. 5 points for indices)
    const threshold = currentPrice > 10000 ? 5 : 2;

    for (const mid of midPoints) {
      if (Math.abs(currentPrice - mid) <= threshold) {
        const now = Date.now();
        const lastAlert = lastAlertedFiftyPercentLevelRef.current;
        
        // Prevent spamming the alert for the same level within 5 minutes
        if (!lastAlert || lastAlert.level !== mid || (now - lastAlert.time > 5 * 60 * 1000)) {
          lastAlertedFiftyPercentLevelRef.current = { level: mid, time: now };
          toast(`⚠️ Approaching 50% Levels`, {
            description: `Price (${currentPrice}) is near internal H Level midpoint (${mid}).`,
            duration: 8000,
            closeButton: true,
          });

          notificationService.add(
            "system",
            `Approaching 50% Levels`,
            `Price (${currentPrice}) is near internal H Level midpoint (${mid}).`,
            { level: mid }
          );
        }
      }
    }
  }, [chartData, hLevels, showFiftyPercentLevels]);

  useEffect(() => {
    if (!chartContainerRef.current || !chartData || chartData.candles.length === 0) return;

    const VISIBLE_BARS = 55;
    const RIGHT_OFFSET = 8;

    function focusRecentCandles(chart: any, candles: any[]) {
      if (!chart || !candles || candles.length === 0) return;

      const totalBars = candles.length;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, totalBars - VISIBLE_BARS),
        to: totalBars + RIGHT_OFFSET,
      });
    }

    const commonOptions = {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#64748b',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 12,
        minBarSpacing: 6,
        tickMarkFormatter: (time: any, tickMarkType: any, locale: string) => {
          const date = new Date(time * 1000);
          
          const parts = Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }).formatToParts(date);

          const getValue = (type: string) => parts.find(p => p.type === type)?.value || '';
          const day = getValue('day');
          const month = getValue('month');
          const hour = getValue('hour');
          const minute = getValue('minute');

          const isIntraday = timeframe && parseInt(timeframe, 10) < 1440;
          if (!isIntraday) {
            switch (tickMarkType) {
              case 0: // Year
                return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(date);
              case 1: // Month
                return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'short' }).format(date);
              default:
                return `${day} ${month}`;
            }
          }

          // Intraday logic
          const hrNum = parseInt(hour, 10);
          const minNum = parseInt(minute, 10);

          if (hrNum === 9 && minNum === 30) {
            return "09:30";
          }
          if (hrNum === 9 && (minNum === 15 || minNum === 0)) {
            return `${day} ${month}`;
          }

          return `${hour}:${minute}`;
        },
      },
      localization: {
        dateFormat: 'yyyy-MM-dd',
        timeFormatter: (businessDayOrTimestamp: any) => {
          const date = new Date(businessDayOrTimestamp * 1000);
          const parts = Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Kolkata',
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          }).formatToParts(date);

          const getValue = (type: string) => parts.find(p => p.type === type)?.value || '';
          
          const weekday = getValue('weekday');
          const day = getValue('day');
          const month = getValue('month');
          const hour = getValue('hour');
          const minute = getValue('minute');
          const dayPeriod = getValue('dayPeriod').toUpperCase();

          return `${weekday} ${day} ${month}, ${hour}:${minute} ${dayPeriod}`;
        },
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      kineticScroll: {
        mouse: true,
        touch: true,
      },
    };

    // Create Main Chart
    const mainChart = createChart(chartContainerRef.current, {
      ...commonOptions,
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        autoScale: false,
      },
    });

    mainChartRef.current = mainChart;

    // Candlestick Series
    const mainSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      lastValueVisible: false,
      priceLineVisible: false,
    });

    mainSeriesRef.current = mainSeries;

    const { pdhPrice, pdlPrice, pStartTime } = pdhPdlData;

    // S&R Lines are now drawn via canvas in requestAnimationFrame

    manualLinesRef.current = [];
    manualLineIdsRef.current.forEach(line => {
      try {
        const newPriceLine = mainSeries.createPriceLine({
          price: line.price,
          color: line.color || '#facc15',
          lineWidth: line.lineWidth || 2,
          lineStyle: line.lineStyle || 0,
          axisLabelVisible: line.axisLabelVisible ?? true,
          title: line.title || '',
        });
        manualLinesRef.current.push({ ...line, instance: newPriceLine });
      } catch(e) {}
    });

    mainChart.subscribeDblClick((param) => {
      try {
        if (param.point) {
          const y = param.point.y;
          // Check manual lines first
          if (manualLinesRef.current.length > 0) {
            for (let i = 0; i < manualLinesRef.current.length; i++) {
              const lineData = manualLinesRef.current[i];
              const lineY = mainSeries.priceToCoordinate(lineData.price);
              if (lineY !== null && Math.abs(lineY - y) < 15) {
                setEditingLineId(lineData.id);
                return;
              }
            }
          }
        }
      } catch (e) {}
    });

    mainChart.subscribeClick((param) => {
      try {
        if (draggingLineRef.current) return; // Prevent click action right after dragging
        if (param.point) {
          const y = param.point.y;

          // Check PDH/PDL click
          if (showPdhPdl && pdhPrice !== null && pdlPrice !== null) {
            const pdhY = mainSeries.priceToCoordinate(pdhPrice);
            if (pdhY !== null && Math.abs(pdhY - y) < 10) {
              setIsEditingPdhPdl(true);
              return;
            }
            const pdlY = mainSeries.priceToCoordinate(pdlPrice);
            if (pdlY !== null && Math.abs(pdlY - y) < 10) {
              setIsEditingPdhPdl(true);
              return;
            }
          }

          // Default: Open the option strike selection floating menu
          const price = mainSeries.coordinateToPrice(y);
          if (price !== null && quickTradeEnabledRef.current) {
            // Open the menu near the clicked cursor coordinate
            setClickMenu({
              x: param.point.x,
              y: param.point.y,
              price: Math.round(price)
            });
          }
        }
      } catch (e) {
        // ignore Object is disposed
      }
    });

    const candleData = chartData.candles.map((c: any) => ({
      time: c.time as any,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    mainSeries.setData(candleData);
    const lastHistRaw = candleData[candleData.length - 1] || null;
    if (lastHistRaw) {
      const tfMinSeed = parseInt(timeframe) || 5;
      const alignedSeedTime = getMarketAlignedCandleStart(lastHistRaw.time, tfMinSeed);
      lastCandleTimeRef.current = alignedSeedTime;
      lastCandleDataRef.current = { ...lastHistRaw, time: alignedSeedTime };
    } else {
      lastCandleTimeRef.current = null;
      lastCandleDataRef.current = null;
    }
    
    if (logicalRangeRef.current) {
      try {
        mainChart.timeScale().setVisibleLogicalRange(logicalRangeRef.current);
      } catch (e) {}
    } else {
      focusRecentCandles(mainChart, chartData.candles);
    }

    bbUpperSeriesRef.current = null;
    bbMiddleSeriesRef.current = null;
    bbLowerSeriesRef.current = null;
    if (showBB && bbData && bbData.length > 0) {
      const upperSeries = mainChart.addSeries(LineSeries, {
        color: hexToRgba(bbColor, 0.75),
        lineWidth: 1,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        title: ''
      });
      upperSeries.setData(bbData.map(d => ({ time: d.time as any, value: d.upper })));
      bbUpperSeriesRef.current = upperSeries;

      const middleSeries = mainChart.addSeries(LineSeries, {
        color: hexToRgba(bbColor, 0.45),
        lineWidth: 1,
        lineStyle: 1, // Dashed-like thin line (Solid with 1px is very clean, or 2 for Dashed)
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        title: ''
      });
      middleSeries.setData(bbData.map(d => ({ time: d.time as any, value: d.middle })));
      bbMiddleSeriesRef.current = middleSeries;

      const lowerSeries = mainChart.addSeries(LineSeries, {
        color: hexToRgba(bbColor, 0.75),
        lineWidth: 1,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        title: ''
      });
      lowerSeries.setData(bbData.map(d => ({ time: d.time as any, value: d.lower })));
      bbLowerSeriesRef.current = lowerSeries;
    }

    // H Levels are now drawn on the canvas overlay (with pill labels) alongside PDH/PDL/SUP/RES,
    // so their RED OUTER / RED INNER / TRAP / GREEN text shows on the chart lines.

    // PDH/PDL Lines are now drawn via canvas in requestAnimationFrame

    // Volume Series
    const volumeSeries = mainChart.addSeries(HistogramSeries, {
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: '', // Overlay
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    const volumeData = chartData.candles.map((c: any) => ({
      time: c.time as any,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'
    }));
    volumeSeries.setData(volumeData);
    volumeSeriesRef.current = volumeSeries;

    // Create RSI Chart
    const rsiChart = createChart(rsiContainerRef.current, {
      ...commonOptions,
      timeScale: {
        ...commonOptions.timeScale,
        visible: false, // Hide time axis on RSI since they sync
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        autoScale: true,
      },
    });

    // Add RSI Series
    const rsiSeries = rsiChart.addSeries(LineSeries, {
      color: rsiColor,
      lineWidth: rsiLineWidth as any,
      lineStyle: rsiLineStyle as any,
      priceLineVisible: false,
      autoscaleInfoProvider: () => ({
        priceRange: {
          minValue: 0,
          maxValue: 100,
        },
      }),
    });
    
    rsiSeriesRef.current = rsiSeries;

    const rsiData = chartData.candles.map((c: any) => ({
      time: c.time as any,
      value: c.rsi14 !== undefined ? c.rsi14 : 50,
    }));
    rsiSeries.setData(rsiData);
    
    if (logicalRangeRef.current) {
      try {
        rsiChart.timeScale().setVisibleLogicalRange(logicalRangeRef.current);
      } catch (e) {}
    } else {
      focusRecentCandles(rsiChart, chartData.candles);
    }

    const rsiLevels = [
      { price: rsiOversold1, color: hexToRgba(rsiOversoldColor, 0.45) },
      { price: rsiOversold2, color: hexToRgba(rsiOversoldColor, 0.45) },
      { price: rsiOverbought1, color: hexToRgba(rsiOverboughtColor, 0.45) },
      { price: rsiOverbought2, color: hexToRgba(rsiOverboughtColor, 0.45) }
    ];

    rsiLevels.forEach(lvl => {
      rsiSeries.createPriceLine({
        price: lvl.price,
        color: lvl.color,
        lineWidth: 1,
        lineStyle: 3, // Dotted
        axisLabelVisible: true,
      });
    });

    const rsiSmaData: any[] = [];
    const rsiPeriod = 14;
    for (let i = 0; i < rsiData.length; i++) {
        if (i < rsiPeriod - 1) continue;
        let sum = 0;
        for (let j = 0; j < rsiPeriod; j++) {
            sum += rsiData[i - j].value;
        }
        rsiSmaData.push({
            time: rsiData[i].time,
            value: sum / rsiPeriod,
        });
    }

    const rsiSmaSeries = rsiChart.addSeries(LineSeries, {
        color: rsiSmaColor,
        lineWidth: rsiSmaLineWidth as any,
        lineStyle: rsiSmaLineStyle as any,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
    });
    rsiSmaSeries.setData(rsiSmaData);
    rsiSmaSeriesRef.current = rsiSmaSeries;
    // Seed the live closes buffer used for real-time RSI recomputation on ticks
    rsiClosesRef.current = chartData.candles.map((c: any) => c.close);

    // Markers for Divergences
    const markers: any[] = [];
    divergences.forEach((div: any) => {
        const time1 = div.p1.time;
        const time2 = div.p2.time;

        // Add Marker on Price Chart
        markers.push({
            time: time2 as any,
            position: div.type === 'bullish' ? 'belowBar' : 'aboveBar',
            color: div.type === 'bullish' ? '#22c55e' : '#ef4444',
            shape: div.type === 'bullish' ? 'arrowUp' : 'arrowDown',
            text: 'Div',
            size: 1,
        });

        // Draw Divergence trendline on RSI Chart
        const divLineRsi = rsiChart.addSeries(LineSeries, {
            color: div.type === 'bullish' ? '#22c55e' : '#ef4444',
            lineWidth: 2,
            lineStyle: 2, // Dashed
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });
        divLineRsi.setData([
            { time: time1 as any, value: div.p1.rsi },
            { time: time2 as any, value: div.p2.rsi },
        ]);
    });
    
    markers.sort((a, b) => a.time - b.time);
    createSeriesMarkers(mainSeries, markers);

    // Sync TimeScale
    const timeScale1 = mainChart.timeScale();
    const timeScale2 = rsiChart.timeScale();
    
    let isSyncing = false;
    timeScale1.subscribeVisibleLogicalRangeChange(range => {
      if (range !== null && !isSyncing) {
        isSyncing = true;
        try {
          timeScale2.setVisibleLogicalRange(range);
          logicalRangeRef.current = range;
          globalLogicalRangeCache[`${selectedInstrument?.instrument_token}_${timeframe}`] = range;
        } catch(e) {}
        isSyncing = false;
      }
    });
    timeScale2.subscribeVisibleLogicalRangeChange(range => {
      if (range !== null && !isSyncing) {
        isSyncing = true;
        try {
          timeScale1.setVisibleLogicalRange(range);
          logicalRangeRef.current = range;
          globalLogicalRangeCache[`${selectedInstrument?.instrument_token}_${timeframe}`] = range;
        } catch(e) {}
        isSyncing = false;
      }
    });

    // Sync Crosshair
    function getCrosshairDataPoint(series: any, param: any) {
      if (!param.time) return null;
      const data = param.seriesData.get(series);
      return data || null;
    }

    const ohlcPanel = chartContainerRef.current ? createOHLCInfoPanel(chartContainerRef.current) : null;
    if (ohlcPanel) {
      const { candle, volume } = getLatestCandle(candleData, volumeData);
      updateOHLCInfoPanel(ohlcPanel, candle, volume);
    }

    const rsiDataMap = new Map(rsiData.map((d: any) => [d.time, d.value]));

    mainChart.subscribeCrosshairMove(param => {
      if (!param.sourceEvent) return;
      try {
        let currentCandle = null;
        let currentVolume = null;

        if (!param.point || param.point.x < 0 || param.point.y < 0) {
          try { rsiChart.clearCrosshairPosition(); } catch(e) {}
          setRsiHoverValue(null);
          setTimeout(() => {
            if (!isHoveringButtonRef.current) {
               setCrosshairInfo(null);
            }
          }, 50);
        } else {
          const price = mainSeries.coordinateToPrice(param.point.y);
          if (price !== null) {
            setCrosshairInfo({ x: param.point.x, y: param.point.y, price });
          }

          if (param.time) {
            const dataPoint = getCrosshairDataPoint(mainSeries, param);
            let rVal = rsiDataMap.get(param.time) as number | undefined;
            
            if (rVal === undefined && lastCandleDataRef.current && param.time === lastCandleDataRef.current.time && lastCandleDataRef.current.rsi14 !== undefined) {
              rVal = lastCandleDataRef.current.rsi14;
            }

            if (rVal !== undefined) setRsiHoverValue(Number(rVal).toFixed(2));
            
            if(dataPoint) {
               try { rsiChart.setCrosshairPosition(rVal ?? 50, param.time, rsiSeries); } catch(e) {}
               currentCandle = dataPoint;
            }

            const vPoint = getCrosshairDataPoint(volumeSeries, param);
            if (vPoint) {
               currentVolume = vPoint.value;
            }
          } else {
            try { rsiChart.clearCrosshairPosition(); } catch(e) {}
            setRsiHoverValue(null);
          }
        }

        if (ohlcPanel) {
          if (!currentCandle) {
             const latest = getLatestCandle(candleData, volumeData);
             currentCandle = latest.candle;
             currentVolume = latest.volume;
          }
          updateOHLCInfoPanel(ohlcPanel, currentCandle, currentVolume);
        }
      } catch (e) {
        // ignore disposed
      }
    });

    rsiChart.subscribeCrosshairMove(param => {
      if (!param.sourceEvent) return;
      try {
        let currentCandle = null;
        let currentVolume = null;
        
        setTimeout(() => {
          if (!isHoveringButtonRef.current) {
            setCrosshairInfo(null);
          }
        }, 50);

        if (!param.point || param.point.x < 0 || param.point.y < 0) {
          try { mainChart.clearCrosshairPosition(); } catch(e) {}
          setRsiHoverValue(null);
        } else {
          if (param.time) {
            const dataPoint = getCrosshairDataPoint(rsiSeries, param);
            if(dataPoint) {
                try { mainChart.setCrosshairPosition(dataPoint.value ?? 0, param.time, mainSeries); } catch(e) {}
                setRsiHoverValue(Number(dataPoint.value).toFixed(2));
                
                const matchingCandle = candleData.find((c: any) => c.time === param.time);
                if (matchingCandle) {
                    currentCandle = matchingCandle;
                }
                const matchingVolume = volumeData.find((v: any) => v.time === param.time);
                if (matchingVolume) {
                    currentVolume = matchingVolume.value;
                }
            }
          } else {
             try { mainChart.clearCrosshairPosition(); } catch(e) {}
             setRsiHoverValue(null);
          }
        }

        if (ohlcPanel) {
          if (!currentCandle) {
             const latest = getLatestCandle(candleData, volumeData);
             currentCandle = latest.candle;
             currentVolume = latest.volume;
          }
          updateOHLCInfoPanel(ohlcPanel, currentCandle, currentVolume);
        }
      } catch(e) {
        // ignore disposed
      }
    });

    // Resize handlers (using ResizeObserver so it adapts to flex layout)
    const handleMainResize = (entries: ResizeObserverEntry[]) => {
      const entry = entries[0];
      if(entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        const nw = Math.floor(entry.contentRect.width);
        const nh = Math.floor(entry.contentRect.height);
        window.requestAnimationFrame(() => {
          try {
            mainChart.applyOptions({
              width: nw,
              height: nh,
            });
          } catch(e) {}
        });
      }
    };
    
    const handleRsiResize = (entries: ResizeObserverEntry[]) => {
      const entry = entries[0];
      if(entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        const nw = Math.floor(entry.contentRect.width);
        const nh = Math.floor(entry.contentRect.height);
        window.requestAnimationFrame(() => {
          try {
            rsiChart.applyOptions({
              width: nw,
              height: nh,
            });
          } catch(e) {}
        });
      }
    };

    const mainResizeObserver = new ResizeObserver(handleMainResize);
    const rsiResizeObserver = new ResizeObserver(handleRsiResize);

    if (chartContainerRef.current) mainResizeObserver.observe(chartContainerRef.current);
    if (rsiContainerRef.current) rsiResizeObserver.observe(rsiContainerRef.current);

    return () => {
      mainResizeObserver.disconnect();
      rsiResizeObserver.disconnect();
      mainChart.remove();
      rsiChart.remove();
      mainChartRef.current = null;
      mainSeriesRef.current = null;
    };
    // Re-run if chartData structure changes drastically, but memo keeps it stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartData, divergences, showRsi, showBB, bbData, bbColor, rsiColor, rsiLineWidth, rsiLineStyle, rsiSmaLineWidth, rsiSmaLineStyle, rsiOverbought1, rsiOverbought2, rsiOversold1, rsiOversold2, rsiSmaColor, rsiOverboughtColor, rsiOversoldColor, showHLevels, hLevels, hLevelsStyle, hLevelsWidth, selectedStrikeOnChart]);

  // Hook for drawing Overlays (OI Bars & Bollinger Bands) via requestAnimationFrame
  useEffect(() => {
    if (!overlayCanvasRef.current || !mainChartRef.current || !mainSeriesRef.current) return;
    
    const { pdhPrice, pdlPrice } = pdhPdlData;
    let animationFrameId: number;
    const canvas = overlayCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const draw = () => {
      if (!canvas.parentElement || !mainChartRef.current || !mainSeriesRef.current) return;
      const rect = canvas.parentElement.getBoundingClientRect();
      
      try {
        // Update canvas size to match CSS layout, scaled for high-DPI (retina) sharpness
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.floor(rect.width);
        const ch = Math.floor(rect.height);
        const bw = Math.floor(cw * dpr);
        const bh = Math.floor(ch * dpr);
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        if (canvas.style.width !== `${cw}px`) canvas.style.width = `${cw}px`;
        if (canvas.style.height !== `${ch}px`) canvas.style.height = `${ch}px`;
        // Draw using logical (CSS) pixels; the transform maps them to device pixels for crisp output
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.clearRect(0, 0, cw, ch);
        
        // 1. Draw Bollinger Bands fill if active
        // Recompute the bands LIVE so they track the forming candle and advance with new candles,
        // instead of freezing at the last closed/server candle.
        if (showBB) {
          const baseC = chartDataRef.current?.candles || [];
          const liveC = lastCandleDataRef.current;
          const sig = `${baseC.length}|${liveC?.time || 0}|${liveC?.close ?? 0}|${liveC?.high ?? 0}|${liveC?.low ?? 0}|${bbPeriod}|${bbStdDev}`;
          if (sig !== bbSigRef.current) {
            let candlesForBB: any[] = baseC;
            if (liveC && baseC.length) {
              const lastT = baseC[baseC.length - 1].time;
              if (liveC.time === lastT) candlesForBB = [...baseC.slice(0, -1), liveC];
              else if (liveC.time > lastT) candlesForBB = [...baseC, liveC];
            }
            const live = calculateBollingerBands(candlesForBB, bbPeriod, bbStdDev);
            bbDataRef.current = live;
            bbSigRef.current = sig;
            // Extend the line series to the latest point (update = upsert on the most recent bar)
            if (live.length) {
              const lp = live[live.length - 1];
              try { bbUpperSeriesRef.current?.update({ time: lp.time as any, value: lp.upper }); } catch (e) {}
              try { bbMiddleSeriesRef.current?.update({ time: lp.time as any, value: lp.middle }); } catch (e) {}
              try { bbLowerSeriesRef.current?.update({ time: lp.time as any, value: lp.lower }); } catch (e) {}
            }
          }
        } else {
          bbDataRef.current = [];
        }

        const liveBB = bbDataRef.current;
        if (showBB && liveBB && liveBB.length > 0) {
          ctx.beginPath();
          let first = true;
          
          for (let i = 0; i < liveBB.length; i++) {
            const p = liveBB[i];
            const x = mainChartRef.current!.timeScale().timeToCoordinate(p.time as any);
            const yUpper = mainSeriesRef.current!.priceToCoordinate(p.upper);
            if (x !== null && yUpper !== null) {
              if (first) {
                ctx.moveTo(x, yUpper);
                first = false;
              } else {
                ctx.lineTo(x, yUpper);
              }
            }
          }
          
          for (let i = liveBB.length - 1; i >= 0; i--) {
            const p = liveBB[i];
            const x = mainChartRef.current!.timeScale().timeToCoordinate(p.time as any);
            const yLower = mainSeriesRef.current!.priceToCoordinate(p.lower);
            if (x !== null && yLower !== null) {
              ctx.lineTo(x, yLower);
            }
          }
          
          if (!first) {
            ctx.closePath();
            ctx.fillStyle = hexToRgba(bbColor, 0.06); // Subtle translucent fill based on chosen color
            ctx.fill();
          }
        }

        // 2. OI Bars — defined as a function here, but drawn AFTER the horizontal lines below,
        //    so the bars always sit clearly on top of S&R / PDH-PDL / H-Level lines.
        const drawOiBars = () => {
          if (!(showOiBars && oiData && oiData.strikes && oiData.ceData && oiData.peData)) return;
          const optionRows = oiData.strikes.map((strike: number) => ({
            strike,
            call_oi: oiData.ceData[strike]?.oi || 0,
            put_oi: oiData.peData[strike]?.oi || 0
          }));
          
          const maxOI = Math.max(...optionRows.map((o: any) => Math.max(o.call_oi, o.put_oi)));
          
          ctx.font = '10px Inter, sans-serif';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          
          // Draw from right edge (strike price line) towards the left
          const priceScaleWidth = mainChartRef.current ? mainChartRef.current.priceScale('right').width() : 60;
          const rightEdge = cw - priceScaleWidth - oiBarGap;
          const maxBarWidth = oiMaxBarWidth; // max length of bars

          // Glow setup: bars near the spot price that have just grown in OI pulse with a colored halo
          const glowSpot = oiData.spot || (chartDataRef.current?.spot) || 0;
          const glowBand = glowSpot > 0 ? glowSpot * 0.006 : 0; // ~0.6% around spot ≈ a few strikes
          const GLOW_MS = 20000; // glow lasts until the next couple of updates
          const nowMs = Date.now();
          const glowBlur = 8 + 6 * (0.5 + 0.5 * Math.sin(nowMs / 350)); // gentle pulse 8–14px

          optionRows.forEach((row: any) => {
              const y = mainSeriesRef.current!.priceToCoordinate(row.strike);
              if (y === null || y < 0 || y > ch) return;
              
              const callWidth = (row.call_oi / maxOI) * maxBarWidth;
              const putWidth = (row.put_oi / maxOI) * maxBarWidth;
              
              const barHeight = oiBarThickness;

              const nearSpot = glowBand > 0 && Math.abs(row.strike - glowSpot) <= glowBand;
              const g = oiGlowRef.current[row.strike];
              const callGlow = nearSpot && !!g && (nowMs - g.call < GLOW_MS);
              const putGlow = nearSpot && !!g && (nowMs - g.put < GLOW_MS);
              
              // Call (Red) goes slightly above
              ctx.save();
              if (callGlow) { ctx.shadowColor = oiCallColor; ctx.shadowBlur = glowBlur; }
              ctx.fillStyle = hexToRgba(oiCallColor, callGlow ? 0.95 : 0.75);
              ctx.beginPath();
              ctx.roundRect(rightEdge - callWidth, y - barHeight/2, callWidth, barHeight/2, [4, 0, 0, 4]);
              ctx.fill();
              ctx.restore();
              
              // Put (Green) goes slightly below
              ctx.save();
              if (putGlow) { ctx.shadowColor = oiPutColor; ctx.shadowBlur = glowBlur; }
              ctx.fillStyle = hexToRgba(oiPutColor, putGlow ? 0.95 : 0.75);
              ctx.beginPath();
              ctx.roundRect(rightEdge - putWidth, y, putWidth, barHeight/2, [4, 0, 0, 4]);
              ctx.fill();
              ctx.restore();
          });
        };
        
        // 3. Draw Spot Price and Countdown to bar close on Y axis
        const lastCandle = lastCandleDataRef.current || (chartData && chartData.candles && chartData.candles.length > 0 ? chartData.candles[chartData.candles.length - 1] : null);
        if (lastCandle) {
          const y = mainSeriesRef.current!.priceToCoordinate(lastCandle.close);
          if (y !== null && y >= 0 && y <= ch) {
            const priceScaleWidth = mainChartRef.current ? mainChartRef.current.priceScale('right').width() : 60;
            const badgeWidth = priceScaleWidth;
            const x = cw - priceScaleWidth;
            const badgeHeight = 18;
            const spotY = y - badgeHeight / 2;
            const badgeY = y + badgeHeight / 2; 

            // Determine Spot Color
            const isRed = lastCandle.close < lastCandle.open;
            const spotColor = isRed ? '#ef4444' : '#22c55e';

            // Draw Spot Price Line (Right to Left)
            ctx.beginPath();
            ctx.strokeStyle = spotColor;
            ctx.lineWidth = 0.5;
            ctx.setLineDash([2, 4]);
            ctx.moveTo(0, y);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw Spot Price Badge
            ctx.fillStyle = spotColor;
            ctx.fillRect(x, spotY, badgeWidth, badgeHeight);
            ctx.fillStyle = '#ffffff';
            ctx.font = "bold 12px -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(lastCandle.close.toFixed(2), x + badgeWidth / 2, spotY + badgeHeight / 2);

            if (badgeY + badgeHeight <= ch) {
              const nowMs = Date.now();
              const istMs = nowMs + (5.5 * 60 * 60 * 1000);
              const ist = new Date(istMs);
              const istDay = ist.getUTCDay();
              const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
              const marketOpen = istDay !== 0 && istDay !== 6 && istMinutes >= 9 * 60 + 15 && istMinutes <= 15 * 60 + 30;

              // Countdown background matches spot price color slightly darker or same? 
              // User said "keep the market closed background and the countdown to close background to match the spot price background"
              ctx.fillStyle = spotColor;
              ctx.fillRect(x, badgeY, badgeWidth, badgeHeight);
              ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';

              if (!marketOpen) {
                // Dimmer text for closed
                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.fillText('CLOSED', x + badgeWidth / 2, badgeY + badgeHeight / 2);
              } else {
                const now = Math.floor(nowMs / 1000) + serverTimeOffsetRef.current;
                const barDurationSeconds = parseInt(timeframe, 10) * 60;
                const alignedBarStart = Math.floor(now / barDurationSeconds) * barDurationSeconds;
                const remainingSec = Math.max(0, alignedBarStart + barDurationSeconds - now);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(formatCountdown(remainingSec), x + badgeWidth / 2, badgeY + badgeHeight / 2);
              }
            }
          }
        }
        // 4. Draw S&R / PDH / PDL text and lines
        if (chartData && chartData.candles && chartData.candles.length > 0 && lastCandle && mainChartRef.current) {
           const firstCandle = chartData.candles[0];
           
           // We want text to stay flushed right on the chart area, just left of right price scale
           const priceScaleWidth = mainChartRef.current.priceScale('right').width() || 60;
           const textAlignX = cw - priceScaleWidth;
           
           const endXCoordinate = mainChartRef.current.timeScale().timeToCoordinate(lastCandle.time as any);
           const startXCoordinate = mainChartRef.current.timeScale().timeToCoordinate(firstCandle.time as any);
           // Fallbacks
           const startX = startXCoordinate !== null ? startXCoordinate : 0;
           const endX = endXCoordinate !== null ? endXCoordinate : textAlignX;

           if (textAlignX !== null) {
              const textMargin = 10;
              const textDrawX = textAlignX - textMargin;
              
              const linesToDraw: { text: string, y: number, color: string, isTextOnly?: boolean, dash?: number[], lineWidth?: number }[] = [];
              const snrDash = snrStyle === 1 ? [5, 5] : snrStyle === 2 ? [2, 4] : [];
              if (showSnR && localAnalytics?.supportZone?.strikePrice) {
                 const y = mainSeriesRef.current.priceToCoordinate(localAnalytics.supportZone.strikePrice);
                 if (y !== null) linesToDraw.push({ text: `SUP`, y, color: supportColor, dash: snrDash, lineWidth: snrWidth });
              }
              if (showSnR && localAnalytics?.resistanceZone?.strikePrice) {
                 const y = mainSeriesRef.current.priceToCoordinate(localAnalytics.resistanceZone.strikePrice);
                 if (y !== null) linesToDraw.push({ text: `RES`, y, color: resistanceColor, dash: snrDash, lineWidth: snrWidth });
              }
              const pdhPdlDash = pdhPdlStyle === 1 ? [5, 5] : pdhPdlStyle === 2 ? [2, 4] : [];
              if (showPdhPdl && pdhPrice !== null) {
                 const y = mainSeriesRef.current.priceToCoordinate(pdhPrice);
                 if (y !== null) linesToDraw.push({ text: `PDH ${pdhPrice}`, y, color: pdhColor, dash: pdhPdlDash, lineWidth: pdhPdlWidth });
              }
              if (showPdhPdl && pdlPrice !== null) {
                 const y = mainSeriesRef.current.priceToCoordinate(pdlPrice);
                 if (y !== null) linesToDraw.push({ text: `PDL ${pdlPrice}`, y, color: pdlColor, dash: pdhPdlDash, lineWidth: pdhPdlWidth });
              }
              if (showFiftyPercentLevels && hLevels) {
                 const activeLevels = hLevels.filter(v => v > 0).sort((a, b) => b - a);
                 for (let i = 0; i < activeLevels.length - 1; i++) {
                   const midPoint = Math.round((activeLevels[i] + activeLevels[i+1]) / 2);
                   const y = mainSeriesRef.current.priceToCoordinate(midPoint);
                   if (y !== null) {
                     linesToDraw.push({ text: `50% LEVEL`, y, color: fiftyPercentColor, dash: [4, 4], lineWidth: 1 });
                   }
                 }
              }

              // H Levels — drawn here (line + pill) so RED OUTER / RED INNER / TRAP UPPER / TRAP LOWER / GREEN OUTER / GREEN INNER text shows on the chart
              if (showHLevels && hLevels) {
                 const hColors = ['#ef4444', '#ef4444', '#fbbf24', '#fbbf24', '#22c55e', '#22c55e'];
                 const hTexts = ['RED OUTER', 'RED INNER', 'TRAP UPPER', 'TRAP LOWER', 'GREEN INNER', 'GREEN OUTER'];
                 const hDash = hLevelsStyle === 1 ? [5, 5] : hLevelsStyle === 2 ? [2, 4] : [];
                 hLevels.forEach((lvl, idx) => {
                   if (lvl && lvl > 0) {
                     const y = mainSeriesRef.current.priceToCoordinate(lvl);
                     if (y !== null) linesToDraw.push({ text: hTexts[idx], y, color: hColors[idx], dash: hDash, lineWidth: hLevelsWidth });
                   }
                 });
              }

              // Draw Lines
              linesToDraw.forEach(item => {
                 ctx.beginPath();
                 ctx.strokeStyle = item.color;
                 ctx.lineWidth = item.lineWidth || 1;
                 if (item.dash && item.dash.length > 0) ctx.setLineDash(item.dash);
                 ctx.moveTo(0, item.y); 
                 ctx.lineTo(textAlignX, item.y); // Stop before right scale
                 ctx.stroke();
                 ctx.setLineDash([]);
              });

              // Draw OI bars on top of the horizontal lines so they stay clearly visible
              drawOiBars();

              ctx.font = '12px sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              
              const baseCenterX = textAlignX / 2;
              
              // Sort labels top-to-bottom
              const labels = [...linesToDraw];
              labels.sort((a, b) => a.y - b.y);

              const assignedPositions: {x: number, y: number}[] = [];

              labels.forEach((label) => {
                 let displayText = label.text;
                 if (displayText === 'SUP') displayText = 'SUPPORT';
                 else if (displayText === 'RES') displayText = 'RESISTANCE';
                 else if (displayText.startsWith('PDH')) displayText = 'PDH';
                 else if (displayText.startsWith('PDL')) displayText = 'PDL';

                 // Find a non-colliding X position (if Y overlaps)
                 let currentX = baseCenterX;
                 let collision = true;
                 let offsetMultiplier = 1;
                 while (collision) {
                    collision = assignedPositions.some(pos => 
                       Math.abs(pos.y - label.y) < 20 && Math.abs(pos.x - currentX) < Math.max(120, ctx.measureText(displayText).width + 30)
                    );
                    if (collision) {
                       const offset = (offsetMultiplier % 2 === 0 ? -1 : 1) * Math.ceil(offsetMultiplier / 2) * 140;
                       currentX = baseCenterX + offset;
                       offsetMultiplier++;
                    }
                 }
                 assignedPositions.push({ x: currentX, y: label.y });

                 // Calculate inline label dimensions
                 const textWidth = ctx.measureText(displayText).width;
                 const paddingX = 16; 
                 const totalWidth = textWidth + paddingX;
                 const totalHeight = 18;
                 
                 const bgX = currentX - totalWidth / 2;
                 const bgY = label.y - totalHeight / 2;

                 // Draw the pill background using the label's color
                 ctx.fillStyle = label.color;
                 ctx.beginPath();
                 ctx.roundRect(bgX, bgY, totalWidth, totalHeight, totalHeight / 2);
                 ctx.fill();
                 
                 // Draw the text in the chart's background color
                 // (smaller font for the text only — pill size above is still measured at 12px)
                 const isDark = document.documentElement.classList.contains('dark');
                 ctx.fillStyle = isDark ? '#0d1117' : '#ffffff';
                 ctx.font = '10px sans-serif';
                 ctx.fillText(displayText, currentX, label.y);
                 
                 // Restore font for next inline label's measurements
                 ctx.font = '12px sans-serif';
              });

              // SL / TARGET — centered pill on each line: chart-background fill, outline in the line's colour.
              // Uses the same collision system as the other labels so it never sits on top of another label.
              if (slLinesRef.current && slLinesRef.current.length > 0) {
                 const isDarkPill = document.documentElement.classList.contains('dark');
                 const pillBg = isDarkPill ? '#0d1117' : '#ffffff';
                 ctx.textAlign = 'center';
                 ctx.textBaseline = 'middle';
                 // sort by y so stacking is stable
                 const slSorted = [...slLinesRef.current]
                   .map(sl => ({ sl, y: mainSeriesRef.current!.priceToCoordinate(sl.price) }))
                   .filter(o => o.y !== null && (o.y as number) >= 0 && (o.y as number) <= ch)
                   .sort((a, b) => (a.y as number) - (b.y as number));
                 slSorted.forEach(({ sl, y }) => {
                    const yy = y as number;
                    const txt = sl.label || (sl.kind === 'upper' ? 'TARGET' : 'SL');
                    const lineColor = sl.color || (sl.kind === 'upper' ? '#f43f5e' : '#10b981');
                    ctx.font = 'bold 10px sans-serif';
                    const tw = ctx.measureText(txt).width;

                    // Find a non-colliding X (shift sideways if another label shares this row)
                    let currentX = baseCenterX;
                    let collision = true;
                    let offsetMultiplier = 1;
                    while (collision) {
                       collision = assignedPositions.some(pos =>
                          Math.abs(pos.y - yy) < 20 && Math.abs(pos.x - currentX) < Math.max(120, tw + 30)
                       );
                       if (collision) {
                          const offset = (offsetMultiplier % 2 === 0 ? -1 : 1) * Math.ceil(offsetMultiplier / 2) * 140;
                          currentX = baseCenterX + offset;
                          offsetMultiplier++;
                       }
                    }
                    assignedPositions.push({ x: currentX, y: yy });

                    const w = tw + 16;
                    const h = 18;
                    const x0 = currentX - w / 2;
                    const y0 = yy - h / 2;
                    ctx.beginPath();
                    ctx.roundRect(x0, y0, w, h, h / 2);
                    ctx.fillStyle = pillBg;
                    ctx.fill();
                    ctx.lineWidth = 1.5;
                    ctx.strokeStyle = lineColor;
                    ctx.stroke();
                    ctx.fillStyle = lineColor;
                    ctx.fillText(txt, currentX, yy);
                 });
                 ctx.font = '12px sans-serif';
              }
           }
        }

        // 5. Draw Crosshair price label above MKT CLOSED and SUP/RES
        if (crosshairInfoRef && crosshairInfoRef.current) {
          const crossY = crosshairInfoRef.current.y;
          const crossX = crosshairInfoRef.current.x;
          const crossPrice = crosshairInfoRef.current.price;
          
          if (crossY >= 0 && crossY <= ch && mainChartRef.current) {
            const priceScaleWidth = mainChartRef.current.priceScale('right').width() || 60;
            const x = cw - priceScaleWidth;

            if (isHoveringButtonRef && isHoveringButtonRef.current) {
              ctx.beginPath();
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'; // matched lightweight charts
              ctx.lineWidth = 1;
              ctx.setLineDash([4, 4]);

              // Horizontal line
              ctx.moveTo(0, crossY);
              ctx.lineTo(x, crossY);

              // Vertical line
              const chartHeight = Math.max(0, ch - (mainChartRef.current.timeScale().height() || 26));
              if (crossX >= 0 && crossX <= x) {
                ctx.moveTo(crossX, 0);
                ctx.lineTo(crossX, chartHeight);
              }

              ctx.stroke();
              ctx.setLineDash([]);
            }

            const labelHeight = 22;
            const labelY = crossY - labelHeight / 2;
            
            ctx.fillStyle = '#2b2b43'; // crosshair label bg color
            ctx.fillRect(x, labelY, priceScaleWidth, labelHeight);
            
            ctx.fillStyle = '#d1d4dc'; // crosshair text color
            ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(crossPrice.toFixed(2), x + priceScaleWidth / 2, labelY + labelHeight / 2);
          }
        }

      } catch (e) {
        // Suppress "Object is disposed" errors from lightweight-charts within this drawing frame
      }
      
      animationFrameId = requestAnimationFrame(draw);
    };
    
    draw();
    
    return () => cancelAnimationFrame(animationFrameId);
  }, [showOiBars, oiData, showBB, bbData, timeframe, chartData, bbColor, oiMaxBarWidth, oiCallColor, oiPutColor, oiBarGap, oiBarThickness, localAnalytics, showPdhPdl, pdhPdlData, pdhColor, pdlColor, pdhPdlStyle, pdhPdlWidth, showSnR, supportColor, resistanceColor, snrStyle, snrWidth, showFiftyPercentLevels, hLevels, fiftyPercentColor, showHLevels, hLevelsStyle, hLevelsWidth]);

  const { data: serverStats } = useQuery({
    queryKey: ["server-diagnostics"],
    queryFn: async () => {
      const res = await fetch('/api/diagnostics');
      return res.json();
    },
    refetchInterval: 5000,
    enabled: showDiagnostic,
  });

  return (
    <div className="px-1 py-2 md:p-8 animate-in fade-in duration-500 max-w-[1600px] w-full mx-auto pb-20 flex flex-col min-h-screen relative">
      
      {showDiagnostic && (
        <div className="fixed bottom-6 right-6 z-50 bg-card/95 backdrop-blur-md border border-0 p-4 rounded-lg text-xs font-mono w-[340px] max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between border-b border-0 pb-2 mb-2">
            <span className="text-muted-foreground font-semibold uppercase">Diagnostic Panel</span>
            <button onClick={() => setShowDiagnostic(false)} className="text-muted-foreground hover:text-foreground transition-colors">
              <X size={14} />
            </button>
          </div>
          {serverStats && (
            <div className="flex flex-col gap-1.5 mb-2">
              <span className="text-muted-foreground font-semibold uppercase mb-1">Backend Connectivity</span>
              <div className="flex justify-between">
                 <span className="text-muted-foreground">Req / Min</span>
                 <span className="text-sky-400">{serverStats.requestCountPerMinute} req/min</span>
              </div>
              <div className="flex justify-between">
                 <span className="text-muted-foreground">Cache Hit/Miss</span>
                 <span className="text-purple-400">{serverStats.cacheHits} / {serverStats.cacheMisses}</span>
              </div>
              <div className="flex justify-between">
                 <span className="text-muted-foreground">Total 429 Errors</span>
                 <span className={serverStats.error429Count > 0 ? "text-red-400 font-bold" : "text-emerald-400"}>{serverStats.error429Count}</span>
              </div>
              <div className="flex justify-between">
                 <span className="text-muted-foreground">Last Req</span>
                 <span className="text-foreground/80">{serverStats.lastRequestTime ? new Date(serverStats.lastRequestTime).toLocaleTimeString() : 'N/A'}</span>
              </div>
              <div className="w-full h-px bg-muted my-1" />
              <span className="text-muted-foreground font-semibold uppercase mb-1">WebSocket Connections</span>
              <div className="flex justify-between">
                 <span className="text-muted-foreground">Status</span>
                 <span className={`font-medium ${
                   getWsDiagnostics().status === 'Connected' ? 'text-emerald-400' : 
                   getWsDiagnostics().status === 'Failed' ? 'text-red-400' : 'text-primary'
                 }`}>
                    {getWsDiagnostics().status}
                 </span>
              </div>
              <OrderDiagnosticsPanel testMode={testOrderMode} setTestMode={setTestOrderMode} />
              <MarginDiagnosticsPanel ticketData={ticketData} kiteDiagnosticsData={kiteDiagnosticsData} />
            </div>
          )}
          {taInfo && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground font-semibold uppercase mb-1">Chart Data</span>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Token</span>
              <span className="text-foreground">{instrumentToken}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Symbol</span>
              <span className="text-cyan-400">{selectedInstrument?.tradingsymbol || 'NIFTY 50'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Exchange</span>
              <span className="text-foreground">{selectedInstrument?.exchange || 'NSE'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Segment</span>
              <span className="text-foreground">{(selectedInstrument as any)?.segment || 'INDICES'}</span>
            </div>
            <div className="w-full h-px bg-muted my-1" />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Latest Vol</span>
              <span className="text-emerald-400">{taInfo.rawTop5?.[0]?.volume ?? '0'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Vol Source</span>
              <span className="text-primary">Raw Kite Data</span>
            </div>
            <div className="w-full h-px bg-muted my-1" />
            <span className="text-muted-foreground font-semibold uppercase mb-1">Bollinger Bands</span>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className={showBB ? "text-emerald-400 font-bold" : "text-muted-foreground"}>
                {showBB ? "ENABLED" : "DISABLED"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Period</span>
              <span className="text-foreground">{bbPeriod}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Std Dev</span>
              <span className="text-foreground">{bbStdDev}</span>
            </div>
            {showBB && bbData.length > 0 ? (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Latest Upper</span>
                  <span className="text-cyan-400 font-mono">{bbData[bbData.length - 1].upper.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Latest Basis</span>
                  <span className="text-purple-400 font-mono">{bbData[bbData.length - 1].middle.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Latest Lower</span>
                  <span className="text-cyan-400 font-mono">{bbData[bbData.length - 1].lower.toFixed(2)}</span>
                </div>
              </>
            ) : showBB && (
              <div className="text-[10px] text-primary italic">No calculation data available</div>
            )}
            {taInfo.rawVolumeStats && (
              <>
                <div className="w-full h-px bg-muted my-1" />
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Max Hist Vol</span>
                  <span className="text-pink-400">{taInfo.rawVolumeStats.max}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Min Hist Vol</span>
                  <span className="text-pink-400">{taInfo.rawVolumeStats.min}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Hist Vol</span>
                  <span className="text-pink-400">{taInfo.rawVolumeStats.avg}</span>
                </div>
              </>
            )}
            {taInfo.rawTop5 && taInfo.rawTop5.length > 0 && (
              <>
                <div className="w-full h-px bg-muted my-1" />
                <span className="text-muted-foreground font-semibold uppercase mb-1">Historical Candle Audit</span>
                <div className="flex flex-col gap-2 relative">
                  {taInfo.rawTop5.map((c: any, i: number) => (
                    <div key={i} className="flex flex-col bg-muted/50 p-2 rounded text-[10px]">
                      <div className="text-muted-foreground flex justify-between">
                        <span>{new Date(c.date || c.time).toLocaleString()}</span>
                        <span className="text-emerald-400">Vol: {c.volume ?? 'N/A'}</span>
                      </div>
                      <div className="grid grid-cols-4 gap-1 mt-1 text-foreground/80">
                        <span>O:{Number(c.open)?.toFixed(1)}</span>
                        <span>H:{Number(c.high)?.toFixed(1)}</span>
                        <span>L:{Number(c.low)?.toFixed(1)}</span>
                        <span>C:{Number(c.close)?.toFixed(1)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-3 pb-2 mb-2 md:mb-4">
        <div className="flex items-center gap-2 md:gap-4 flex-wrap">
          <h1 className="text-lg md:text-2xl font-bold text-foreground tracking-tight whitespace-nowrap">
            Advanced Trading Chart
          </h1>
          {lastTickMessage && (
             <span className="bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-md text-xs font-mono font-bold animate-pulse whitespace-nowrap">
              LIVE TICK: {lastTickMessage}
             </span>
          )}
          {oiData && oiData.strikes && (() => {
            let ceChg = 0, peChg = 0;
            oiData.strikes.forEach((s: number) => {
              ceChg += oiData.ceData?.[s]?.chgOi || 0;
              peChg += oiData.peData?.[s]?.chgOi || 0;
            });
            const net = peChg - ceChg; // puts adding (support/bullish) minus calls adding (resistance/bearish)
            const total = Math.abs(ceChg) + Math.abs(peChg);
            const strength = total > 0 ? Math.abs(net) / total : 0;
            let label = 'NEUTRAL', color = 'bg-slate-500/20 text-slate-300', detail = 'balanced OI flow';
            if (strength > 0.15 && net > 0) { label = 'BULLISH'; color = 'bg-emerald-500/20 text-emerald-400'; detail = 'puts writing faster than calls (support building)'; }
            else if (strength > 0.15 && net < 0) { label = 'BEARISH'; color = 'bg-rose-500/20 text-rose-400'; detail = 'calls writing faster than puts (resistance building)'; }
            return (
              <span className={`px-3 py-1 rounded-md text-xs font-mono font-bold whitespace-nowrap ${color}`}
                title={`OI-change flow heuristic: ${detail}. Net Put−Call OI change: ${net.toFixed(2)}L. Read alongside price.`}>
                OI BIAS: {label}
              </span>
            );
          })()}
          {pulseBias?.success && pulseBias.dir && (() => {
            const color = pulseBias.dir === 'UP' ? 'bg-emerald-500/20 text-emerald-400'
              : pulseBias.dir === 'DOWN' ? 'bg-rose-500/20 text-rose-400'
              : 'bg-slate-500/20 text-slate-300';
            return (
              <span className={`px-3 py-1 rounded-md text-xs font-mono font-bold whitespace-nowrap ${color}`}
                title={`Premium Pulse direction lean (${pulseBias.confidence} confidence) — which side's premium is being bid up. ${pulseBias.reason}. Soft read from option premium behaviour, not a hard signal; weigh alongside price.`}>
                PULSE: {pulseBias.label}
              </span>
            );
          })()}
          {wsError && (
             <span className="bg-red-500/20 text-red-400 px-3 py-1 rounded-md text-xs font-mono font-bold animate-pulse whitespace-nowrap">
              WS ERROR: {wsError}
             </span>
          )}
        </div>
        <div className="flex items-center gap-2 md:gap-4 flex-wrap md:justify-end w-full md:w-auto">
          <SymbolSearch 
            onSelect={setSelectedInstrument} 
            currentSymbol={selectedInstrument ? selectedInstrument.tradingsymbol : "NIFTY 50"} 
          />
          {decision && localAnalytics && (
             <div className="flex items-center gap-4 px-3 py-1 bg-muted/40 border border-0 rounded-md ml-2">
                <div className="flex items-center gap-2">
                   {(() => {
                      const biasText = decision.bullScore > decision.bearScore ? 'Bullish' : decision.bearScore > decision.bullScore ? 'Bearish' : 'Neutral';
                      const textColor = biasText === 'Bullish' ? 'text-green-500' : biasText === 'Bearish' ? 'text-red-500' : 'text-primary';
                      return (
                         <span className={`font-bold ${textColor}`}>
                            {biasText}
                         </span>
                      );
                   })()}
                </div>
             </div>
          )}
          <div className="flex items-center gap-2 bg-muted/40 border border-0 rounded-md px-3 py-1.5 ml-2 cursor-pointer" onClick={() => setQuickTradeEnabled(!quickTradeEnabled)}>
             <span className="text-xs font-medium text-foreground/80">Quick Trade</span>
             <label className="relative inline-flex items-center cursor-pointer pointer-events-none">
               <input type="checkbox" className="sr-only peer" checked={quickTradeEnabled} readOnly />
               <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after: after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary"></div>
             </label>
          </div>
          <div className="flex bg-muted p-1 rounded-md">
            <div className="relative" ref={indicatorsRef}>
              <button
                onClick={() => setIsIndicatorsOpen(!isIndicatorsOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-sm text-muted-foreground hover:bg-background/50 hover:text-foreground transition-colors"
              >
                Indicators
                <ChevronDown size={14} className={`transition-transform ${isIndicatorsOpen ? 'rotate-180' : ''}`} />
              </button>
              {isIndicatorsOpen && (
                <div className="absolute top-full mt-1.5 right-0 min-w-[240px] bg-card border border-0 rounded-md py-1.5 z-50 overflow-hidden flex flex-col">
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase">Available Indicators</div>
                  
                  {/* Previous Day High/Low */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowPdhPdl(!showPdhPdl)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showPdhPdl && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Previous Day High/Low</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsEditingPdhPdl(true);
                        setIsIndicatorsOpen(false);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1 hover:bg-slate-700 rounded transition-colors"
                      title="PDH/PDL Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* Support/Resistance Lines */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowSnR(!showSnR)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showSnR && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Support/Resistance Lines</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsEditingSnR(true);
                        setIsIndicatorsOpen(false);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1 hover:bg-slate-700 rounded transition-colors"
                      title="Support/Resistance Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* OI Bars */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowOiBars(!showOiBars)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showOiBars && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>OI Bars</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsEditingOiBars(true);
                        setIsIndicatorsOpen(false);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1 hover:bg-slate-700 rounded transition-colors"
                      title="OI Bars Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* RSI */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowRsi(!showRsi)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showRsi && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>RSI</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsEditingRsi(true);
                        setIsIndicatorsOpen(false);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1 hover:bg-slate-700 rounded transition-colors"
                      title="RSI Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* Bollinger Bands */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowBB(!showBB)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showBB && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Bollinger Bands</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsEditingBB(true);
                        setIsIndicatorsOpen(false);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1 hover:bg-slate-700 rounded transition-colors"
                      title="Bollinger Bands Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* H Levels */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowHLevels(!showHLevels)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showHLevels && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>H Levels</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsEditingHLevels(true);
                        setIsIndicatorsOpen(false);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1 hover:bg-slate-700 rounded transition-colors"
                      title="H Levels Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* Diagnostic Panel */}
                  <button
                    onClick={() => setShowDiagnostic(!showDiagnostic)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-foreground/80 hover:bg-muted hover:text-foreground transition-colors text-left"
                  >
                    <div className="w-4 flex items-center justify-center">
                      {showDiagnostic && <Check size={14} className="text-emerald-400" />}
                    </div>
                    <span>Diagnostic Panel</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground font-medium">
              Timeframe:
            </span>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="bg-background text-foreground border border-0 text-sm rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary h-9"
            >
              <option value="1">1m</option>
              <option value="3">3m</option>
              <option value="5">5m</option>
              <option value="15">15m</option>
              <option value="60">1h</option>
              <option value="240">4h</option>
              <option value="1440">1D</option>
              <option value="10080">1W</option>
              <option value="43200">1M</option>
            </select>
          </div>
        </div>
      </div>
      


      {isLoading && (!chartData || chartData.candles.length === 0) ? (
        <div className="flex items-center justify-center flex-grow">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex flex-col flex-grow gap-2">

          {/* Main Chart (Price & Volume) */}
          <div className="relative flex-grow flex w-full bg-card rounded-xl" style={{ minHeight: "450px" }} onMouseLeave={() => setCrosshairInfo(null)}>
            <div
              ref={chartContainerRef}
              onPointerDownCapture={handlePointerDown}
              onPointerMoveCapture={handlePointerMove}
              onPointerUpCapture={handlePointerUp}
              onPointerLeave={handlePointerUp}
              className="border border-0 rounded-xl stretch-self flex-grow relative w-full overflow-hidden z-20"
            />
            {crosshairInfo && (
              <button
                onClick={handleAddManualLine}
                onMouseEnter={() => { isHoveringButtonRef.current = true; }}
                onMouseLeave={() => { isHoveringButtonRef.current = false; }}
                className="absolute right-[65px] w-6 h-6 rounded-full bg-card border  flex items-center justify-center text-foreground/80 hover:text-foreground hover:bg-slate-700 z-[60] transition-colors"
                style={{
                  top: `${crosshairInfo.y}px`,
                  transform: 'translateY(-50%)' // Center vertically
                }}
              >
                <Plus size={14} />
              </button>
            )}
            {slPanelOpen && slActivePos && (
              <div className="absolute top-3 left-3 z-[70] w-64 bg-card/95 backdrop-blur border border-border rounded-xl shadow-xl p-3 text-xs">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-foreground">Auto-Exit</span>
                  {slArmedRule
                    ? <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold text-[10px]">ARMED</span>
                    : <span className="px-2 py-0.5 rounded bg-slate-500/20 text-slate-300 font-bold text-[10px]">NOT ARMED</span>}
                </div>
                <div className="text-[10px] text-muted-foreground mb-2 truncate">{slActivePos.symbol} · {slActivePos.qty} qty</div>

                <div className="flex items-center justify-between mb-1">
                  <span className="flex items-center gap-1.5 text-rose-400"><span className="inline-block w-3 h-0.5 bg-rose-400" />{slIsBullish ? 'Target ▲' : 'Stop ▲'}</span>
                  <span className="font-mono font-bold text-foreground">{slLevels.upper ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between mb-2">
                  <span className="flex items-center gap-1.5 text-emerald-400"><span className="inline-block w-3 h-0.5 bg-emerald-400" />{slIsBullish ? 'Stop ▼' : 'Target ▼'}</span>
                  <span className="font-mono font-bold text-foreground">{slLevels.lower ?? '—'}</span>
                </div>
                <div className="text-[10px] text-muted-foreground mb-2 leading-tight">Defaults: stop = previous candle {slIsBullish ? 'low' : 'high'}, target = nearest chart level. Drag the lines to adjust.</div>

                <div className="mb-2">
                  <div className="text-[10px] text-rose-400 font-medium mb-1">Stop-Loss trigger</div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setSlStopMode('TOUCH')} className={`flex-1 py-1 rounded ${slStopMode === 'TOUCH' ? 'bg-primary text-primary-foreground font-bold' : 'bg-muted text-foreground/70'}`}>On Touch</button>
                    <button onClick={() => setSlStopMode('CLOSE')} className={`flex-1 py-1 rounded ${slStopMode === 'CLOSE' ? 'bg-primary text-primary-foreground font-bold' : 'bg-muted text-foreground/70'}`}>On Candle Close</button>
                  </div>
                </div>

                <div className="mb-2">
                  <div className="text-[10px] text-emerald-400 font-medium mb-1">Target trigger</div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setSlTargetMode('TOUCH')} className={`flex-1 py-1 rounded ${slTargetMode === 'TOUCH' ? 'bg-primary text-primary-foreground font-bold' : 'bg-muted text-foreground/70'}`}>On Touch</button>
                    <button onClick={() => setSlTargetMode('CLOSE')} className={`flex-1 py-1 rounded ${slTargetMode === 'CLOSE' ? 'bg-primary text-primary-foreground font-bold' : 'bg-muted text-foreground/70'}`}>On Candle Close</button>
                  </div>
                </div>

                <div className="flex items-center justify-between mb-2 p-1.5 rounded bg-muted/50">
                  <span className="text-foreground/90 font-medium">Trailing SL after target</span>
                  <button onClick={() => setSlTrail(v => !v)} className={`relative w-9 h-5 rounded-full transition-colors ${slTrail ? 'bg-emerald-500' : 'bg-slate-600'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${slTrail ? 'translate-x-4' : ''}`} />
                  </button>
                </div>
                {slTrail && (
                  <div className="mb-2 p-1.5 rounded bg-muted/30 text-[10px] text-muted-foreground leading-tight">
                    <div className="flex items-center gap-2 mb-1 text-foreground/90">
                      <span>Trail</span>
                      <input value={slTrailCandles} onChange={e => setSlTrailCandles(e.target.value)} inputMode="numeric" className="w-10 bg-muted rounded px-1.5 py-0.5 text-foreground text-center" />
                      <span>candles · on close</span>
                    </div>
                    On reaching target, the stop trails the {slTrailCandles || '3'}-candle {slIsBullish ? 'low' : 'high'} and exits when price closes back through it.
                  </div>
                )}

                <div className="flex items-center gap-1 mb-2">
                  <input value={slRsiLower} onChange={e => setSlRsiLower(e.target.value)} placeholder="RSI ≤" inputMode="decimal" className="w-1/2 bg-muted rounded px-2 py-1 text-foreground placeholder:text-muted-foreground" />
                  <input value={slRsiUpper} onChange={e => setSlRsiUpper(e.target.value)} placeholder="RSI ≥" inputMode="decimal" className="w-1/2 bg-muted rounded px-2 py-1 text-foreground placeholder:text-muted-foreground" />
                </div>

                {slArmedRule ? (
                  <div className="flex gap-1">
                    <button disabled={slSaving} onClick={armSlRule} className="flex-1 py-1.5 rounded bg-amber-500/90 hover:bg-amber-500 text-black font-bold disabled:opacity-50">Update</button>
                    <button disabled={slSaving} onClick={cancelSlRule} className="flex-1 py-1.5 rounded bg-rose-500/90 hover:bg-rose-500 text-white font-bold disabled:opacity-50">Cancel</button>
                  </div>
                ) : (
                  <button disabled={slSaving} onClick={armSlRule} className="w-full py-1.5 rounded bg-emerald-500/90 hover:bg-emerald-500 text-white font-bold disabled:opacity-50">{slSaving ? 'Arming…' : 'Arm Auto-Exit'}</button>
                )}
                <div className="text-[9px] text-muted-foreground mt-2 leading-tight">{slTrail
                  ? `Stop ${slStopMode === 'CLOSE' ? 'on close' : 'on touch'}; on hitting target (${slTargetMode === 'CLOSE' ? 'close' : 'touch'}) the ${slTrailCandles || '3'}-candle trail takes over. Watch the first triggers live.`
                  : `Stop ${slStopMode === 'CLOSE' ? 'on close' : 'on touch'}, target ${slTargetMode === 'CLOSE' ? 'on close' : 'on touch'} — both exit the full position. Watch the first triggers live.`}</div>
              </div>
            )}
            <canvas
              ref={overlayCanvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none rounded-xl z-30"
            />
            {(() => {
              if (showOiBars && oiData && crosshairInfo) {
                const priceScaleWidth = mainChartRef.current ? mainChartRef.current.priceScale('right').width() : 60;
                const chartWidth = chartContainerRef.current?.getBoundingClientRect().width || 0;
                
                if (oiData.strikes && oiData.strikes.length > 0) {
                   const nearestStrike = oiData.strikes.reduce((prev: number, curr: number) => 
                      Math.abs(curr - crosshairInfo.price) < Math.abs(prev - crosshairInfo.price) ? curr : prev
                   );
                   
                   const y = mainSeriesRef.current?.priceToCoordinate(nearestStrike);
                   if (y !== null && y !== undefined && Math.abs(crosshairInfo.y - y) <= 10) {
                     const ce = oiData.ceData[nearestStrike];
                     const pe = oiData.peData[nearestStrike];
                     
                     const prevCe = oiHistoryRef.current.prev?.ceData?.[nearestStrike];
                     const prevPe = oiHistoryRef.current.prev?.peData?.[nearestStrike];
                     
                     const getSentimentColor = (sentiment: string) => {
                       if (sentiment.includes("LONG BUILDUP") || sentiment.includes("SHORT COVERING")) return "text-emerald-400";
                       if (sentiment.includes("SHORT BUILDUP") || sentiment.includes("LONG UNWINDING")) return "text-rose-400";
                       return "text-muted-foreground";
                     };
                     
                     const getSentimentFromChg = (chgLtp: number, chgOi: number) => {
                       if (chgLtp > 0 && chgOi > 0) return 'LONG BUILDUP';
                       if (chgLtp < 0 && chgOi > 0) return 'SHORT BUILDUP';
                       if (chgLtp < 0 && chgOi < 0) return 'LONG UNWINDING';
                       if (chgLtp > 0 && chgOi < 0) return 'SHORT COVERING';
                       return 'NEUTRAL';
                     };

                     const ceSentimentLabel = ce ? getSentimentFromChg(ce.chgLtp || 0, ce.chgOi || 0) : 'NEUTRAL';
                     const peSentimentLabel = pe ? getSentimentFromChg(pe.chgLtp || 0, pe.chgOi || 0) : 'NEUTRAL';
                     
                     const maxOI = Math.max(...oiData.strikes.map((s: number) => Math.max(oiData.ceData[s]?.oi || 0, oiData.peData[s]?.oi || 0)));
                     
                     const callWidth = maxOI > 0 ? ((ce?.oi || 0) / maxOI) * oiMaxBarWidth : 0;
                     const putWidth = maxOI > 0 ? ((pe?.oi || 0) / maxOI) * oiMaxBarWidth : 0;
                     const maxCurrentBarWidth = Math.max(callWidth, putWidth);
                     
                     const rightEdge = chartWidth - priceScaleWidth - oiBarGap;
                     
                     if (crosshairInfo.x >= rightEdge - maxCurrentBarWidth - 5 && crosshairInfo.x <= rightEdge + 5) {
                       const formatOi = (oiInLakhs: number) => {
                         if (!oiInLakhs) return '0';
                         const val = Math.abs(oiInLakhs);
                         if (val >= 1) return oiInLakhs.toFixed(2) + ' L';
                         if (val >= 0.01) return (oiInLakhs * 100).toFixed(2) + ' K';
                         return (oiInLakhs * 100000).toFixed(0);
                       };

                       return (
                         <div 
                           className="absolute z-[80] bg-popover border border-0 rounded overflow-hidden p-2.5 flex flex-col gap-1 w-[200px] pointer-events-none text-xs font-mono"
                           style={{
                             top: `${Math.min(crosshairInfo.y + 15, (chartContainerRef.current?.getBoundingClientRect().height || 450) - 140)}px`,
                             left: `${crosshairInfo.x - 210}px`,
                           }}
                         >
                            <div className="flex justify-between text-muted-foreground border-b border-0 pb-1 mb-1">
                              <span>Expiry:</span>
                              <span className="text-foreground">{oiData.expiryDate}</span>
                            </div>
                            <div className="flex justify-between text-muted-foreground border-b border-0 pb-1 mb-1">
                              <span>Strike:</span>
                              <span className="text-foreground">{nearestStrike}</span>
                            </div>
                            <div className="flex justify-between" style={{ color: oiCallColor }}>
                              <span>CE OI:</span>
                              <span>{formatOi(ce?.oi)}</span>
                            </div>
                            <div className="flex justify-between pb-1 mb-1" style={{ color: oiCallColor }}>
                              <span>CE OI Chg:</span>
                              <span>{formatOi(ce?.chgOi)} ({(ce?.oi && (ce.oi - (ce?.chgOi || 0)) > 0) ? (((ce?.chgOi || 0) / (ce.oi - (ce?.chgOi || 0))) * 100).toFixed(1) : '0.0'}%)</span>
                            </div>
                            <div className="flex justify-between pb-1 text-muted-foreground mb-1">
                              <span>CE IV:</span>
                              <span>{(ce?.iv || 0).toFixed(1)}%</span>
                            </div>
                            <div className="flex justify-center pb-1 border-b border-0 mb-1">
                              <span className={`text-[10px] font-bold ${getSentimentColor(ceSentimentLabel)}`}>{ceSentimentLabel}</span>
                            </div>
                            <div className="flex justify-between" style={{ color: oiPutColor }}>
                              <span>PE OI:</span>
                              <span>{formatOi(pe?.oi)}</span>
                            </div>
                            <div className="flex justify-between pb-1 mb-1" style={{ color: oiPutColor }}>
                              <span>PE OI Chg:</span>
                              <span>{formatOi(pe?.chgOi)} ({(pe?.oi && (pe.oi - (pe?.chgOi || 0)) > 0) ? (((pe?.chgOi || 0) / (pe.oi - (pe?.chgOi || 0))) * 100).toFixed(1) : '0.0'}%)</span>
                            </div>
                            <div className="flex justify-between pb-1 text-muted-foreground mb-1">
                              <span>PE IV:</span>
                              <span>{(pe?.iv || 0).toFixed(1)}%</span>
                            </div>
                            <div className="flex justify-center pb-1 border-b border-0 mb-1">
                              <span className={`text-[10px] font-bold ${getSentimentColor(peSentimentLabel)}`}>{peSentimentLabel}</span>
                            </div>
                         </div>
                       );
                     }
                   }
                }
              }
              return null;
            })()}
            
            {clickMenu && (
              <div 
                className="absolute z-[100] bg-popover border border-0 rounded-lg p-2 flex flex-col gap-1.5 w-[160px] transition-all duration-150 animate-in fade-in zoom-in-95"
                style={{
                  top: `${Math.max(5, Math.min(clickMenu.y, (chartContainerRef.current?.getBoundingClientRect().height || 450) - 170))}px`,
                  left: `${Math.min(clickMenu.x, (chartContainerRef.current?.getBoundingClientRect().width || 600) - 175)}px`,
                }}
              >
                <div className="text-[10px] font-semibold text-muted-foreground border-b border-0 pb-1 mb-0.5 px-1 flex justify-between items-center">
                  <span>Strike Click</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setClickMenu(null); }} className="text-muted-foreground hover:text-foreground transition-colors text-xs font-bold font-mono">✕</button>
                </div>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('BUY', 'CE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-transparent hover:bg-emerald-500/20 border border-emerald-500/30 rounded px-2 py-1 text-emerald-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Buy Call</span>
                  <span className="text-[9px] bg-emerald-500/20 px-1 rounded text-emerald-400">CE</span>
                </button>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('SELL', 'CE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-transparent hover:bg-rose-500/20 border border-rose-500/30 rounded px-2 py-1 text-rose-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Sell Call</span>
                  <span className="text-[9px] bg-rose-500/20 px-1 rounded text-rose-400">CE</span>
                </button>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('BUY', 'PE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-transparent hover:bg-emerald-500/20 border border-emerald-500/30 rounded px-2 py-1 text-emerald-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Buy Put</span>
                  <span className="text-[9px] bg-emerald-500/20 px-1 rounded text-emerald-400">PE</span>
                </button>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('SELL', 'PE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-transparent hover:bg-rose-500/20 border border-rose-500/30 rounded px-2 py-1 text-rose-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Sell Put</span>
                  <span className="text-[9px] bg-rose-500/20 px-1 rounded text-rose-400">PE</span>
                </button>
              </div>
            )}

            {isProcessingStrikeAction && (
              <div className="absolute inset-0 z-[120] bg-muted backdrop-blur-[1px] flex items-center justify-center rounded-xl">
                <div className="bg-card border border-0 px-4 py-3 rounded-lg flex items-center gap-2.5 ">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  <span className="text-xs text-slate-250 font-medium text-foreground/90">Resolving option strike details...</span>
                </div>
              </div>
            )}
          </div>
          {/* RSI Chart */}
          <div className={`relative w-full ${!showRsi ? 'hidden' : ''}`} style={{ height: "200px", minHeight: "200px" }}>
            <div
              ref={rsiContainerRef}
              className="bg-card border border-0 rounded-xl overflow-hidden w-full h-full absolute inset-0"
            />
            {rsiHoverValue && (
               <div className="absolute top-2 left-2 z-10 text-xs font-mono font-medium text-cyan-400">
                  RSI: {rsiHoverValue}
               </div>
            )}
          </div>
        </div>
      )}
      
      {editingLineId && (
        <LineEditorModal
          lineId={editingLineId}
          initialPrice={manualLinesRef.current.find((l: any) => l.id === editingLineId)?.price || 0}
          initialColor={manualLinesRef.current.find((l: any) => l.id === editingLineId)?.color || '#facc15'}
          initialLineWidth={manualLinesRef.current.find((l: any) => l.id === editingLineId)?.lineWidth || 2}
          initialLineStyle={manualLinesRef.current.find((l: any) => l.id === editingLineId)?.lineStyle || 0}
          initialLabelVisible={manualLinesRef.current.find((l: any) => l.id === editingLineId)?.axisLabelVisible ?? true}
          initialTitle={manualLinesRef.current.find((l: any) => l.id === editingLineId)?.title || ''}
          onClose={() => setEditingLineId(null)}
          onDelete={() => {
            const idx = manualLinesRef.current.findIndex((l: any) => l.id === editingLineId);
            if (idx > -1) {
              try { mainSeriesRef.current?.removePriceLine(manualLinesRef.current[idx].instance); } catch(e){}
              manualLinesRef.current.splice(idx, 1);
              setManualLineIds(prev => prev.filter(l => l.id !== editingLineId));
            }
            setEditingLineId(null);
          }}
          onChange={(price, color, lineWidth, lineStyle, labelVisible, title) => {
            const idx = manualLinesRef.current.findIndex((l: any) => l.id === editingLineId);
            if (idx > -1) {
              const lineData = manualLinesRef.current[idx];
              try {
                lineData.instance.applyOptions({
                  price: price,
                  color: color,
                  lineWidth: lineWidth,
                  lineStyle: lineStyle,
                  axisLabelVisible: labelVisible,
                  title: title
                });
                lineData.price = price;
                lineData.color = color;
                lineData.lineWidth = lineWidth;
                lineData.lineStyle = lineStyle;
                lineData.axisLabelVisible = labelVisible;
                lineData.title = title;
              } catch(e){}
            }
          }}
          onApply={(price, color, lineWidth, lineStyle, labelVisible, title) => {
            const idx = manualLinesRef.current.findIndex((l: any) => l.id === editingLineId);
            if (idx > -1) {
              const lineData = manualLinesRef.current[idx];
              try {
                lineData.instance.applyOptions({
                  price: price,
                  color: color,
                  lineWidth: lineWidth,
                  lineStyle: lineStyle,
                  axisLabelVisible: labelVisible,
                  title: title
                });
                lineData.price = price;
                lineData.color = color;
                lineData.lineWidth = lineWidth;
                lineData.lineStyle = lineStyle;
                lineData.axisLabelVisible = labelVisible;
                lineData.title = title;
                setManualLineIds(prev => prev.map(l => l.id === editingLineId ? { ...l, price, color, lineWidth, lineStyle, axisLabelVisible: labelVisible, title } : l));
              } catch(e){}
            }
            setEditingLineId(null);
          }}
        />
      )}

      {isEditingPdhPdl && (
        <PdhPdlEditorModal
          initialPdhColor={pdhColor}
          initialPdlColor={pdlColor}
          initialLineWidth={pdhPdlWidth}
          initialLineStyle={pdhPdlStyle}
          onClose={() => setIsEditingPdhPdl(false)}
          onApply={(newPdhC, newPdlC, newLw, newLs) => {
            setPdhColor(newPdhC);
            setPdlColor(newPdlC);
            setPdhPdlWidth(newLw);
            setPdhPdlStyle(newLs);
            setIsEditingPdhPdl(false);
          }}
        />
      )}

      {isEditingSnR && (
        <SnREditorModal
          initialSupportColor={supportColor}
          initialResistanceColor={resistanceColor}
          initialLineWidth={snrWidth}
          initialLineStyle={snrStyle}
          onClose={() => setIsEditingSnR(false)}
          onApply={(supC, resC, w, s) => {
            setSupportColor(supC);
            setResistanceColor(resC);
            setSnrWidth(w);
            setSnrStyle(s);
            setIsEditingSnR(false);
          }}
        />
      )}

      {isEditingBB && (
        <BBEditorModal
          initialPeriod={bbPeriod}
          initialStdDev={bbStdDev}
          initialColor={bbColor}
          onClose={() => setIsEditingBB(false)}
          onApply={(period, stdDev, color) => {
            setBbPeriod(period);
            setBbStdDev(stdDev);
            setBbColor(color);
            setIsEditingBB(false);
          }}
        />
      )}

      {isEditingOiBars && (
        <OiBarsEditorModal
          initialMaxBarWidth={oiMaxBarWidth}
          initialGap={oiBarGap}
          initialBarThickness={oiBarThickness}
          initialCallColor={oiCallColor}
          initialPutColor={oiPutColor}
          onClose={() => setIsEditingOiBars(false)}
          onApply={(maxBarWidth, gap, barThickness, callColor, putColor) => {
            setOiMaxBarWidth(maxBarWidth);
            setOiBarGap(gap);
            setOiBarThickness(barThickness);
            setOiCallColor(callColor);
            setOiPutColor(putColor);
            setIsEditingOiBars(false);
          }}
          onChange={(maxBarWidth, gap, barThickness, callColor, putColor) => {
            setOiMaxBarWidth(maxBarWidth);
            setOiBarGap(gap);
            setOiBarThickness(barThickness);
            setOiCallColor(callColor);
            setOiPutColor(putColor);
          }}
        />
      )}

      {isEditingRsi && (
        <RsiEditorModal
          initialColor={rsiColor}
          initialLineWidth={rsiLineWidth}
          initialLineStyle={rsiLineStyle}
          initialSmaLineWidth={rsiSmaLineWidth}
          initialSmaLineStyle={rsiSmaLineStyle}
          initialOverbought1={rsiOverbought1}
          initialOverbought2={rsiOverbought2}
          initialOversold1={rsiOversold1}
          initialOversold2={rsiOversold2}
          initialSmaColor={rsiSmaColor}
          initialOverboughtColor={rsiOverboughtColor}
          initialOversoldColor={rsiOversoldColor}
          onClose={() => setIsEditingRsi(false)}
          onApply={(color, lineWidth, lineStyle, smaLineWidth, smaLineStyle, overbought1, overbought2, oversold1, oversold2, smaColor, overboughtColor, oversoldColor) => {
            setRsiColor(color);
            setRsiLineWidth(lineWidth);
            setRsiLineStyle(lineStyle);
            setRsiSmaLineWidth(smaLineWidth);
            setRsiSmaLineStyle(smaLineStyle);
            setRsiOverbought1(overbought1);
            setRsiOverbought2(overbought2);
            setRsiOversold1(oversold1);
            setRsiOversold2(oversold2);
            setRsiSmaColor(smaColor);
            setRsiOverboughtColor(overboughtColor);
            setRsiOversoldColor(oversoldColor);
            setIsEditingRsi(false);
          }}
          onChange={(color, lineWidth, lineStyle, smaLineWidth, smaLineStyle, overbought1, overbought2, oversold1, oversold2, smaColor, overboughtColor, oversoldColor) => {
            setRsiColor(color);
            setRsiLineWidth(lineWidth);
            setRsiLineStyle(lineStyle);
            setRsiSmaLineWidth(smaLineWidth);
            setRsiSmaLineStyle(smaLineStyle);
            setRsiOverbought1(overbought1);
            setRsiOverbought2(overbought2);
            setRsiOversold1(oversold1);
            setRsiOversold2(oversold2);
            setRsiSmaColor(smaColor);
            setRsiOverboughtColor(overboughtColor);
            setRsiOversoldColor(oversoldColor);
          }}
        />
      )}

      {isEditingHLevels && (
        <HLevelsEditorModal
          initialLevels={hLevels}
          initialLineStyle={hLevelsStyle}
          initialLineWidth={hLevelsWidth}
          initialShowFiftyPercent={showFiftyPercentLevels}
          initialFiftyPercentColor={fiftyPercentColor}
          spotPrice={chartData?.spot || (chartData?.candles && chartData.candles.length > 0 ? chartData.candles[chartData.candles.length - 1].close : undefined)}
          onClose={() => setIsEditingHLevels(false)}
          onApply={(levels, style, width, showFifty, fiftyColor) => {
            setHLevels(levels);
            setHLevelsStyle(style);
            setHLevelsWidth(width);
            setShowFiftyPercentLevels(showFifty);
            setFiftyPercentColor(fiftyColor);
            setIsEditingHLevels(false);
          }}
        />
      )}

      {showOrderTicket && ticketData && (
        <OrderTicketModal
          ticket={ticketData}
          expiries={availableExpiries}
          onExpiryChange={handleExpiryChange}
          onClose={() => setShowOrderTicket(false)}
          onSubmit={handleOrderSubmit}
          processing={isProcessingStrikeAction}
          availBalance={availBalance}
          setAvailBalance={setAvailBalance}
          onRefreshBalance={fetchKiteBalance}
        />
      )}
    </div>
  );
}


