import React, { useMemo, useRef, useState, useEffect } from "react";
import { useQuery, keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, Plus, ChevronDown, Check, Eye, Settings, Edit2, Zap, SlidersHorizontal, RefreshCw, Cpu, ChevronsRight } from "lucide-react";
import { toast } from "sonner";
import { notificationService } from "../lib/notificationService";
import { getDivergences } from "../lib/divergence";
import { evaluateBreakout } from "../lib/breakoutQuality";
import { calculateBollingerBands } from "../indicators/bollingerBands";
import { format } from "date-fns";
import { SymbolSearch } from "../components/SymbolSearch";
import AiMarketRead from "../components/AiMarketRead";
import MarketContext from "../components/MarketContext";
import BounceConviction from "../components/BounceConviction";
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

// (A previous global canvas patch rounded every candle/volume bar's corners.
// Removed per user request — candles and volume bars now render in the
// library's default sharp rectangular shapes.)

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
              {prettyOptionName(ticket.tradingsymbol, ticket.expiry)}
            </span>
          </div>
          {/* LTP lives here now that the metadata block is gone — it is the one
              number from that block worth keeping in view while confirming. */}
          <span className={`font-bold font-mono text-sm ml-auto mr-3 px-1.5 py-0.5 rounded transition-all duration-300 ${
            priceDirection === 'UP' ? 'text-emerald-400 bg-emerald-500/10'
            : priceDirection === 'DOWN' ? 'text-rose-400 bg-rose-500/10'
            : 'text-primary'
          }`}>
            ₹{liveLtp.toFixed(2)}
          </span>
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
          </div>

          {/* Missing Lot Size Alert Box */}
          {!lotSize && (
            <div className="bg-rose-950/30 border border-rose-500/35 p-3 rounded-lg text-xs flex flex-col gap-1.5 mt-2 animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="flex items-center gap-1.5 text-rose-450 text-rose-400 font-semibold">
                <span>⚠️ Lot size unavailable. Refresh instruments.</span>
              </div>
              <div className="text-muted-foreground text-[11px] leading-relaxed">
                Options require a dynamic lot size from the latest instrument master. Click below to refresh the cached database.
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

// Live Indian-market clock shown beside the chart title: HH:MM:SS in 12-hour
// format. Renders ONLY during the NSE session (09:15 -> 15:30 IST, Mon-Fri) and
// disappears outside it. Self-contained so the per-second state change
// re-renders this pill alone, never the (very large) chart component.
const IstSessionClock = () => {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // IST is UTC+5:30 with no DST, so this offset is exact (same approach the
  // canvas badges use).
  const ist = new Date(now + 5.5 * 60 * 60 * 1000);
  const istDay = ist.getUTCDay();
  const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Matches the server's NSE window: open at 09:15, closed from 15:30.
  const marketOpen = istDay !== 0 && istDay !== 6 && istMinutes >= 9 * 60 + 15 && istMinutes < 15 * 60 + 30;

  const two = (n: number) => String(n).padStart(2, '0');
  const h24 = ist.getUTCHours();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const clock = `${two(h12)}:${two(ist.getUTCMinutes())}:${two(ist.getUTCSeconds())} ${ampm}`;

  // Only visible while the Indian market is open.
  if (!marketOpen) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 select-none whitespace-nowrap font-mono text-sm md:text-base font-bold text-emerald-400"
      title="Indian market open (IST)"
    >
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
      {clock}
      <span className="text-muted-foreground/80 font-normal text-xs md:text-sm">IST</span>
    </span>
  );
};

// Live P&L chip for the active position — replaces the old EXIT banner in the
// tab strip. Reads the broker-updated position from localStorage every 2s.
const TradePnl = ({ sync }: { sync: string }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(iv);
  }, []);
  let pos: any = null;
  try {
    const arr = JSON.parse(localStorage.getItem('active_positions') || '[]');
    pos = Array.isArray(arr) && arr.length ? arr[0] : null;
  } catch (e) { pos = null; }
  if (!pos || !pos.entryPrice) return null;
  const qty = Number(pos.qty ?? pos.quantity ?? 0);
  const px = Number(pos.currentPrice || pos.entryPrice);
  const diff = pos.side === 'BUY' ? px - pos.entryPrice : pos.entryPrice - px;
  const pnl = diff * qty;
  const pct = pos.entryPrice ? (diff / pos.entryPrice) * 100 : 0;
  const up = pnl >= 0;
  return (
    <span className={`ml-auto px-2.5 h-7 inline-flex items-center gap-1.5 rounded-md text-xs font-mono font-bold whitespace-nowrap ${up ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}
      title={sync === 'ACTIVE' ? 'Live P&L — SL/TP armed' : sync === 'ERROR' ? 'Live P&L — SL/TP NOT armed!' : 'Live P&L'}>
      {up ? '+' : ''}₹{pnl.toFixed(0)}
      <span className="opacity-70">({up ? '+' : ''}{pct.toFixed(1)}%)</span>
      {sync === 'ERROR' && <span className="text-amber-400 font-bold" title="SL/TP rule failed to arm — drag a line to retry">!</span>}
      {sync === 'SYNCING' && <span className="opacity-60">…</span>}
    </span>
  );
};

// Fair Value Gap scan — 3-candle imbalance. Bullish: candle[i+1]'s low sits
// ABOVE candle[i-1]'s high (that empty space is the gap); bearish mirrored.
// A gap is FILLED once any later candle trades fully through it; filled gaps
// disappear. Definition matches the Sweep & Reclaim backtest exactly, so the
// chart shows precisely what the data tested. Gaps under FVG_MIN_PTS are noise
// and skipped; only the most recent FVG_MAX_ZONES unfilled gaps are drawn.
const FVG_MIN_PTS = 4;
const FVG_MAX_ZONES = 8;
function computeFvgZones(candles: any[]): any[] {
  // Adaptive minimum: on violent days (big candles) small imbalances form
  // everywhere and mean nothing — the bar scales with recent candle size.
  // Calm 5-min day: ~4 pts (unchanged). Panic day: roughly double.
  const tail = candles.slice(-20);
  const avgRange = tail.length ? tail.reduce((a: number, c: any) => a + (c.high - c.low), 0) / tail.length : 0;
  const minGap = Math.max(FVG_MIN_PTS, +(0.3 * avgRange).toFixed(1));

  const zones: any[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1], c = candles[i + 1];
    if (c.low > a.high && c.low - a.high >= minGap) {
      zones.push({ type: 'bull', top: c.low, bottom: a.high, time: candles[i].time, born: i });
    } else if (c.high < a.low && a.low - c.high >= minGap) {
      zones.push({ type: 'bear', top: a.low, bottom: c.high, time: candles[i].time, born: i });
    }
  }
  // Mitigation: price entering a gap consumes it — the box shrinks to the
  // remaining unfilled slice and disappears when fully eaten (or when only a
  // sliver under half the minimum is left).
  const live: any[] = [];
  for (const z of zones) {
    let top = z.top, bottom = z.bottom, dead = false;
    for (let k = z.born + 2; k < candles.length && !dead; k++) {
      if (z.type === 'bull') {
        if (candles[k].low <= bottom) dead = true;
        else if (candles[k].low < top) top = candles[k].low;
      } else {
        if (candles[k].high >= top) dead = true;
        else if (candles[k].high > bottom) bottom = candles[k].high;
      }
    }
    if (!dead && top - bottom >= minGap * 0.5) live.push({ ...z, top, bottom });
  }
  return live.slice(-FVG_MAX_ZONES);
}

// Order Blocks — the last opposite-colour candle before a decisive move away.
// Bullish: a DOWN-close candle whose very next candle CLOSES above its high, with
// the push from the block's low to that close big enough to count as displacement
// rather than noise. Bearish is mirrored. The block is the origin candle's full
// range (high..low), which is the zone price tends to revisit.
//
// VALIDITY — the point of this indicator. A block stops extending to the right the
// moment either happens, whichever comes FIRST:
//   * a NEW order block forms  -> the old one is superseded and its box ends there;
//   * a candle CLOSES right through it (below a bullish block, above a bearish one)
//     -> the block failed and its box ends there.
// Only the newest surviving block keeps running to the current candle. That is why
// old boxes on the chart have a hard right edge instead of stretching forever.
//
// Lookahead-free: a block needs its confirming candle to have CLOSED, so nothing is
// ever drawn using information the market had not yet produced.
const OB_MIN_PTS = 10;
const OB_MAX_ZONES = 6;
// MARKET STRUCTURE — Break of Structure and Change of Character.
//
// The two are opposites and must never be confused, so the rule is written out:
// swing points are marked first (a swing high is a candle whose high beats the two
// candles either side; a swing low is the mirror). Then, when a candle CLOSES
// through the most recent swing level:
//   * in the SAME direction as the current trend  -> BOS   (trend continues)
//   * AGAINST the current trend                   -> CHoCH (trend may be turning)
// A break upward while already in an uptrend is continuation; the same break while
// in a downtrend is the first sign of a turn. Labelling one as the other would
// invert the message entirely.
//
// Uses CLOSES, not wicks: a wick through a level is a probe, a close through it is
// a decision. Lookahead-free — a swing is only confirmed once the two candles after
// it exist, and nothing is drawn before its breaking candle has closed.
const STRUCT_LOOKBACK = 2;   // candles either side that define a swing
const STRUCT_MAX = 6;        // most recent events kept on the chart
function computeMarketStructure(candles: any[]): any[] {
  if (!candles || candles.length < STRUCT_LOOKBACK * 2 + 3) return [];
  const n = STRUCT_LOOKBACK;

  // Swings, confirmed only when the candles either side exist.
  const swings: { i: number; price: number; kind: 'H' | 'L' }[] = [];
  for (let i = n; i < candles.length - n; i++) {
    let isHigh = true, isLow = true;
    for (let k = i - n; k <= i + n; k++) {
      if (k === i) continue;
      if (candles[k].high >= candles[i].high) isHigh = false;
      if (candles[k].low <= candles[i].low) isLow = false;
    }
    if (isHigh) swings.push({ i, price: candles[i].high, kind: 'H' });
    else if (isLow) swings.push({ i, price: candles[i].low, kind: 'L' });
  }
  if (!swings.length) return [];

  const events: any[] = [];
  let trend: 'UP' | 'DOWN' | null = null;
  let lastHigh: { i: number; price: number } | null = null;
  let lastLow: { i: number; price: number } | null = null;
  let si = 0;

  for (let i = 0; i < candles.length; i++) {
    // A swing only becomes usable n candles after it forms — that is when it is
    // confirmed, and using it earlier would be reading the future.
    while (si < swings.length && swings[si].i + n <= i) {
      const sw = swings[si++];
      if (sw.kind === 'H') lastHigh = { i: sw.i, price: sw.price };
      else lastLow = { i: sw.i, price: sw.price };
    }
    const c = candles[i];

    if (lastHigh && c.close > lastHigh.price) {
      const type = trend === 'DOWN' ? 'CHOCH' : 'BOS';
      events.push({ type, dir: 'bull', level: lastHigh.price,
        fromTime: candles[lastHigh.i].time, toTime: c.time, born: i });
      trend = 'UP';
      lastHigh = null;              // consumed; wait for the next swing high
    } else if (lastLow && c.close < lastLow.price) {
      const type = trend === 'UP' ? 'CHOCH' : 'BOS';
      events.push({ type, dir: 'bear', level: lastLow.price,
        fromTime: candles[lastLow.i].time, toTime: c.time, born: i });
      trend = 'DOWN';
      lastLow = null;
    }
  }
  return events.slice(-STRUCT_MAX);
}

function computeOrderBlocks(candles: any[]): any[] {
  if (!candles || candles.length < 3) return [];
  // Displacement bar scales with recent candle size, so a violent day needs a bigger
  // push to qualify and a calm day still finds real blocks.
  const tail = candles.slice(-20);
  const avgRange = tail.length ? tail.reduce((a: number, c: any) => a + (c.high - c.low), 0) / tail.length : 0;
  const minDisp = Math.max(OB_MIN_PTS, +(1.2 * avgRange).toFixed(1));

  const found: any[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i], n = candles[i + 1];
    if (!c || !n) continue;
    const bull = c.close < c.open && n.close > c.high && (n.close - c.low) >= minDisp;
    const bear = c.close > c.open && n.close < c.low && (c.high - n.close) >= minDisp;
    if (!bull && !bear) continue;
    // Back-to-back candidates describe one move, not two blocks — keep the first.
    if (found.length && i - found[found.length - 1].born <= 1) continue;
    found.push({ type: bull ? 'bull' : 'bear', top: c.high, bottom: c.low, time: c.time, born: i });
  }

  // Close each block off: superseded by the next block, or broken by a close through it.
  for (let k = 0; k < found.length; k++) {
    const z = found[k];
    const supersededAt = k + 1 < found.length ? found[k + 1].born : Infinity;
    let endIdx: number | null = null;
    let endReason = '';
    for (let m = z.born + 2; m < candles.length; m++) {
      if (m >= supersededAt) { endIdx = supersededAt; endReason = 'superseded'; break; }
      const cc = candles[m];
      if (z.type === 'bull' ? cc.close < z.bottom : cc.close > z.top) { endIdx = m; endReason = 'broken'; break; }
    }
    if (endIdx !== null && endIdx < candles.length) {
      z.endTime = candles[endIdx].time;
      z.endReason = endReason;
    } else {
      z.endTime = null;   // still live — this one keeps running to the current candle
      z.endReason = 'live';
    }
  }
  return found.slice(-OB_MAX_ZONES);
}

// Turn a Zerodha option tradingsymbol into something readable at a glance.
// BANKNIFTY27MAR58500CE  ->  BANK NIFTY 58500 CE 27 MAR   (monthly)
// NIFTY2582124350CE      ->  NIFTY 24350 CE 21 AUG        (weekly)
// Both layouts exist and differ, so each is matched explicitly; anything that
// fits neither is returned UNCHANGED rather than half-parsed into a wrong
// strike, which on a trading screen is worse than an ugly symbol.
const UNDERLYING_LABEL: Record<string, string> = {
  BANKNIFTY: 'BANK NIFTY', FINNIFTY: 'FIN NIFTY', MIDCPNIFTY: 'MIDCAP NIFTY',
  NIFTY: 'NIFTY', SENSEX: 'SENSEX', BANKEX: 'BANKEX',
};
const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
// Weekly symbols compress the month to one character: 1-9, then O, N, D.
const WEEKLY_MONTH: Record<string, number> = {
  '1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'O':10,'N':11,'D':12,
};
/** "2027-03-30" -> "30th Mar 2027". The YEAR is kept whenever it is not the
 *  current one: a March 2027 contract and a March 2026 contract would otherwise
 *  read identically, and on a trading screen that is a mistake waiting to be made. */
export function prettyExpiry(iso: string): string | null {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const monIdx = parseInt(mo, 10) - 1;
  if (monIdx < 0 || monIdx > 11) return null;
  const day = parseInt(d, 10);
  const suffix = (day % 10 === 1 && day !== 11) ? 'st'
    : (day % 10 === 2 && day !== 12) ? 'nd'
    : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][monIdx];
  const thisYear = new Date().getFullYear();
  return `${day}${suffix} ${mon}${parseInt(y, 10) === thisYear ? '' : ' ' + y}`;
}

/** The expiry DAY is not in a monthly tradingsymbol — BANKNIFTY27MAR58500CE only
 *  says March 2027 — so when the real date is known (from Kite's contract master)
 *  it is passed in and used. Without it we fall back to what the symbol can prove. */
export function prettyOptionName(tradingsymbol: string, expiryIso?: string | null): string {
  const ts = String(tradingsymbol || '').trim().toUpperCase();
  if (!ts) return tradingsymbol;
  const m = ts.match(/^([A-Z]+?)(\d.*)(CE|PE)$/);
  if (!m) return tradingsymbol;
  const [, rawUnder, middle, type] = m;
  const under = UNDERLYING_LABEL[rawUnder] || rawUnder;

  // MONTHLY: the two digits are the YEAR, not a day — BANKNIFTY27MAR58500CE is
  // March 2027. Printing "27 MAR" would read as the 27th and mislead on a
  // trading screen, so monthlies show the month and year instead.
  const pretty = expiryIso ? prettyExpiry(expiryIso) : null;

  const monthly = middle.match(/^(\d{2})([A-Z]{3})(\d+)$/);
  if (monthly && MONTH_ABBR.includes(monthly[2])) {
    return pretty
      ? `${under} ${monthly[3]} ${type} (${pretty})`
      : `${under} ${monthly[3]} ${type} ${monthly[2]} 20${monthly[1]}`;
  }
  const weekly = middle.match(/^(\d{2})([1-9OND])(\d{2})(\d+)$/);
  if (weekly) {
    const mon = WEEKLY_MONTH[weekly[2]];
    const day = weekly[3];
    if (mon) return pretty
      ? `${under} ${weekly[4]} ${type} (${pretty})`
      : `${under} ${weekly[4]} ${type} ${day} ${MONTH_ABBR[mon - 1]}`;
  }
  return tradingsymbol;
}

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
    panel.className = 'ohlc-panel absolute top-2 left-2 z-[20] flex flex-col items-start gap-y-0.5 text-[10px] leading-tight font-mono select-none pointer-events-none max-w-[calc(100%-92px)]';
    panel.style.display = 'none';
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
  const { open, high, low, close } = candle;
  const changeInfo = formatChange(open, close);

  panel.style.textShadow = '0 1px 3px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)';
  panel.innerHTML = `
    <div style="display:flex; flex-wrap:nowrap; align-items:center; gap:0 10px; white-space:nowrap;">
      <span style="color: #64748b;">O <span style="color: #cbd5e1;">${formatPrice(open)}</span></span>
      <span style="color: #64748b;">H <span style="color: #cbd5e1;">${formatPrice(high)}</span></span>
      <span style="color: #64748b;">L <span style="color: #cbd5e1;">${formatPrice(low)}</span></span>
      <span style="color: #64748b;">C <span style="color: #cbd5e1;">${formatPrice(close)}</span></span>
      <span style="color: ${changeInfo.color}; font-weight: 500;">${changeInfo.text}</span>
    </div>
    <div style="white-space:nowrap;">
      <span style="color: #64748b;">Vol <span style="color: #cbd5e1;">${formatVolume(volume)}</span></span>
    </div>
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

// True only until the chart mounts for the first time this session. On that first
// mount we always jump to the latest candles (today) and ignore any persisted
// logical range, which is a stale bar-index window from a previous session and
// would otherwise drop the user in the past. Restored ranges still apply on later
// in-session rebuilds (timeframe/symbol switches).
let chartFirstLoadDone = false;
// Persist the X-axis (time zoom) across refreshes: hydrate the in-memory cache
// from localStorage at load, and write it back (debounced) whenever it changes.
try {
  const savedRanges = JSON.parse(localStorage.getItem('chartLogicalRanges') || '{}');
  if (savedRanges && typeof savedRanges === 'object') Object.assign(globalLogicalRangeCache, savedRanges);
} catch (e) { /* ignore */ }
let logicalRangePersistTimer: any = null;
function persistLogicalRanges() {
  if (logicalRangePersistTimer) clearTimeout(logicalRangePersistTimer);
  logicalRangePersistTimer = setTimeout(() => {
    try {
      const keys = Object.keys(globalLogicalRangeCache);
      // cap stored keys to the 20 most recently present to keep the entry small
      const slim: Record<string, any> = {};
      keys.slice(-20).forEach(k => { slim[k] = globalLogicalRangeCache[k]; });
      localStorage.setItem('chartLogicalRanges', JSON.stringify(slim));
    } catch (e) { /* ignore */ }
  }, 800);
}

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
  // Cooldown so a persistent clock desync can't trigger a reseed storm.
  const lastDesyncReseedRef = useRef<number>(0);
  // Cooldown for the closed-bar audit below, so a reseed can never loop.
  const lastTailReseedRef = useRef<number>(0);
  // The fixed bottom toolbar. Measured live so the chart can be sized to stop
  // exactly where it starts, instead of trusting a hard-coded height in the
  // page's calc() — which is what has been wrong all along.
  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  const lastCandleDataRef = useRef<any>(null);
  // Candles that COMPLETED after the initial fetch. The fetched history is frozen
  // (tick-driven chart, no refetch), so without this archive every candle that
  // closes after page load silently drops out of live indicator windows --
  // Bollinger Bands drifted stale until a manual refresh (the reported bug).
  const liveClosedCandlesRef = useRef<any[]>([]);
  const chartDataRef = useRef<any>(null);
  const confSignalsRef = useRef<any[]>([]);
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
  const [showOpeningRange, setShowOpeningRange] = useState(() => {
    try {
      const v = localStorage.getItem('showOpeningRange');
      return v === null ? true : v === 'true'; // default on (preserves current behaviour)
    } catch(e) {}
    return true;
  });
  // Order Blocks — index chart only, like the FVG zones.
  // Confluence buy/sell signals — forward-test arrows, drawn from the server's
  // log so they can never repaint. 5-minute index charts only.
  const [showConfSignals, setShowConfSignals] = useState(() => {
    try { const v = localStorage.getItem('showConfSignals'); return v === null ? true : v === 'true'; } catch (e) { return true; }
  });
  // Market structure — index charts only, like the other index studies.
  const [showStructure, setShowStructure] = useState(() => {
    try { const v = localStorage.getItem('showStructure'); return v === null ? true : v === 'true'; } catch (e) { return true; }
  });
  const [showOrderBlocks, setShowOrderBlocks] = useState(() => {
    try { const v = localStorage.getItem('showOrderBlocks'); return v === null ? true : v === 'true'; } catch (e) { return true; }
  });
  // Fair Value Gaps — drawn like Demand/Supply zones, index chart only.
  const [showFvg, setShowFvg] = useState(() => {
    try { const v = localStorage.getItem('showFvg'); return v === null ? true : v === 'true'; } catch (e) { return true; }
  });
  const [showDsZones, setShowDsZones] = useState(() => {
    try {
      const v = localStorage.getItem('showDsZones');
      return v === null ? true : v === 'true'; // default on
    } catch(e) {}
    return true;
  });
  const [dsZoneOpacity, setDsZoneOpacity] = useState<string>(() => {
    try { return localStorage.getItem('dsZoneOpacity') || '8'; } catch(e) {}
    return '8';
  });
  useEffect(() => {
    try { localStorage.setItem('dsZoneOpacity', dsZoneOpacity); } catch(e) {}
  }, [dsZoneOpacity]);
  const [levelAlertsOn, setLevelAlertsOn] = useState(() => {
    try { return localStorage.getItem('levelAlertsOn') === 'true'; } catch(e) {}
    return false;
  });
  // RSI pane scale range (persisted). Empty = full 0–100. The library offers no
  // getter for a manually-dragged scale range, so the zoom is made a setting.
  const rsiScaleRef = useRef<{ min: number | null; max: number | null }>({ min: null, max: null });
  // Y-axis lock for the main price scale: captures the currently-visible price
  // range (computed from pane coordinates — the library has no getter for a
  // dragged scale) and pins + persists it per instrument+timeframe.
  const yLockRef = useRef<{ min: number; max: number } | null>(null);
  const [yLocked, setYLocked] = useState(false);
  // Level-touch alert engine (refs so the tick handler always sees fresh values
  // without re-subscribing). levels: [{key,label,price}]. armed: per-key re-arm state.
  const alertLevelsRef = useRef<{ key: string; label: string; price: number }[]>([]);
  const alertPrevSpotRef = useRef<number | null>(null);
  const alertStateRef = useRef<Map<string, { lastFired: number; armed: boolean }>>(new Map());
  const levelAlertsOnRef = useRef(levelAlertsOn);
  useEffect(() => { levelAlertsOnRef.current = levelAlertsOn; }, [levelAlertsOn]);

  // Live futures "pressure" proxy (from the server delta broadcast) + latest
  // breakout-authenticity verdict. deltaRef holds the freshest value for use
  // inside effects without re-subscribing.
  const [deltaInfo, setDeltaInfo] = useState<{ pressure: number; dayBias: number; cvd: number } | null>(null);
  const deltaRef = useRef<{ pressure: number; dayBias: number; cvd: number } | null>(null);
  const [breakoutInfo, setBreakoutInfo] = useState<any>(null);
  const lastBreakoutBarRef = useRef<number>(0);
  const [breakoutAlertsOn, setBreakoutAlertsOn] = useState(() => {
    try { return localStorage.getItem('breakoutAlertsOn') === 'true'; } catch(e) {}
    return false;
  });
  const breakoutAlertsOnRef = useRef(breakoutAlertsOn);
  useEffect(() => {
    breakoutAlertsOnRef.current = breakoutAlertsOn;
    try { localStorage.setItem('breakoutAlertsOn', String(breakoutAlertsOn)); } catch(e) {}
    if (breakoutAlertsOn && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch(e) {}
    }
  }, [breakoutAlertsOn]);
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
      localStorage.setItem('showOpeningRange', String(showOpeningRange));
    } catch(e) {}
  }, [showOpeningRange]);

  useEffect(() => {
    try {
      localStorage.setItem('showDsZones', String(showDsZones));
    } catch(e) {}
  }, [showDsZones]);
  useEffect(() => {
    try { localStorage.setItem('showFvg', String(showFvg)); } catch (e) {}
  }, [showFvg]);
  useEffect(() => {
    try { localStorage.setItem('showOrderBlocks', String(showOrderBlocks)); } catch (e) {}
  }, [showOrderBlocks]);
  useEffect(() => {
    try { localStorage.setItem('showStructure', String(showStructure)); } catch (e) {}
  }, [showStructure]);
  useEffect(() => {
    try { localStorage.setItem('showConfSignals', String(showConfSignals)); } catch (e) {}
  }, [showConfSignals]);

  useEffect(() => {
    try { localStorage.setItem('levelAlertsOn', String(levelAlertsOn)); } catch(e) {}
    // Ask for browser-notification permission the moment alerts are enabled, so
    // OS popups work even when this tab is in the background.
    if (levelAlertsOn && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch(e) {}
    }
  }, [levelAlertsOn]);

  // RSI pane is pinned to the full 0-100 scale (per request). Clear any custom
  // range saved by the old "RSI scale" setting so stale zooms can't reappear.
  useEffect(() => {
    rsiScaleRef.current = { min: null, max: null };
    try {
      localStorage.removeItem('rsiScaleMin');
      localStorage.removeItem('rsiScaleMax');
    } catch(e) {}
    try { rsiSeriesRef.current?.priceScale()?.applyOptions({ autoScale: true }); } catch(e) {}
  }, []);

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
  // Same URL signal App uses. In this mode the tab is about ONE contract, so the
  // index switcher is hidden too — it would only offer a way to navigate away from
  // the thing the tab exists to show.
  const isFocusedChart = (() => {
    try { return new URLSearchParams(window.location.search).has('optToken'); }
    catch (e) { return false; }
  })();
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

  // Declared HERE, above the H-levels keys that read it: those keys are computed
  // during render, so leaving this further down was a temporal-dead-zone crash
  // waiting to happen rather than a style point.
  const [underlying, setUnderlying] = useState<'NIFTY' | 'BANKNIFTY' | 'SENSEX'>(() => {
    // Validated against the known set rather than trusted: an old or hand-edited
    // value must fall back to NIFTY, not leave the chart pointing at nothing.
    try {
      const v = localStorage.getItem('chartUnderlying');
      if (v === 'SENSEX' || v === 'BANKNIFTY' || v === 'NIFTY') return v;
    } catch(e) {}
    return 'NIFTY';
  });
  useEffect(() => {
    try { localStorage.setItem('chartUnderlying', underlying); } catch(e) {}
  }, [underlying]);

  // Each index has its OWN levels. Keys are suffixed per index so NIFTY, Bank
  // Nifty and SENSEX cannot overwrite one another on the device, on the server, or
  // in the dated journal. The bare 'hLevels' key is still read as NIFTY's so an
  // existing device keeps the levels it already has.
  const hlKey = underlying === 'NIFTY' ? 'hLevels' : `hLevels_${underlying}`;
  const hlSettingKey = underlying === 'NIFTY' ? 'h_levels' : `h_levels_${underlying}`;
  const hlKeyRef = useRef(hlKey); hlKeyRef.current = hlKey;
  const hlSettingKeyRef = useRef(hlSettingKey); hlSettingKeyRef.current = hlSettingKey;
  const underlyingRef = useRef(underlying); underlyingRef.current = underlying;

  const [hLevels, setHLevels] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem(hlKey);
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

  // H-levels sync across devices. On mount, pull the server copy (shared by all
  // logged-in devices). If the server has none yet, seed it from this device's
  // local copy so existing levels aren't lost. hLevelsHydratedRef gates the
  // write-back effect so we don't clobber the server before the pull resolves.
  const hLevelsHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // Re-runs when the index changes: the levels belong to the index, so switching
    // must load that index's set rather than carry the previous one across.
    hLevelsHydratedRef.current = false;
    (async () => {
      try {
        const r = await fetch(`/api/settings/${hlSettingKey}`);
        const d = await r.json();
        const serverVal = d?.value;
        if (!cancelled && Array.isArray(serverVal) && serverVal.length === 6) {
          const norm = serverVal.map((v: any) => Math.round(Number(v) || 0));
          setHLevels(norm);
          try { localStorage.setItem(hlKey, JSON.stringify(norm)); } catch {}
        } else if (!cancelled) {
          // server empty — seed from whatever this device already has
          let local: number[] = [];
          try { local = JSON.parse(localStorage.getItem(hlKey) || '[]'); } catch {}
          if (Array.isArray(local) && local.length === 6 && local.some(v => v > 0)) {
            fetch(`/api/settings/${hlSettingKey}`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: local }),
            }).catch(() => {});
          }
        }
      } catch {}
      if (!cancelled) hLevelsHydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [hlKey, hlSettingKey]);

  useEffect(() => {
    try {
      localStorage.setItem('showHLevels', String(showHLevels));
    } catch(e) {}
  }, [showHLevels]);

  useEffect(() => {
    try {
      localStorage.setItem(hlKeyRef.current, JSON.stringify(hLevels));
    } catch(e) {}
    // Mirror to the server so the levels sync to the user's other devices.
    // Gated on hydration so the initial local value can't overwrite a freshly
    // pulled server copy. Debounced to coalesce rapid edits.
    if (!hLevelsHydratedRef.current) return;
    const t = setTimeout(() => {
      fetch(`/api/settings/${hlSettingKeyRef.current}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: hLevels }),
      }).catch(() => {});
      // Auto-journal: file TODAY's set into the dated H-levels history
      // (/h-levels page) — same edit, zero extra steps. Upsert semantics keep
      // the latest values for the date; silent fire-and-forget.
      if (Array.isArray(hLevels) && hLevels.length && hLevels.some((v: any) => Number(v) > 0)) {
        const x = new Date(Date.now() + 5.5 * 3600 * 1000);
        const d = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
        fetch('/api/h-levels', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: d, symbol: underlyingRef.current, levels: hLevels, note: 'auto from chart indicator' }),
        }).catch(() => {});
      }
    }, 600);
    return () => clearTimeout(t);
  }, [hLevels]);

  // Morning ritual: on the FIRST app-open of each trading day (Mon-Fri IST),
  // pop the H Levels settings so the day's values are confirmed before the
  // chart is used. Tapping Save files them into the journal even when they are
  // unchanged from yesterday. Once per day per device; weekends skipped here;
  // on an NSE holiday the server refuses the journal write anyway, so simply
  // closing (or saving) the popup stores nothing.
  useEffect(() => {
    const check = () => {
      try {
        if (!hLevelsHydratedRef.current) return;
        const x = new Date(Date.now() + 5.5 * 3600 * 1000);
        const day = x.getUTCDay();
        if (day === 0 || day === 6) return;
        const d = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
        if (localStorage.getItem('hLevelsPromptedFor') === d) return;
        // Ask the server whether today is actually a trading day — it holds the
        // official NSE holiday list, which the phone does not. Only prompt on a
        // real trading day; on a holiday stay silent (the journal would refuse
        // the write anyway).
        fetch('/api/calendar/trading-day')
          .then(r => r.json())
          .then(t => {
            if (t && t.isTradingDay === false) return;
            if (localStorage.getItem('hLevelsPromptedFor') === d) return;
            localStorage.setItem('hLevelsPromptedFor', d);
            setIsEditingHLevels(true);
          })
          .catch(() => {
            // Server unreachable: fall back to the weekday check already done
            // above rather than skipping the ritual entirely.
            if (localStorage.getItem('hLevelsPromptedFor') === d) return;
            localStorage.setItem('hLevelsPromptedFor', d);
            setIsEditingHLevels(true);
          });
      } catch (e) {}
    };
    check();
    const iv = setInterval(check, 1500); // hydration lands async — retry briefly
    return () => clearInterval(iv);
  }, []);

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
  // Mobile-only: biases (OI/SIGNAL/PULSE/TREND/…) live in a collapsible dropdown
  // toggled by a chevron beside the page title. Desktop shows them inline as before.
  const [showBiases, setShowBiases] = useState(false);
  // Mobile toolbar reload button feedback (dispatches the same chart_reload event)
  const [tbReloading, setTbReloading] = useState(false);
  // "Scroll to latest" (fast-forward) button — shown only when the view is scrolled
  // away from the most recent candle.
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // TradingView-style resizable RSI pane: drag the divider between chart and RSI.
  // 0 = default height (h-[140px] mobile / md:h-[200px] desktop); persisted.
  const [rsiPaneHeight, setRsiPaneHeight] = useState<number>(() => {
    try { const v = parseInt(localStorage.getItem('rsiPaneHeight') || '', 10); if (Number.isFinite(v) && v >= 70 && v <= 420) return v; } catch (e) {}
    return 0;
  });
  const rsiPaneHeightRef = useRef(rsiPaneHeight);
  useEffect(() => { rsiPaneHeightRef.current = rsiPaneHeight; }, [rsiPaneHeight]);

  // Showing or hiding the RSI pane changes how tall the main chart's container is.
  // The chart is sized by a ResizeObserver, and if it is left holding a height from
  // the previous layout it draws taller than its container — and since that
  // container is overflow-hidden, the part that gets clipped is the bottom strip:
  // the time axis. That is why the x-axis vanished with RSI switched off. Re-apply
  // the real measured size (and re-assert the axis) after the toggle has settled.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const el = chartContainerRef.current;
        const ch = mainChartRef.current;
        if (!el || !ch) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          ch.applyOptions({
            width: Math.floor(r.width),
            height: Math.floor(r.height),
            timeScale: { visible: true },
          });
        }
      } catch (e) {}
    }, 80);
    return () => clearTimeout(t);
  }, [showRsi, rsiPaneHeight]);
  const rsiPaneRef = useRef<HTMLDivElement>(null);
  const rsiDragRef = useRef<{ startY: number; startH: number } | null>(null);
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
    // A Strike Click tab carries its contract in the URL, and it MUST be applied
    // here, in the initial state — not later in an effect. The whole live-tick
    // path (the WS listener and the token it matches against) is wired up on the
    // first render, so a contract that arrives one render later leaves that
    // listener bound to the wrong instrument and the chart never shows a tick:
    // exactly the "option chart has no live feed" symptom, while the same
    // contract restored from localStorage ticked perfectly.
    try {
      const q = new URLSearchParams(window.location.search);
      const tok = q.get('optToken'), tsym = q.get('optSymbol');
      if (tok && tsym) {
        return {
          instrument_token: tok,
          tradingsymbol: tsym,
          ...(q.get('optLot') ? { lot_size: Number(q.get('optLot')) } : {}),
          ...(q.get('optExch') ? { exchange: q.get('optExch') } : {}),
        } as any;
      }
    } catch (e) {}
    // SESSION storage, not local. A refresh mid-session should keep the contract
    // you were watching, but OPENING the app fresh should land on the index — an
    // option chart from yesterday is stale context to be handed on startup, and it
    // hid the index behind a contract that may not even be relevant any more.
    // sessionStorage gives exactly that: survives reloads, dies with the tab.
    try {
      const saved = sessionStorage.getItem('selectedInstrument');
      if (saved) return JSON.parse(saved);
    } catch(e) {}
    // One-time cleanup of the old permanent key so a stale value cannot resurface.
    try { localStorage.removeItem('selectedInstrument'); } catch(e) {}
    return null;
  });

  // Which INDEX the chart's index view shows (the tab-strip switcher). Options
  // open on top of either; switching back to index mode lands on this one.

  useEffect(() => {
    try {
      if (selectedInstrument) {
        sessionStorage.setItem('selectedInstrument', JSON.stringify(selectedInstrument));
      } else {
        sessionStorage.removeItem('selectedInstrument');
      }
      // Keep the retired permanent key clear on every change, so an older build
      // that wrote it cannot leave a value behind to be restored later.
      localStorage.removeItem('selectedInstrument');
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

  // Y-lock removed: always clear any previously-saved lock and keep autoscale on,
  // so a stale near-zero locked range can never hide the candles again.
  useEffect(() => {
    yLockRef.current = null;
    setYLocked(false);
    try { localStorage.removeItem('chartYLocks'); } catch (e) {}
    try { mainSeriesRef.current?.priceScale()?.applyOptions({ autoScale: true }); } catch (e) {}
  }, [cacheKey]);

  // Y-lock feature removed (it could pin the scale to a stale near-zero range and
  // hide the candles). Kept as a no-op so any lingering reference stays valid.
  const toggleYLock = () => {
    yLockRef.current = null;
    setYLocked(false);
    try { localStorage.removeItem('chartYLocks'); } catch (e) {}
    try { mainSeriesRef.current?.priceScale()?.applyOptions({ autoScale: true }); } catch (e) {}
  };

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
  // Premium SL/TP rule sync status: shown as a tiny marker on the P&L chip.
  const [premSync, setPremSync] = useState<'OFF' | 'SYNCING' | 'ACTIVE' | 'ERROR'>('OFF');
  const premSyncedForRef = useRef<string>('');
  const [slTrail, setSlTrail] = useState(true);
  const [slTrailCandles, setSlTrailCandles] = useState<string>('3');
  const [slStructureStop, setSlStructureStop] = useState<'' | 'VWAP' | 'OR'>('');
  // Trade-follow: after a quick trade, open the traded OPTION's chart in a tab and
  // place SL(-10%)/TARGET(+30%) lines vs the actual entry price, with live % labels.
  const slEntryRef = useRef<number | null>(null);
  const slEntryLineRef = useRef<any>(null);
  // Lets the chart-building effect re-attach the SL/TP lines the instant it
  // rebuilds the series, instead of leaving them missing until the 1s poll.
  const slEnsureRef = useRef<null | (() => void)>(null);
  const tradeInstrumentRef = useRef<any>(null);
  const [tradeTabInstr, setTradeTabInstr] = useState<any>(null);
  const autoOpenedForRef = useRef<string>('');
  // Chart-side manual exit: first tap arms (CONFIRM EXIT?), second tap fires.
  const [exitBusy, setExitBusy] = useState(false);
  const slActivePosRef = useRef<any>(null);
  useEffect(() => { slActivePosRef.current = slActivePos; }, [slActivePos]);

  // Push the premium SL/TP rule to the server — the dragged lines become the
  // LIVE protective rule immediately, no confirmation step.
  const pushPremiumRule = async (slPx: number, tpPx: number) => {
    const pos = slActivePosRef.current;
    if (!pos) return;
    setPremSync('SYNCING');
    try {
      const r = await fetch('/api/premium-exit/set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradingsymbol: pos.symbol, sl: +(+slPx).toFixed(2), tp: +(+tpPx).toFixed(2), entry: pos.entryPrice })
      });
      const d = await r.json().catch(() => null);
      setPremSync(d && d.success ? 'ACTIVE' : 'ERROR');
      if (d && !d.success && d.error) console.warn('[premium-exit] not armed:', d.error);
    } catch { setPremSync('ERROR'); }
  };


  const handlePointerDown = (e: React.PointerEvent) => {
    if (!chartContainerRef.current || !mainSeriesRef.current || !mainChartRef.current) return;
    const rect = chartContainerRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;

    // SL/Target lines take priority for dragging
    for (const sl of slLinesRef.current) {
        const lineY = mainSeriesRef.current.priceToCoordinate(sl.price);
        // 24px grab zone — draggable with a thumb on mobile, not just a mouse.
        if (lineY !== null && Math.abs(lineY - y) < 24) {
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
          if (sl) {
            sl.price = newPrice;
            const entry = slEntryRef.current;
            if (entry) {
              const pct = ((newPrice - entry) / entry) * 100;
              sl.instance.applyOptions({ price: newPrice, title: `${sl.label} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` });
            } else {
              sl.instance.applyOptions({ price: newPrice });
            }
          }
          if (!slEntryRef.current) setSlLevels(prev => ({ ...prev, [kind]: Math.round(newPrice) }));
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
        // On the traded option's chart the lines ARE the live rule: apply the new
        // SL/TP the moment the finger lifts. No confirmation.
        if (slEntryRef.current) {
          const posNow = slActivePosRef.current;
          const u = slLinesRef.current.find((l: any) => l.kind === 'upper');
          const lo = slLinesRef.current.find((l: any) => l.kind === 'lower');
          if (posNow && u && lo) {
            const long = posNow.side === 'BUY';
            pushPremiumRule(long ? lo.price : u.price, long ? u.price : lo.price);
          }
        }
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

  // When a position appears, resolve its instrument token and open its chart in a
  // second tab (auto-switch once per position; user can tab back to NIFTY freely).
  useEffect(() => {
    let cancelled = false;
    const sym = slActivePos?.symbol;
    if (!sym) {
      setTradeTabInstr(null); tradeInstrumentRef.current = null; slEntryRef.current = null;
      autoOpenedForRef.current = '';
      return;
    }
    if (autoOpenedForRef.current === sym) return;
    (async () => {
      try {
        const r = await fetch(`/api/instruments/search?q=${encodeURIComponent(sym)}`);
        const d = await r.json();
        const list = d?.instruments || d?.results || d || [];
        const exact = Array.isArray(list) ? list.find((i: any) => i.tradingsymbol === sym) : null;
        if (!cancelled && exact && exact.instrument_token) {
          tradeInstrumentRef.current = exact;
          setTradeTabInstr(exact);
          autoOpenedForRef.current = sym;
          setSelectedInstrument(exact); // open the traded option's chart
        }
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [slActivePos]);

  // When a trade appears: restore an existing rule (reload case) or arm the
  // defaults (-10% SL / +20% TARGET) immediately — protection from second one.
  useEffect(() => {
    const pos = slActivePos;
    if (!pos || !pos.entryPrice) { setPremSync('OFF'); premSyncedForRef.current = ''; return; }
    if (premSyncedForRef.current === pos.symbol) return;
    premSyncedForRef.current = pos.symbol;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/premium-exit/get?tradingsymbol=${encodeURIComponent(pos.symbol)}`);
        const d = await r.json();
        if (cancelled) return;
        const rule = d?.rule;
        const long = pos.side === 'BUY';
        if (rule && rule.status === 'ACTIVE') {
          setPremSync('ACTIVE');
          // Snap the lines to the saved rule once they exist (they're created async).
          const apply = (attempt: number) => {
            const u = slLinesRef.current.find((l: any) => l.kind === 'upper');
            const lo = slLinesRef.current.find((l: any) => l.kind === 'lower');
            if (u && lo) {
              const upVal = long ? rule.tp : rule.sl;
              const loVal = long ? rule.sl : rule.tp;
              u.price = upVal; lo.price = loVal;
              try { u.instance.applyOptions({ price: upVal }); lo.instance.applyOptions({ price: loVal }); } catch (e) {}
            } else if (attempt < 10) setTimeout(() => apply(attempt + 1), 300);
          };
          apply(0);
        } else {
          const slP = +((long ? pos.entryPrice * 0.9 : pos.entryPrice * 1.1)).toFixed(2);
          const tpP = +((long ? pos.entryPrice * 1.2 : pos.entryPrice * 0.8)).toFixed(2);
          pushPremiumRule(slP, tpP);
        }
      } catch { if (!cancelled) setPremSync('ERROR'); }
    })();
    return () => { cancelled = true; };
  }, [slActivePos]);

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

  // External "reload chart" button (in the app shell) → refetch full history and
  // snap the view back to the latest candle. Fixes a chart that's scrolled away or
  // stuck on stale data on mobile without a full app refresh.
  // Jumping back to the latest candle used to land on empty space: the main price
  // scale is created with autoScale:false (so the vertical range stays put while
  // you pan), which means it keeps whatever range the PAST view had and the recent
  // candles can sit far outside it. Refit once, then hand the scale back to manual
  // so panning behaves exactly as before.
  const refitPriceScaleRef = useRef<() => void>(() => {});
  refitPriceScaleRef.current = () => {
    try {
      const ps = mainSeriesRef.current?.priceScale?.();
      if (!ps) return;
      ps.applyOptions({ autoScale: true });
      setTimeout(() => { try { ps.applyOptions({ autoScale: false }); } catch (e) {} }, 150);
    } catch (e) {}
  };

  useEffect(() => {
    const onReload = () => {
      try { refetchTa(); } catch (e) {}
      // snap to the most recent candle after data settles
      const snap = (attempt: number) => {
        try {
          const ts = mainChartRef.current?.timeScale?.();
          if (ts) {
            ts.scrollToRealTime();
            refitPriceScaleRef.current();
            // also reset the saved zoom so a persisted range doesn't pull us back
            try {
              const data = chartDataRef.current?.candles;
              if (data && data.length) {
                const barsToShow = Math.min(120, data.length);
                ts.setVisibleLogicalRange({ from: data.length - barsToShow, to: data.length + 2 });
              }
            } catch (e) {}
          }
        } catch (e) {}
        if (attempt < 3) setTimeout(() => snap(attempt + 1), 250);
      };
      setTimeout(() => snap(0), 150);
    };
    window.addEventListener('chart_reload', onReload);
    return () => window.removeEventListener('chart_reload', onReload);
    // refetchTa is only invoked inside the handler (runs long after mount), so it
    // must NOT be in the dep array — referencing it here reads the useQuery result
    // before it's initialized (temporal dead zone) and crashes the whole chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const iv = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [slActivePos]);

  // Create / destroy the two draggable lines for the active position
  useEffect(() => {
    if (!slActivePos) { setSlPanelOpen(false); return; }
    // The SL/TP setup box no longer auto-opens after a trade: the draggable
    // premium lines ARE the live SL/TP now, applied instantly on drag release.
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

      const posNow = slActivePosRef.current;
      const viewingTrade = !!(posNow && posNow.entryPrice && tradeInstrumentRef.current &&
        String(instrumentTokenRef.current) === String(tradeInstrumentRef.current.instrument_token));
      const effBull = viewingTrade ? (posNow.side === 'BUY') : slIsBullish;
      slEntryRef.current = viewingTrade ? posNow.entryPrice : null;

      // NOT the traded contract's chart (i.e. NIFTY spot): draw nothing. The armed
      // rule is PREMIUM-based — its columns are entry/sl/tp and it holds no spot
      // levels at all — so the branches below fell through to Math.round(spot*1.01)
      // and spot*0.99 and painted an invented +/-1% band that had NOTHING to do with
      // the real exit. Two lines that look authoritative and mean nothing are worse
      // than no lines, so any existing ones are torn down here.
      if (!viewingTrade) {
        if (slLinesRef.current.length) {
          slLinesRef.current.forEach(l => { try { s.removePriceLine(l.instance); } catch (e) {} });
          slLinesRef.current = [];
          slSeriesRef.current = null;
        }
        if (slEntryLineRef.current) {
          try { s.removePriceLine(slEntryLineRef.current); } catch (e) {}
          slEntryLineRef.current = null;
        }
        return;
      }

      let upper: number, lower: number;
      // On the traded OPTION's chart, premium-based lines always take priority —
      // an armed rule's levels are NIFTY SPOT values and would land wildly
      // off-scale on a premium chart (lines vanished + became un-draggable).
      if (viewingTrade) {
        // Option-premium chart: SL 10% against entry, TARGET +20% in favour
        // (both draggable; dragging applies the LIVE rule instantly).
        const entry = posNow.entryPrice;
        const long = posNow.side === 'BUY';
        const slP = +((long ? entry * 0.9 : entry * 1.1)).toFixed(2);
        const tpP = +((long ? entry * 1.2 : entry * 0.8)).toFixed(2);
        upper = long ? tpP : slP;
        lower = long ? slP : tpP;
      } else if (slArmedRule) {
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

      const pctTitle = (label: string, price: number) => {
        const entry = slEntryRef.current;
        if (!entry) return '';
        const pct = ((price - entry) / entry) * 100;
        return `${label} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      };
      const upLabel = effBull ? 'TARGET' : 'SL';
      const loLabel = effBull ? 'SL' : 'TARGET';
      const uInst = s.createPriceLine({ price: upper, color: '#f43f5e', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: pctTitle(upLabel, upper) });
      const lInst = s.createPriceLine({ price: lower, color: '#10b981', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: pctTitle(loLabel, lower) });
      slLinesRef.current = [
        { kind: 'upper', price: upper, instance: uInst, label: upLabel, color: '#f43f5e' },
        { kind: 'lower', price: lower, instance: lInst, label: loLabel, color: '#10b981' },
      ];
      slSeriesRef.current = s;
      // Fixed ENTRY line on the traded option's chart (reference, not draggable)
      try { if (slEntryLineRef.current) { s.removePriceLine(slEntryLineRef.current); } } catch (e) {}
      slEntryLineRef.current = null;
      if (slEntryRef.current) {
        try {
          slEntryLineRef.current = s.createPriceLine({
            price: slEntryRef.current, color: '#94a3b8', lineWidth: 1, lineStyle: 0,
            axisLabelVisible: true, title: `ENTRY ${slEntryRef.current.toFixed(2)}`
          });
        } catch (e) {}
      }
      // Premium levels must NOT feed the spot-based exit panel; only sync when on NIFTY.
      if (!viewingTrade) setSlLevels({ upper, lower });
    };
    ensure();
    slEnsureRef.current = ensure;
    const iv = setInterval(ensure, 1000);
    return () => {
      clearInterval(iv);
      slEnsureRef.current = null;
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
    setSlStructureStop(slArmedRule.structure_stop === 'VWAP' || slArmedRule.structure_stop === 'OR' ? slArmedRule.structure_stop : '');
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
          structureStop: slStructureStop || null,
        })
      });
      const data = await res.json();
      if (data?.success) {
        toast.success(`Auto-exit armed for ${slActivePos.symbol}`, {
          description: `Stop ${stopPrice || '\u2014'} (${slStopMode === 'CLOSE' ? 'close' : 'touch'}) \u00B7 Target ${targetPrice || '\u2014'} (${slTargetMode === 'CLOSE' ? 'close' : 'touch'})${trailEnabled ? ` \u2192 ${parseInt(slTrailCandles, 10) || 3}-candle trail` : ''}`
        });
        setSlArmedRule({ id: data.id, tradingsymbol: slActivePos.symbol, spot_upper: spotUpper, spot_lower: spotLower, stop_mode: slStopMode, target_mode: slTargetMode, spot_mode: slStopMode, rsi_lower: rl, rsi_upper: ru, trail_enabled: trailEnabled ? 1 : 0, trail_candles: parseInt(slTrailCandles, 10) || 3, target_price: targetPrice, trail_dir: trailDir, structure_stop: slStructureStop || null, status: 'ACTIVE' });
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
    if (sym.includes('SENSEX')) {
      strikeInterval = 100;
    } else if (sym.includes('BANKNIFTY') || sym.includes('BANK')) {
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

  // Prefill the SAME order ticket used everywhere else with the contract the chart
  // is showing. Lot size and exchange come from Kite's instrument master, never
  // inferred from the symbol — a wrong lot size is a wrong-sized real order.
  // The trigger box: arm a level now, the order goes in when the premium gets
  // there. Opened by tapping an option chart; the tapped price IS the level.
  const [triggerBox, setTriggerBox] = useState<null | {
    contract: any; level: number; current: number;
    side: 'BUY' | 'SELL'; product: 'MIS' | 'NRML'; lots: number;
    lotMode: 'AUTO' | 'MANUAL';
  }>(null);
  const [triggerMargin, setTriggerMargin] = useState<null | { total: number; source: string } | 'unavailable' | 'loading'>(null);
  const [armingTrigger, setArmingTrigger] = useState(false);

  const openTriggerBox = async (tappedPrice: number) => {
    const instr = selectedInstrument;
    if (!instr?.tradingsymbol) return;
    setIsProcessingStrikeAction(true);
    try {
      const res = await fetch(`/api/contract-info?tradingsymbol=${encodeURIComponent(instr.tradingsymbol)}`);
      if (!res.ok) { toast.error('Could not identify this contract — nothing armed'); return; }
      const c = await res.json();
      if (!c.lot_size) { toast.error('No lot size for this contract — refusing to arm'); return; }
      const current = lastCandleDataRef.current?.close
        ?? chartDataRef.current?.candles?.[chartDataRef.current.candles.length - 1]?.close ?? 0;
      if (!(current > 0)) { toast.error('No live premium yet — wait for a tick before arming'); return; }
      setTriggerBox({
        contract: c,
        level: Math.max(0.05, Math.round(tappedPrice / 0.05) * 0.05), // NSE option tick size
        current,
        // AUTO MAX by default, matching the main order ticket — the user asked for
        // the two screens to behave the same. Worth knowing: the size is computed
        // from the balance at ARM time, while the order goes in later, so if margin
        // has moved against you by then the broker can reject it. Switch to MANUAL
        // to pin a size that does not chase the balance.
        side: 'BUY', product: 'NRML', lots: 1, lotMode: 'AUTO',
      });
    } catch (e: any) {
      toast.error(e?.message || 'Could not open the trigger box');
    } finally { setIsProcessingStrikeAction(false); }
  };
  const openTriggerBoxRef = useRef(openTriggerBox);
  openTriggerBoxRef.current = openTriggerBox;

  // Margin comes from Kite, never estimated — a sell's SPAN requirement cannot be
  // guessed, and a wrong number beside a sell button is one the user would act on.
  useEffect(() => {
    if (!triggerBox) { setTriggerMargin(null); return; }
    let cancelled = false;
    setTriggerMargin('loading');
    const qty = triggerBox.lots * (triggerBox.contract.lot_size || 0);
    fetch('/api/order-margin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tradingsymbol: triggerBox.contract.tradingsymbol, exchange: triggerBox.contract.exchange,
        side: triggerBox.side, quantity: qty, product: triggerBox.product, price: triggerBox.level,
      }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('unavailable')))
      .then(m => { if (!cancelled) setTriggerMargin({ total: m.total, source: m.source }); })
      .catch(() => { if (!cancelled) setTriggerMargin('unavailable'); });
    return () => { cancelled = true; };
  }, [triggerBox?.contract?.tradingsymbol, triggerBox?.side, triggerBox?.product, triggerBox?.lots, triggerBox?.level]);

  // Margin per lot is inferred from the quote we already have, so AUTO MAX costs
  // no extra request. Sell-side margin is not perfectly linear across lots, so
  // this is a close estimate and the quoted total below is always the real number.
  const marginPerLot = (triggerBox && triggerMargin && typeof triggerMargin === 'object' && triggerBox.lots > 0)
    ? triggerMargin.total / triggerBox.lots : 0;
  const maxLots = marginPerLot > 0 ? Math.max(0, Math.floor((availBalance || 0) / marginPerLot)) : 0;

  useEffect(() => {
    if (!triggerBox || triggerBox.lotMode !== 'AUTO') return;
    if (maxLots >= 1 && triggerBox.lots !== maxLots) {
      setTriggerBox({ ...triggerBox, lots: maxLots });
    }
  }, [maxLots, triggerBox?.lotMode]);

  const armTrigger = async () => {
    if (!triggerBox) return;
    setArmingTrigger(true);
    try {
      const qty = triggerBox.lots * (triggerBox.contract.lot_size || 0);
      const r = await fetch('/api/triggers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradingsymbol: triggerBox.contract.tradingsymbol,
          instrument_token: triggerBox.contract.instrument_token,
          exchange: triggerBox.contract.exchange,
          side: triggerBox.side, product: triggerBox.product, quantity: qty,
          trigger_price: triggerBox.level, current_price: triggerBox.current,
        }),
      });
      const d = await r.json();
      if (!d.ok) { toast.error(d.error || 'Could not arm'); return; }
      toast.success(`Armed: ${triggerBox.side} at ${triggerBox.level.toFixed(2)}`);
      setTriggerBox(null);
      refetchTriggers();
    } catch (e: any) { toast.error(e?.message || 'Could not arm'); }
    finally { setArmingTrigger(false); }
  };

  const { data: triggersData, refetch: refetchTriggers } = useQuery({
    queryKey: ['triggers'],
    queryFn: async () => (await fetch('/api/triggers')).json(),
    refetchInterval: 5000, refetchOnWindowFocus: true,
  });
  const armedTriggers = (triggersData?.rows || []).filter((r: any) => r.status === 'ARMED');

  const openOptionBuyTicket = async () => {
    // openOptionBuyTicketRef is refreshed on every render, so this closure always
    // sees the CURRENT contract — no separate ref needed.
    const instr = selectedInstrument;
    if (!instr?.tradingsymbol) return;
    setIsProcessingStrikeAction(true);
    try {
      const res = await fetch(`/api/contract-info?tradingsymbol=${encodeURIComponent(instr.tradingsymbol)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Could not identify this contract — no order prepared');
        return;
      }
      const c = await res.json();
      if (!c.lot_size) { toast.error('No lot size for this contract — refusing to prepare an order'); return; }
      // Live premium if we have one, else the last close the chart drew.
      const live = lastCandleDataRef.current?.close
        ?? chartDataRef.current?.candles?.[chartDataRef.current.candles.length - 1]?.close
        ?? 0;
      setTicketData({
        action: 'BUY',
        optionType: (c.instrument_type === 'PE' ? 'PE' : 'CE'),
        underlying: String(instr.tradingsymbol).replace(/\d.*$/, '') || 'NIFTY',
        expiry: c.expiry || '',
        strike: c.strike || 0,
        tradingsymbol: c.tradingsymbol,
        instrument_token: String(c.instrument_token),
        ltp: live,
        lotSize: c.lot_size,
        quantity: c.lot_size,          // one lot
        product: 'NRML',
        orderType: 'MARKET',
        limitPrice: 0,
        exchange: c.exchange,
        segment: c.segment,
        source_of_lot_size: c.source_of_lot_size,
      });
      setAvailableExpiries(c.expiry ? [c.expiry] : []);
      setShowOrderTicket(true);
    } catch (e: any) {
      toast.error(e?.message || 'Could not prepare the order');
    } finally {
      setIsProcessingStrikeAction(false);
    }
  };
  // The chart's click handler is created once per chart build, so it reads this
  // through a ref rather than closing over a stale copy.
  const openOptionBuyTicketRef = useRef(openOptionBuyTicket);
  openOptionBuyTicketRef.current = openOptionBuyTicket;

  const handleStrikeAction = async (action: 'BUY' | 'SELL', optionType: 'CE' | 'PE', clickedPrice: number) => {
    setClickMenu(null);
    await resolveStrikeDetails(action, optionType, clickedPrice);
  };

  // Open that strike's option chart in a NEW TAB, leaving this one on the index.
  // Deliberately shares the strike-rounding and contract lookup used for orders,
  // so the chart you inspect is exactly the contract the ticket would have sold
  // you — a separate lookup here could quietly drift to a different strike.
  // Which expiry to open, asked BEFORE the chart opens. Previously this silently
  // used the nearest expiry, which is the wrong assumption often enough to matter:
  // the strike you want on a monthly is not the one the weekly hands you.
  const [expiryPick, setExpiryPick] = useState<{
    optionType: 'CE' | 'PE'; price: number; expiries: string[]; strike: number; under: string;
  } | null>(null);

  // Instrument-master name for whichever index the chart is on.
  const masterName = (): string => {
    const s2 = currentSymbol.toUpperCase();
    if (s2.includes('SENSEX')) return 'SENSEX';
    if (s2.includes('BANKEX')) return 'BANKEX';
    if (s2.includes('BANK')) return 'BANKNIFTY';
    if (s2.includes('FIN')) return 'FINNIFTY';
    return 'NIFTY';
  };

  const openStrikeChart = async (optionType: 'CE' | 'PE', clickedPrice: number, expiry?: string) => {
    setClickMenu(null);
    try {
      const sym = currentSymbol.toUpperCase();
      const strikeInterval = (sym.includes('SENSEX') || sym.includes('BANKNIFTY') || sym.includes('BANK')) ? 100 : 50;
      const targetStrike = Math.round(clickedPrice / strikeInterval) * strikeInterval;

      // EXPIRY LIST WITHOUT A FETCH. The chart already holds the chain for this
      // index (the OI query), and its expiries are the same list. Fetching a whole
      // chain — every strike, with live quotes — just to read that list is what
      // made tapping CE/PE Chart feel slow.
      if (!expiry) {
        const known: string[] = (oiData as any)?.expiries || [];
        if (known.length > 1) {
          setExpiryPick({
            optionType, price: clickedPrice, expiries: known.slice(0, 8),
            strike: targetStrike,
            under: UNDERLYING_LABEL[sym.replace(/[^A-Z]/g, '')] || currentSymbol,
          });
          return;
        }
      }

      // ONE contract, from the cached instrument file — no chain, no quotes. The
      // nearest listed strike inside the chosen expiry is resolved server-side.
      const chosenExpiry = expiry || (oiData as any)?.expiryDate;
      if (!chosenExpiry) { toast.error('No expiry available yet — try again in a moment'); return; }
      const res = await fetch(`/api/resolve-option?underlying=${masterName()}`
        + `&expiry=${encodeURIComponent(chosenExpiry)}&strike=${targetStrike}&type=${optionType}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Could not find that contract');
        return;
      }
      const contract = await res.json();
      if (!contract?.instrument_token) { toast.error('Could not find that contract'); return; }
      // A PHONE HAS NO VISIBLE TABS. Opening a second one there is a one-way door:
      // the chromeless option tab hides the index switcher, and with no tab strip
      // to go back through, the user is stranded. On a narrow screen the chart
      // switches IN PLACE, where the index buttons remain one tap away. Desktop
      // keeps the separate tab, which is useful precisely because tabs are visible.
      const narrow = typeof window !== 'undefined'
        && window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
      if (narrow) {
        setSelectedInstrument({
          instrument_token: String(contract.instrument_token),
          tradingsymbol: contract.tradingsymbol,
          ...(contract.lot_size ? { lot_size: contract.lot_size } : {}),
          ...(contract.exchange ? { exchange: contract.exchange } : {}),
        } as any);
        return;
      }
      const url = `/advanced-chart?optToken=${encodeURIComponent(String(contract.instrument_token))}`
        + `&optSymbol=${encodeURIComponent(contract.tradingsymbol || '')}`
        + (contract.lot_size ? `&optLot=${contract.lot_size}` : '')
        + (contract.exchange ? `&optExch=${encodeURIComponent(contract.exchange)}` : '');
      window.open(url, '_blank', 'noopener');
    } catch (e: any) {
      toast.error(e?.message || 'Could not open that option chart');
    }
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
              exchange: (pos as any).exchange,
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
        // exchange comes from the contract the ticket was opened with (NFO for
        // NIFTY, BFO for SENSEX) — without it the server defaults to NFO and a
        // SENSEX order would be sent to the wrong exchange and rejected.
        body: JSON.stringify({...data, exchange: ticketData?.exchange || 'NFO', test_mode: testOrderMode, journal: true, context: journalContext})
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
          exchange: ticketData?.exchange || 'NFO',
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

  // Index token for the active underlying. NIFTY 50 is the constant the whole
  // app was built around; the SENSEX token comes from Zerodha's instrument dump
  // via the server (never hardcoded). Until it resolves, index-mode queries stay
  // disabled (brief spinner) rather than silently falling back to NIFTY candles
  // under a SENSEX label.
  const { data: sensexTokenData } = useQuery({
    queryKey: ['index-token', 'SENSEX'],
    queryFn: async () => {
      const res = await fetch('/api/index-token?symbol=SENSEX');
      if (!res.ok) throw new Error('index token fetch failed');
      return res.json();
    },
    enabled: underlying === 'SENSEX',
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
  });
  // NIFTY 50 (256265) and NIFTY BANK (260105) are NSE's published index tokens and
  // are as stable as the exchange itself; SENSEX is resolved from Zerodha's dump
  // because BSE's token is not a constant we should be inventing.
  const indexToken: string | null =
    underlying === 'NIFTY' ? '256265'
    : underlying === 'BANKNIFTY' ? '260105'
    : (sensexTokenData?.token ? String(sensexTokenData.token) : null);
  const indexLabel =
    underlying === 'NIFTY' ? 'NIFTY 50'
    : underlying === 'BANKNIFTY' ? 'NIFTY BANK'
    : 'SENSEX';
  const instrumentToken = selectedInstrument ? String(selectedInstrument.instrument_token) : indexToken;
  const instrumentTokenRef = useRef(instrumentToken);
  instrumentTokenRef.current = instrumentToken;
  // On the traded OPTION's chart only RSI stays on; index overlays (BB, S&R,
  // PDH/PDL, levels, OI bars, opening range, D/S zones, FVG) are hidden there.
  const isOptionView = !!selectedInstrument && (indexToken === null || instrumentToken !== indexToken);
  // Read inside the chart effect's click handler, which is created once per chart
  // rebuild — a ref keeps it correct even if the view changes without a rebuild.
  const isOptionViewRef = useRef(isOptionView);
  isOptionViewRef.current = isOptionView;
  const queryClient = useQueryClient();

  const { data: taInfo, isLoading: isLoadingTa, isError: isTaError, error: taError, refetch: refetchTa } = useQuery({
    queryKey: ["ta-data-live-chart", timeframe, instrumentToken],
    queryFn: async () => {
      const res = await fetch(`/api/ta?timeframe=${timeframe}&token=${instrumentToken}&symbol=${encodeURIComponent(selectedInstrument ? selectedInstrument.tradingsymbol : indexLabel)}`);
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
    refetchInterval: isOptionView ? 15000 : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Refetch full history whenever the chart (re)mounts — returning from another
    // tab/timeframe within gcTime used to serve stale candles with no refetch,
    // leaving a hole between old history and the live bar until a manual refresh.
    refetchOnMount: 'always',
    staleTime: 10 * 1000,
    gcTime: 10 * 60000,
    // Keep previous candles on screen while new ones load — but ONLY when the
    // instrument is the same (timeframe switches). When switching between the
    // NIFTY and option tabs, showing the other instrument's candles at a wildly
    // different price scale looked like the chart "not refreshing"; a brief
    // loading state is honest and correct there.
    placeholderData: (prev: any, prevQuery: any) => {
      const prevKey = prevQuery && prevQuery.queryKey;
      const prevToken = Array.isArray(prevKey) ? prevKey[prevKey.length - 1] : undefined;
      return String(prevToken) === String(instrumentToken) ? prev : undefined;
    },
    enabled: Boolean(timeframe && instrumentToken)
  });

  const { data: liveTa } = useQuery({
    queryKey: ["ta-data-decision", timeframe, instrumentToken],
    queryFn: async () => {
      const res = await fetch(`/api/ta?timeframe=${timeframe}&token=${instrumentToken}&symbol=${encodeURIComponent(selectedInstrument ? selectedInstrument.tradingsymbol : indexLabel)}`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 15000,
    staleTime: 8000,
    enabled: Boolean(timeframe && instrumentToken)
  });

  // Tell the server which contract this chart is showing so its ticks are actually
  // streamed. The chain subscriptions only ever covered the default expiry's
  // strikes, so a chart opened on anything else got no live feed at all. Re-declared
  // every 60s (the server's window is 2 minutes) and only for an option view —
  // the three indices are streamed permanently and need no help.
  useEffect(() => {
    if (!isOptionView || !instrumentToken) return;
    let stopped = false;
    const ping = () => {
      if (stopped) return;
      fetch(`/api/ticker/watch?token=${encodeURIComponent(String(instrumentToken))}`).catch(() => {});
    };
    ping();
    const iv = setInterval(ping, 60000);
    return () => { stopped = true; clearInterval(iv); };
  }, [isOptionView, instrumentToken]);

  // The real expiry date for the contract on screen, so the title can show the
  // DAY. Only a monthly's month/year is derivable from the symbol itself.
  const [contractExpiry, setContractExpiry] = useState<{ symbol: string; expiry: string | null } | null>(null);
  useEffect(() => {
    const sym = selectedInstrument?.tradingsymbol;
    if (!sym || !isOptionView) { setContractExpiry(null); return; }
    if (contractExpiry?.symbol === sym) return;
    let cancelled = false;
    fetch(`/api/contract-info?tradingsymbol=${encodeURIComponent(sym)}`)
      .then(r => r.ok ? r.json() : null)
      .then(c => { if (!cancelled) setContractExpiry({ symbol: sym, expiry: c?.expiry || null }); })
      .catch(() => { if (!cancelled) setContractExpiry({ symbol: sym, expiry: null }); });
    return () => { cancelled = true; };
  }, [selectedInstrument?.tradingsymbol, isOptionView]);

  // SWITCHING INDEX USED TO STALL. The chart caches every combination it has
  // fetched (staleTime and gcTime are Infinity), so going BACK to an index was
  // always instant — it was the FIRST visit to each that waited on a request.
  // While sitting on one index, quietly fetch the other two at the same
  // timeframe, so the switch is served from cache. Idle-time work only: it never
  // blocks what is on screen, and failures are ignored.
  useEffect(() => {
    if (selectedInstrument) return;           // on an option chart, leave it alone
    const others = [
      { token: '256265', label: 'NIFTY 50' },
      { token: '260105', label: 'NIFTY BANK' },
      ...(sensexTokenData?.token ? [{ token: String(sensexTokenData.token), label: 'SENSEX' }] : []),
    ].filter(o => o.token !== instrumentToken);

    const t = setTimeout(() => {
      for (const o of others) {
        queryClient.prefetchQuery({
          queryKey: ["ta-data-live-chart", timeframe, o.token],
          queryFn: async () => {
            const res = await fetch(`/api/ta?timeframe=${timeframe}&token=${o.token}&symbol=${encodeURIComponent(o.label)}`);
            if (!res.ok) throw new Error('prefetch failed');
            return res.json();
          },
          staleTime: Infinity,
        }).catch(() => {});
      }
    }, 1200);   // let the visible chart finish loading first
    return () => clearTimeout(t);
  }, [timeframe, instrumentToken, selectedInstrument, sensexTokenData?.token]);

  // The numbers that explain a call falling on an up day. Only on an option chart.
  const { data: optionReality } = useQuery({
    queryKey: ['option-analytics', selectedInstrument?.tradingsymbol],
    queryFn: async () => {
      const r = await fetch(`/api/option-analytics?tradingsymbol=${encodeURIComponent(selectedInstrument!.tradingsymbol)}`);
      if (!r.ok) return null;
      return r.json();
    },
    enabled: !!selectedInstrument?.tradingsymbol && isOptionView,
    refetchInterval: 20000, refetchOnWindowFocus: false,
  });

  // OPEN CHARTS. Previously the contract chip was derived from whatever chart was
  // showing, so tapping an index erased it and the option could only be reached by
  // finding the strike again. These are kept as their own list — switching to an
  // index changes which chart is ACTIVE, it does not close anything. Session-scoped
  // like the selected contract itself, so a fresh open of the app starts clean.
  const [openCharts, setOpenCharts] = useState<any[]>(() => {
    try {
      const saved = sessionStorage.getItem('openOptionCharts');
      const arr = saved ? JSON.parse(saved) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  });
  useEffect(() => {
    try { sessionStorage.setItem('openOptionCharts', JSON.stringify(openCharts)); } catch (e) {}
  }, [openCharts]);

  // Whatever option chart gets shown joins the list. Capped so the row cannot grow
  // past what a phone can display.
  useEffect(() => {
    if (!selectedInstrument?.tradingsymbol) return;
    setOpenCharts(prev => {
      if (prev.some(c => c.tradingsymbol === selectedInstrument.tradingsymbol)) return prev;
      return [...prev, {
        tradingsymbol: selectedInstrument.tradingsymbol,
        instrument_token: String(selectedInstrument.instrument_token),
        ...(selectedInstrument.lot_size ? { lot_size: selectedInstrument.lot_size } : {}),
        ...(selectedInstrument.exchange ? { exchange: selectedInstrument.exchange } : {}),
      }].slice(-5);
    });
  }, [selectedInstrument?.tradingsymbol]);

  // The signal list comes from the SERVER's log — the same rows the scorecard
  // grades — so an arrow always has a paper trail and can never repaint.
  const { data: confData } = useQuery({
    queryKey: ['confluence-signals'],
    queryFn: async () => { const r = await fetch('/api/confluence'); if (!r.ok) throw new Error('confluence fetch failed'); return r.json(); },
    refetchInterval: 60000,
    staleTime: 55000,
  });
  confSignalsRef.current = Array.isArray((confData as any)?.signals) ? (confData as any).signals : [];

  // Leverage meter — greeks plus the realized 30-minute premium-vs-index ratio,
  // so the option chart says out loud whether IV or theta is driving the premium.
  const { data: levDataRaw } = useQuery({
    queryKey: ['leverage', selectedInstrument?.tradingsymbol],
    queryFn: async () => { const r = await fetch(`/api/leverage?sym=${encodeURIComponent(selectedInstrument?.tradingsymbol || '')}`); return r.json(); },
    enabled: isOptionView && !!selectedInstrument?.tradingsymbol,
    refetchInterval: 60000,
    staleTime: 55000,
  });
  const lev: any = levDataRaw as any;

  const currentSymbol = selectedInstrument ? selectedInstrument.tradingsymbol : indexLabel;
  const lastSpotValue = taInfo && taInfo.candles && taInfo.candles.length > 0 
    ? taInfo.candles[taInfo.candles.length - 1].close 
    : undefined;

  const { data: oiData } = useQuery({
    queryKey: ["oi-data", currentSymbol],
    queryFn: async () => {
      const spotParam = lastSpotValue ? `&spot=${lastSpotValue}` : "";
      const res = await fetch(`/api/option-chain?symbol=${encodeURIComponent(currentSymbol)}${spotParam}`);
      if (!res.ok) throw new Error("Network error");
      return res.json();
    },
    // Keep showing the previous chain while a refetch is in flight — the spot
    // value used to be part of the queryKey, so every spot move spawned a brand
    // new query whose data was undefined during fetch, making the OI bars
    // disappear and reappear.
    placeholderData: (prev: any) => prev,
    // OI is an INDEX study and is never drawn on an option chart, so there is no
    // reason to keep pulling the whole chain every 10s while one is open — that
    // traffic shares the same proxy the orders use.
    enabled: !isOptionView,
    refetchInterval: () => (!isOptionViewRef.current && document.visibilityState === 'visible') ? 10 * 1000 : false,
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

  // Higher-timeframe trend for the "TREND" badge (BTST context). These reuse the
  // same /api/ta endpoint at 60-min and daily, on the NIFTY index token, and are
  // computed on the frontend from real EMA20/RSI/DI — no server changes needed.
  const htfToken = '256265'; // NIFTY 50 index — overall market tide regardless of selected symbol
  const { data: htfHourly } = useQuery({
    queryKey: ["ta-htf-hourly", htfToken],
    queryFn: async () => {
      const res = await fetch(`/api/ta?timeframe=60&token=${htfToken}&symbol=${encodeURIComponent("NIFTY 50")}`);
      if (!res.ok) throw new Error("htf hourly fetch failed");
      return res.json();
    },
    refetchInterval: () => document.visibilityState === 'visible' ? 5 * 60 * 1000 : false,
    staleTime: 4 * 60 * 1000,
    gcTime: 15 * 60000,
  });
  const { data: htfDaily } = useQuery({
    queryKey: ["ta-htf-daily", htfToken],
    queryFn: async () => {
      const res = await fetch(`/api/ta?timeframe=1440&token=${htfToken}&symbol=${encodeURIComponent("NIFTY 50")}`);
      if (!res.ok) throw new Error("htf daily fetch failed");
      return res.json();
    },
    refetchInterval: () => document.visibilityState === 'visible' ? 15 * 60 * 1000 : false,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60000,
  });

  // Score one timeframe's trend from real TA fields: price vs EMA20, EMA20 slope,
  // RSI vs 50, and DI direction. Returns -3..+3 (sign = direction, magnitude = agreement).
  const scoreHtf = (ta: any): { score: number; parts: string[] } | null => {
    if (!ta || !ta.candles || ta.candles.length < 25 || typeof ta.ema20 !== 'number') return null;
    const closes = ta.candles.map((c: any) => c.close).filter((x: any) => Number.isFinite(x));
    if (closes.length < 25) return null;
    const last = closes[closes.length - 1];
    let score = 0; const parts: string[] = [];
    // 1) price above/below EMA20
    if (last > ta.ema20) { score += 1; parts.push('price > EMA20'); }
    else if (last < ta.ema20) { score -= 1; parts.push('price < EMA20'); }
    // 2) EMA20 slope proxy: last close vs close ~10 bars back, as % of price
    const backClose = closes[Math.max(0, closes.length - 11)];
    const slopePct = (last - backClose) / last;
    if (slopePct > 0.001) { score += 1; parts.push('rising'); }
    else if (slopePct < -0.001) { score -= 1; parts.push('falling'); }
    // 3) RSI vs 50
    if (typeof ta.rsi === 'number') {
      if (ta.rsi >= 55) { score += 1; parts.push(`RSI ${Math.round(ta.rsi)}`); }
      else if (ta.rsi <= 45) { score -= 1; parts.push(`RSI ${Math.round(ta.rsi)}`); }
    }
    // 4) DI direction (only if ADX shows some trend)
    if (typeof ta.plusDi === 'number' && typeof ta.minusDi === 'number' && (ta.adx ?? 0) >= 18) {
      if (ta.plusDi > ta.minusDi) { score += 1; parts.push('+DI>−DI'); }
      else if (ta.minusDi > ta.plusDi) { score -= 1; parts.push('−DI>+DI'); }
    }
    // clamp to -3..3 for a stable label
    score = Math.max(-3, Math.min(3, score));
    return { score, parts };
  };

  const htfTrend = useMemo(() => {
    const h = scoreHtf(htfHourly);
    const d = scoreHtf(htfDaily);
    if (!h && !d) return null;
    const word = (s: number) => s >= 2 ? 'UP' : s <= -2 ? 'DOWN' : 'FLAT';
    const hWord = h ? word(h.score) : '—';
    const dWord = d ? word(d.score) : '—';
    // Overall: daily leads (the tide), hourly confirms. Aligned strong = STRONG.
    let label = 'MIXED', tone: 'up' | 'down' | 'flat' = 'flat';
    if (h && d) {
      if (h.score >= 2 && d.score >= 2) { label = 'STRONG UP'; tone = 'up'; }
      else if (h.score <= -2 && d.score <= -2) { label = 'STRONG DOWN'; tone = 'down'; }
      else if (d.score >= 2) { label = 'UP'; tone = 'up'; }
      else if (d.score <= -2) { label = 'DOWN'; tone = 'down'; }
      else if (h.score >= 2) { label = 'UP (1h)'; tone = 'up'; }
      else if (h.score <= -2) { label = 'DOWN (1h)'; tone = 'down'; }
      else { label = 'FLAT'; tone = 'flat'; }
    } else {
      const only = (h || d)!;
      label = word(only.score) === 'UP' ? 'UP' : word(only.score) === 'DOWN' ? 'DOWN' : 'FLAT';
      tone = word(only.score) === 'UP' ? 'up' : word(only.score) === 'DOWN' ? 'down' : 'flat';
    }
    // BTST guidance
    const btst = tone === 'up'
      ? 'BTST longs are with the higher-timeframe trend; overnight holds of long/CE align with the tide.'
      : tone === 'down'
        ? 'BTST shorts are with the higher-timeframe trend; overnight holds of short/PE align with the tide.'
        : 'Higher timeframes are mixed/flat — BTST holds carry more overnight risk; size down or skip.';
    return {
      label, tone, hWord, dWord,
      hParts: h?.parts.join(', ') || 'insufficient data',
      dParts: d?.parts.join(', ') || 'insufficient data',
      btst,
    };
  }, [htfHourly, htfDaily]);

  // First-15-minute opening range lines are drawn on the canvas overlay
  // (alongside PDH/PDL/S&R) so the labels are centered and no value shows on
  // the Y axis. See the "Draw S&R / PDH / PDL text and lines" block below.

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
    liveClosedCandlesRef.current = [];

    // 1. Subscribe ONLY the active symbol
    subscribeToTicks(currentSymbol);

    // 2. Map high-performance instant tick update to chart instance
    const removeListener = addWsMessageListener((msg) => {
      // Live futures delta (pressure) proxy broadcast — cheap, update ref + state.
      if (msg && msg.type === 'delta') {
        const d = { pressure: Number(msg.pressure) || 0, dayBias: Number(msg.dayBias) || 0, cvd: Number(msg.cvd) || 0 };
        deltaRef.current = d;
        setDeltaInfo(d);
        return;
      }
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

      // LIVE OPTION PREMIUM. The server broadcasts the traded/armed contract's
      // ticks as 'optionTick' keyed by instrument TOKEN — they carry no symbol, so
      // the symbol match below never saw them and an option chart's premium sat
      // still between the 15s polls. Normalise into the same shape as an index
      // tick so exactly one code path builds the live candle for both.
      let isOptionTick = false;
      if (msg && msg.type === 'optionTick' && msg.token != null && typeof msg.ltp === 'number'
          && String(msg.token) === String(instrumentTokenRef.current)) {
        isOptionTick = true;
        msg = { ...msg, type: 'tick', symbol: currentSymbol, candle: { close: msg.ltp } };
      }

      const normalize = (s: string) => s.replace(/^(NSE:|BSE:|NFO:)/, '').trim();
      const msgSym = msg.symbol;
      const isMatch = msg.type === "tick" && normalize(msgSym) === normalize(currentSymbol);

      if (isMatch) {
        setLastTickMessage(`${msgSym}: ${msg.candle.close.toFixed(2)}`);
        try { checkLevelAlertsRef.current(msg.candle.close); } catch(e) {}
        if (mainSeriesRef.current && msg.candle) {
          const tfMin = parseInt(timeframe) || 5;
          // Synchronize time calculations using the high-precision server/exchange clock
          // Clamp to "now" (server-corrected) plus a 2s skew allowance. A tick
          // stamped in the future would roll the chart onto a phantom next bar;
          // the 15s reconciliation below would then see the server as "behind"
          // and silently stop correcting — the cause of a frozen candle with a
          // phantom wick and no volume that only a manual refresh cleared.
          const nowServerSec = Math.floor(Date.now() / 1000) + serverTimeOffsetRef.current;
          const rawTickTime = msg.timestamp || nowServerSec;
          const tickTime = Math.min(rawTickTime, nowServerSec + 2);
          
          // Ignore incoming ticks when the market is closed (with 2-minute settlement buffer)
          const ist = getIstDateTime(tickTime);
          const isWeekend = ist.dayOfWeek === 0 || ist.dayOfWeek === 6;
          const isStaleAfterHours = ist.timeOfDaySec >= MARKET_CLOSE_SECONDS_IST + 120 || ist.timeOfDaySec < MARKET_OPEN_SECONDS_IST;
          
          if (isWeekend || isStaleAfterHours) {
            return;
          }

          const currentChartData = chartDataRef.current;
          const seededLastCandle = lastCandleDataRef.current ||
            (currentChartData?.candles?.length ? currentChartData.candles[currentChartData.candles.length - 1] : null);

          // Sanity gate: reject outlier ticks. A single bad tick (0, another
          // instrument, feed glitch) would permanently pollute the forming
          // candle's high/low (they're cumulative max/min). NIFTY never moves
          // 1.5% within one candle vs the last known close, so such a tick is bad data.
          if (seededLastCandle && Number.isFinite(seededLastCandle.close) && seededLastCandle.close > 0) {
            // An option premium of 150 moving 5 points is a 3.3% move and entirely
            // normal, especially near expiry; NIFTY moving 1.5% inside one candle is
            // not. One threshold cannot serve both, so the gate widens for options
            // while staying tight on the index.
            const devLimit = isOptionTick ? 0.25 : 0.015;
            const dev = Math.abs(msg.candle.close - seededLastCandle.close) / seededLastCandle.close;
            if (!Number.isFinite(msg.candle.close) || msg.candle.close <= 0 || dev > devLimit) {
              return;
            }
          }

          // Daily/Weekly/Monthly: a live tick always belongs to the CURRENT (last) bar.
          // A new bar only appears when the server rolls to the next day/week/month, which the
          // background REST poll introduces. getMarketAlignedCandleStart is a no-op for any
          // timeframe >= 24h, so aligning to the raw tick time would push today's tick past the
          // stored daily bar and spawn a fresh phantom bar on EVERY tick (advancing intraday
          // timestamps) — a dense cluster of phantom candles and matching phantom RSI points at
          // the right edge. Pinning to the current bar's time makes every tick update in place.
          const isIntradayTf = tfMin < 1440;
          let updateTime: number;
          if (isIntradayTf) {
            updateTime = getMarketAlignedCandleStart(tickTime, tfMin);
          } else if (lastCandleTimeRef.current !== null) {
            updateTime = lastCandleTimeRef.current;
          } else if (seededLastCandle) {
            updateTime = seededLastCandle.time;
          } else {
            updateTime = getMarketAlignedCandleStart(tickTime, tfMin);
          }

          if (lastCandleTimeRef.current !== null) {
            if (updateTime < lastCandleTimeRef.current) {
              // Ignore outdated tick that is older than our last advanced candle
              return;
            }
          }

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
          {
            const prevC = lastCandleDataRef.current;
            if (prevC && prevC.time < updatedCandle.time) {
              const arc = liveClosedCandlesRef.current;
              if (!arc.length || arc[arc.length - 1].time < prevC.time) arc.push(prevC);
              if (arc.length > 600) arc.splice(0, arc.length - 600);
            }
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
             // The chart's candle clock is AHEAD of the server's. That means we
             // rolled onto a bar that doesn't exist yet (bad tick timestamp, or a
             // clock/offset drift). Previously this returned every cycle, which
             // permanently switched off the 15s correction: volume stopped
             // updating and any wick invented by a stray tick stayed until the
             // user manually refreshed. Treat it as a desync and reseed instead,
             // rate-limited so it can never loop.
             const sinceLastReseed = Date.now() - lastDesyncReseedRef.current;
             if (sinceLastReseed > 30000) {
               lastDesyncReseedRef.current = Date.now();
               console.warn('[chart] clock desync — chart bar ahead of server; reseeding history');
               try { refetchTa(); } catch (e) {}
             }
             return;
           }

           // Self-heal: if the server is 2+ bars ahead of the chart's last drawn bar
           // (tab was throttled/asleep, or we seeded from stale cache), a single-bar
           // update() would leave a hole of missing candles. Reseed the full history
           // through the normal chartData path instead.
           if (lastCandleTimeRef.current !== null && updateTime - lastCandleTimeRef.current >= 2 * tfMin * 60) {
             try { refetchTa(); } catch(e) {}
             return;
           }

           const live = lastCandleDataRef.current;
           const ticksFresh = (Date.now() - lastTickAtRef.current) < 10000;
           let updatedCandle;
           if (live && live.time === updateTime && ticksFresh) {
             // Same forming candle, live ticks still flowing: keep the live OHLC.
             // The 15s server snapshot lags the ticks, so don't let it retract the
             // tick-extended high/low or reset the live close (that caused the jump vs Zerodha/TV).
             // But clamp the preserved extremes to NEAR the server's values: genuine
             // tick extremes only exceed the snapshot by what price moved since it
             // (seconds), while a polluted wick from a bad tick sits far outside —
             // this heals it instead of preserving it forever.
             const tol = Math.max(latestCandle.close * 0.001, 10); // ~0.1% or 10 pts
             updatedCandle = {
               time: updateTime,
               open: live.open,
               high: Math.min(Math.max(live.high, latestCandle.high), latestCandle.high + tol),
               low: Math.max(Math.min(live.low, latestCandle.low), latestCandle.low - tol),
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
           {
             const prevC = lastCandleDataRef.current;
             if (prevC && prevC.time < updatedCandle.time) {
               const arc = liveClosedCandlesRef.current;
               if (!arc.length || arc[arc.length - 1].time < prevC.time) arc.push(prevC);
               if (arc.length > 600) arc.splice(0, arc.length - 600);
             }
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

           // CLOSED-BAR AUDIT. Everything above can only ever repair the NEWEST bar:
           // lightweight-charts' update() refuses to touch a bar that is already behind
           // the last one. So a bar that closed WRONG — ticks missing through a proxy
           // blip, volume left at zero, a high or low never corrected — stays wrong for
           // the rest of the session no matter how many times the poll runs. That is
           // exactly the "the last two candles never update" symptom.
           //
           // Fix: compare the server's recent CLOSED bars against the ones we hold and,
           // when they disagree, reseed the whole series (the only way to rewrite a bar
           // in place). Rate-limited to once a minute, and self-limiting: after one
           // reseed our bars ARE the server's, so it stops firing on its own.
           if (!isCancelled && Array.isArray(data.candles) && data.candles.length >= 4) {
             const ours = new Map<number, any>();
             for (const c of (chartDataRef.current?.candles || [])) ours.set(toUnixSeconds(c.time), c);
             for (const c of liveClosedCandlesRef.current) ours.set(toUnixSeconds(c.time), c);
             const serverClosed = data.candles.slice(-4, -1); // newest bar is handled above
             let drift = '';
             for (const sc of serverClosed) {
               const t = getMarketAlignedCandleStart(toUnixSeconds(sc.time), tfMin);
               const oc = ours.get(t);
               if (!oc) { drift = `bar ${t} missing from the chart`; break; }
               // Tolerance is deliberately tight but not zero: a bar built from ticks can
               // sit a point or two off the server's, which is not worth a reseed.
               const tol = Math.max((sc.close || 0) * 0.0005, 2);
               if (
                 Math.abs((oc.close ?? 0) - sc.close) > tol ||
                 (oc.high ?? 0) < sc.high - tol ||
                 (oc.low ?? Infinity) > sc.low + tol
               ) { drift = `bar ${t} differs from the server`; break; }
             }
             if (drift && Date.now() - lastTailReseedRef.current > 60000) {
               lastTailReseedRef.current = Date.now();
               console.warn(`[chart] closed-bar audit: ${drift} — reseeding history`);
               try { refetchTa(); } catch (e) {}
             }
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

  const lastGoodChartDataRef = useRef<any>(null);
  const chartData = useMemo(() => {
    if (!taInfo || !taInfo.candles) return lastGoodChartDataRef.current;

    // Guard against the brief window during a timeframe switch where `timeframe`
    // has already changed but `taInfo` still holds the PREVIOUS timeframe's candles
    // (kept on screen by placeholderData). The server echoes which timeframe it
    // computed; on mismatch, keep showing the last good render rather than
    // re-aligning old 5m candles onto 1m buckets (which drew malformed candles).
    const tfNum = parseInt(timeframe, 10) || 5;
    if (typeof taInfo.timeframe === 'number' && taInfo.timeframe !== tfNum) {
      return lastGoodChartDataRef.current;
    }

    // De-duplicate and sort
    const uniqueCandles: any[] = [];
    const seen = new Set();
    for (const c of taInfo.candles) {
      // Kite candle timestamps or our server timestamps
      const timeSec = getMarketAlignedCandleStart(toUnixSeconds(c.time), tfNum);
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

    const result = {
      candles: uniqueCandles,
      spot: taInfo.spot,
    };
    lastGoodChartDataRef.current = result;
    return result;
  }, [taInfo, timeframe]);

  useEffect(() => {
    chartDataRef.current = chartData;
    // Fresh history supersedes the live archive up to its last candle -- prune to
    // avoid double-counting (option charts refetch every 15s; NIFTY on reload).
    {
      const cs = chartData?.candles;
      if (cs && cs.length) {
        const lastT = cs[cs.length - 1].time;
        liveClosedCandlesRef.current = liveClosedCandlesRef.current.filter((k: any) => k.time > lastT);
      } else {
        liveClosedCandlesRef.current = [];
      }
    }
    const latest = chartData?.candles?.[chartData.candles.length - 1];
    if (!latest) return;
    if (lastCandleTimeRef.current === null || latest.time > lastCandleTimeRef.current) {
      lastCandleTimeRef.current = latest.time;
      lastCandleDataRef.current = latest;
    }
  }, [chartData]);

  const divergences = useMemo(() => {
    if (!chartData || !chartData.candles || parseInt(timeframe) < 15) return [];
    // Args: (candles, maxDistance between the two pivots, minRSIDiff, timeframe, pivotLookback)
    // maxDistance is now measured pivot-to-pivot (swing to swing), so it needs to be
    // wider than the old candle-to-candle 7. pivotLookback=3 = 3 bars each side define a swing.
    return getDivergences(chartData.candles, 40, 3, timeframe, 3);
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

  // Rebuild the alert level list whenever any level source changes. Only levels
  // whose indicator is currently visible are alerted — what you see is what alerts.
  useEffect(() => {
    const L: { key: string; label: string; price: number }[] = [];
    const add = (key: string, label: string, price: any) => {
      const p = Number(price);
      if (Number.isFinite(p) && p > 0) L.push({ key, label, price: p });
    };
    if (showHLevels && !isOptionView && Array.isArray(hLevels)) {
      const names = ['RED OUTER', 'RED INNER', 'TRAP UPPER', 'TRAP LOWER', 'GREEN INNER', 'GREEN OUTER'];
      hLevels.forEach((v, i) => { if (v > 0) add(`h${i}`, names[i] || `H-Level ${i + 1}`, v); });
    }
    if (showFiftyPercentLevels && !isOptionView && Array.isArray(hLevels)) {
      const active = hLevels.filter(v => v > 0).sort((a, b) => b - a);
      for (let i = 0; i < active.length - 1; i++) {
        const mid = Math.round((active[i] + active[i + 1]) / 2);
        add(`fifty${i}`, '50% Level', mid);
      }
    }
    if (showPdhPdl) { add('pdh', 'PDH', pdhPdlData?.pdh); add('pdl', 'PDL', pdhPdlData?.pdl); }
    if (showSnR) {
      add('sup', 'Support', localAnalytics?.supportZone?.strikePrice);
      add('res', 'Resistance', localAnalytics?.resistanceZone?.strikePrice);
    }
    if (showOpeningRange) {
      add('orh', '15m High', (taInfo as any)?.openingRange?.high);
      add('orl', '15m Low', (taInfo as any)?.openingRange?.low);
    }
    if (showDsZones && !isOptionView) {
      const dz = (taInfo as any)?.dsZones;
      (dz?.demand || []).forEach((z: any, i: number) => add(`dz${i}`, 'Demand zone', z.top));
      (dz?.supply || []).forEach((z: any, i: number) => add(`sz${i}`, 'Supply zone', z.bottom));
    }
    alertLevelsRef.current = L;
  }, [hLevels, showHLevels, showFiftyPercentLevels, pdhPdlData, showPdhPdl, localAnalytics, showSnR, taInfo, showOpeningRange, showDsZones]);

  // Fire one alert: OS notification (works from background tabs) + in-app toast + beep.
  const fireLevelAlert = (label: string, price: number, spot: number, dirUp: boolean) => {
    const title = `${label} touched`;
    const body = `Price ${spot.toFixed(2)} crossed ${dirUp ? 'up through' : 'down through'} ${label} (${price})`;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body, tag: `lvl-${label}-${price}` });
      }
    } catch(e) {}
    try { toast(title, { description: body }); } catch(e) {}
    try {
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC) {
        const actx = new AC();
        const o = actx.createOscillator(); const g = actx.createGain();
        o.connect(g); g.connect(actx.destination);
        o.frequency.value = dirUp ? 880 : 520; g.gain.value = 0.08;
        o.start(); o.stop(actx.currentTime + 0.18);
        setTimeout(() => { try { actx.close(); } catch(e) {} }, 400);
      }
    } catch(e) {}
  };

  // Crossing detector, called from the live tick handler. Fires when price crosses
  // a level between consecutive ticks; per-level 3-min cooldown, and re-arms only
  // after price moves >0.05% away from the level (prevents hover spam).
  const checkLevelAlerts = (spot: number) => {
    if (!levelAlertsOnRef.current || !Number.isFinite(spot) || spot <= 0) return;
    const prev = alertPrevSpotRef.current;
    alertPrevSpotRef.current = spot;
    if (prev === null || prev === spot) return;
    const now = Date.now();
    const rearmDist = spot * 0.0005; // 0.05% ≈ ~12 pts on NIFTY
    for (const { key, label, price } of alertLevelsRef.current) {
      let st = alertStateRef.current.get(key);
      if (!st) { st = { lastFired: 0, armed: true }; alertStateRef.current.set(key, st); }
      if (!st.armed && Math.abs(spot - price) > rearmDist) st.armed = true;
      const crossedUp = prev < price && spot >= price;
      const crossedDown = prev > price && spot <= price;
      if ((crossedUp || crossedDown) && st.armed && now - st.lastFired > 180000) {
        st.lastFired = now; st.armed = false;
        fireLevelAlert(label, price, spot, crossedUp);
      }
    }
  };
  const checkLevelAlertsRef = useRef(checkLevelAlerts);
  checkLevelAlertsRef.current = checkLevelAlerts;

  // Fire a breakout-authenticity alert (distinct sound from level-touch).
  const fireBreakoutAlert = (r: any) => {
    const dirWord = r.direction === 'up' ? 'break UP' : 'break DOWN';
    const title = r.verdict === 'FAKEOUT_RISK'
      ? `⚠️ Fakeout risk: ${r.level}`
      : `Breakout ${r.verdict === 'STRONG' ? '✓ strong' : 'moderate'}: ${r.level}`;
    const body = `${dirWord} @ ${r.price} · score ${r.score}/100 · ${r.reasons.slice(0, 3).join(', ')}`;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body, tag: `brk-${r.level}-${r.brokeAt}` });
      }
    } catch(e) {}
    try { toast(title, { description: body }); } catch(e) {}
    try {
      notificationService.add('divergence', title, body);
    } catch(e) {}
    try {
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC) {
        const actx = new AC();
        const o = actx.createOscillator(); const g = actx.createGain();
        o.connect(g); g.connect(actx.destination);
        // strong = rising double-ish tone, fakeout = low warning tone
        o.frequency.value = r.verdict === 'FAKEOUT_RISK' ? 320 : (r.direction === 'up' ? 990 : 590);
        g.gain.value = 0.09;
        o.start(); o.stop(actx.currentTime + 0.28);
        setTimeout(() => { try { actx.close(); } catch(e) {} }, 500);
      }
    } catch(e) {}
  };

  // Evaluate breakout authenticity whenever a NEW candle closes. Uses only closed
  // candles (chartData excludes the forming bar via its own logic) against the
  // same visible levels the alert engine uses, plus the live futures pressure proxy.
  useEffect(() => {
    if (!chartData || !chartData.candles || chartData.candles.length < 5) return;
    const candles = chartData.candles;
    const lastBar = candles[candles.length - 1];
    if (!lastBar || lastBar.time === lastBreakoutBarRef.current) return; // once per bar
    const levels = (alertLevelsRef.current || [])
      .filter(l => Number.isFinite(l.price) && l.price > 0)
      .map(l => ({ name: l.label, price: l.price }));
    if (levels.length === 0) return;

    const res = evaluateBreakout(
      candles.map((c: any) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
      levels,
      { pressure: deltaRef.current ? deltaRef.current.pressure : null }
    );
    lastBreakoutBarRef.current = lastBar.time;
    if (res) {
      setBreakoutInfo(res);
      // Alert only on decisive verdicts, if enabled.
      if (breakoutAlertsOnRef.current && (res.verdict === 'STRONG' || res.verdict === 'FAKEOUT_RISK')) {
        fireBreakoutAlert(res);
      }
    }
  }, [chartData]);


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
  const fvgZonesRef = useRef<any[]>([]);
  const fvgSigRef = useRef<string>('');
  const obZonesRef = useRef<any[]>([]);
  const structRef = useRef<any[]>([]);
  const structSigRef = useRef<string>('');
  const obSigRef = useRef<string>('');

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
      timeScale: {
        ...commonOptions.timeScale,
        // Stated rather than left to the default: the RSI pane deliberately hides
        // its own axis, so the MAIN chart is the only thing that ever draws the
        // time scale. If this is ever off, the chart has no x-axis at all.
        visible: true,
      },
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
      // Candle price scale ALWAYS auto-fits to the data. (A previous "Y-lock"
      // could pin it to a stale near-zero range and hide the candles — removed.)
    });

    mainSeriesRef.current = mainSeries;
    // Re-attach the SL/TP lines in the same frame the series is created. Without
    // this they stay missing until ensure()'s next 1s tick — the blink seen every
    // ~15s on an option chart, where the 15s data refetch rebuilds the series.
    try { slEnsureRef.current?.(); } catch (e) {}

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
          if (showPdhPdl && !isOptionView && pdhPrice !== null && pdlPrice !== null) {
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

          const price = mainSeries.coordinateToPrice(y);

          // OPTION CHART: tapping buys THE CONTRACT ON SCREEN, at market, via the
          // normal order ticket — which is the confirmation step. The strike menu
          // is still never shown here: the y-coordinate on this chart is a PREMIUM,
          // so strikes derived from it would be meaningless.
          //
          // The tapped price does NOT set the entry. A market order fills at the
          // live premium, so pretending the tap chose a price would be a lie the
          // fill would immediately contradict; the tap is only the trigger.
          if (isOptionViewRef.current) {
            if (quickTradeEnabledRef.current && price !== null) openTriggerBoxRef.current(price);
            return;
          }

          if (price !== null && quickTradeEnabledRef.current && !isOptionViewRef.current) {
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
    liveClosedCandlesRef.current = [];
    }
    
    const isFirstChartLoad = !chartFirstLoadDone;
    if (logicalRangeRef.current && !isFirstChartLoad) {
      try {
        mainChart.timeScale().setVisibleLogicalRange(logicalRangeRef.current);
      } catch (e) {}
    } else {
      // First mount of the session (or no saved range): show the latest candles.
      focusRecentCandles(mainChart, chartData.candles);
    }

    // Toggle the "scroll to latest" button: visible only when the right edge of the
    // view is more than a few bars behind the last candle.
    const jumpRangeHandler = (range: any) => {
      try {
        const total = (chartDataRef.current?.candles?.length) || chartData.candles.length;
        if (!range || !total) { setShowJumpToLatest(false); return; }
        // range.to is a logical (bar) index; last bar is total-1. If we're viewing
        // well before the end, show the button.
        const barsBehind = (total - 1) - range.to;
        setShowJumpToLatest(barsBehind > 3);
      } catch (e) {}
    };
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(jumpRangeHandler);
    chartFirstLoadDone = true;

    bbUpperSeriesRef.current = null;
    bbMiddleSeriesRef.current = null;
    bbLowerSeriesRef.current = null;
    if (showBB && !isOptionView && bbData && bbData.length > 0) {
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

    // Manual scaling of the RSI axis is fully enabled: the user can pinch/drag the
    // axis to any range and it stays (no snap-back). Double-tapping the axis still
    // resets to the auto 0-100 fit.

    const rsiData = chartData.candles.map((c: any) => ({
      time: c.time as any,
      value: c.rsi14 !== undefined ? c.rsi14 : 50,
    }));
    rsiSeries.setData(rsiData);
    
    if (logicalRangeRef.current && !isFirstChartLoad) {
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
          persistLogicalRanges();
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
          persistLogicalRanges();
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
    // OHLC panel is hover-only: it stays hidden until the crosshair is on a candle.

    const rsiDataMap = new Map(rsiData.map((d: any) => [d.time, d.value]));

    mainChart.subscribeCrosshairMove(param => {
      if (!param.sourceEvent) return;
      try {
        let currentCandle = null;
        let currentVolume = null;

        if (!param.point || param.point.x < 0 || param.point.y < 0) {
          try { rsiChart.clearCrosshairPosition(); } catch(e) {}
          setRsiHoverValue(null);
          if (ohlcPanel) ohlcPanel.style.display = 'none';
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
          if (currentCandle) {
            ohlcPanel.style.display = 'flex';
            updateOHLCInfoPanel(ohlcPanel, currentCandle, currentVolume);
          } else {
            ohlcPanel.style.display = 'none';
          }
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
          if (currentCandle) {
            ohlcPanel.style.display = 'flex';
            updateOHLCInfoPanel(ohlcPanel, currentCandle, currentVolume);
          } else {
            ohlcPanel.style.display = 'none';
          }
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
            // Route through syncChartSize so the observer can never re-apply a
            // height that reaches past the visible area (see the note there).
            syncChartSize();
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

    // A ResizeObserver only fires when the CONTAINER changes size. That leaves one
    // hole, and it is the bug: if the chart canvas is ever given a height TALLER
    // than its container — which happens when the container is measured before the
    // mobile layout has settled, since iOS resolves 100dvh and positions the fixed
    // toolbars late — then the container itself never changes again, nothing
    // re-fires, and the canvas stays too tall for the whole session. The container
    // is overflow-hidden, so the strip that gets clipped is the bottom one: the
    // time axis. Rotating the phone fixed it precisely because rotation is the one
    // thing that forces a container resize.
    //
    // So: re-measure at several settle points after mount, and on every event that
    // can change the usable viewport, applying only when it actually differs.
    // Declared with `function` on purpose: the ResizeObserver handler above calls
    // it, and a const arrow would only work by luck of timing.
    function syncChartSize() {
      try {
        const el = chartContainerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const w = Math.floor(el.clientWidth);
        if (w <= 0) return;

        // Size to what is actually VISIBLE, not to the container. Two previous
        // attempts trusted the container's own height and both failed, because the
        // container itself can extend past the bottom of the screen: the page height
        // is calc(100dvh - 124px - safe-area-bottom), a hard-coded guess that does
        // not hold on every device. Whatever hangs below is hidden behind the fixed
        // toolbar, and the strip that gets swallowed is the chart's time axis.
        //
        // So measure the real floor: the top of the fixed toolbar if it is fixed
        // (mobile), otherwise the visible viewport. The chart then ends exactly
        // where the visible area does and its axis can never be pushed off-screen.
        const vvH = (window as any).visualViewport?.height ?? window.innerHeight;
        let floorY = vvH;
        const bar = bottomBarRef.current;
        if (bar) {
          const pos = window.getComputedStyle(bar).position;
          if (pos === 'fixed') floorY = Math.min(floorY, bar.getBoundingClientRect().top);
        }
        const visibleH = Math.floor(floorY - rect.top);
        // Never trust a nonsense measurement mid-layout; fall back to the container.
        const h = visibleH > 120 ? Math.min(visibleH, Math.floor(el.clientHeight) || visibleH) : Math.floor(el.clientHeight);
        if (!h || h <= 0) return;

        const o: any = mainChart.options();
        if (o.width !== w || o.height !== h) mainChart.applyOptions({ width: w, height: h });
      } catch (e) {}
    }
    const sizeTimers = [0, 120, 400, 1200, 2500].map(ms => setTimeout(syncChartSize, ms));
    window.addEventListener('resize', syncChartSize);
    window.addEventListener('orientationchange', syncChartSize);
    document.addEventListener('visibilitychange', syncChartSize);
    const vv: any = (window as any).visualViewport;
    if (vv) { vv.addEventListener('resize', syncChartSize); vv.addEventListener('scroll', syncChartSize); }

    const mainResizeObserver = new ResizeObserver(handleMainResize);
    const rsiResizeObserver = new ResizeObserver(handleRsiResize);

    if (chartContainerRef.current) mainResizeObserver.observe(chartContainerRef.current);
    if (rsiContainerRef.current) rsiResizeObserver.observe(rsiContainerRef.current);

    return () => {
      sizeTimers.forEach(t => clearTimeout(t));
      window.removeEventListener('resize', syncChartSize);
      window.removeEventListener('orientationchange', syncChartSize);
      document.removeEventListener('visibilitychange', syncChartSize);
      if (vv) { vv.removeEventListener('resize', syncChartSize); vv.removeEventListener('scroll', syncChartSize); }
      mainResizeObserver.disconnect();
      rsiResizeObserver.disconnect();
      try {
      } catch (e) {}
      try { mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(jumpRangeHandler); } catch (e) {}
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
          const closedArc = liveClosedCandlesRef.current;
          const arcTailT = closedArc.length ? closedArc[closedArc.length - 1].time : 0;
          const sig = `${baseC.length}|${closedArc.length}|${arcTailT}|${liveC?.time || 0}|${liveC?.close ?? 0}|${liveC?.high ?? 0}|${liveC?.low ?? 0}|${bbPeriod}|${bbStdDev}`;
          if (sig !== bbSigRef.current) {
            let candlesForBB: any[] = baseC;
            if (baseC.length) {
              const lastFetchedT = baseC[baseC.length - 1].time;
              // fetched history + candles closed since the fetch + the forming candle
              const closedSince = closedArc.filter((k: any) => k.time > lastFetchedT);
              candlesForBB = closedSince.length ? [...baseC, ...closedSince] : baseC;
              if (liveC) {
                const lastT = candlesForBB[candlesForBB.length - 1].time;
                if (liveC.time === lastT) candlesForBB = [...candlesForBB.slice(0, -1), liveC];
                else if (liveC.time > lastT) candlesForBB = [...candlesForBB, liveC];
              }
            }
            const live = calculateBollingerBands(candlesForBB, bbPeriod, bbStdDev);
            bbDataRef.current = live;
            bbSigRef.current = sig;
            // Extend the line series with the last few band points -- update()
            // upserts the newest bar and appends newer ones, so the lines advance
            // across candle rolls instead of freezing at the fetch-time last bar.
            if (live.length) {
              const tail = live.slice(-3);
              for (const lp of tail) {
                try { bbUpperSeriesRef.current?.update({ time: lp.time as any, value: lp.upper }); } catch (e) {}
                try { bbMiddleSeriesRef.current?.update({ time: lp.time as any, value: lp.middle }); } catch (e) {}
                try { bbLowerSeriesRef.current?.update({ time: lp.time as any, value: lp.lower }); } catch (e) {}
              }
            }
          }
        } else {
          bbDataRef.current = [];
        }

        const liveBB = bbDataRef.current;
        if (showBB && !isOptionView && liveBB && liveBB.length > 0) {
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

              // Demand/Supply zones — borderless shaded bands, adjustable opacity
              const dz = (taInfo as any)?.dsZones;
              // Fair Value Gaps — recomputed only when a candle CLOSES (sig on
              // closed-candle counts); the forming candle can FILL a zone live.
              if (showFvg && !isOptionView && mainSeriesRef.current) {
                const baseC = chartDataRef.current?.candles || [];
                const arc = liveClosedCandlesRef.current;
                const lastT = baseC.length ? baseC[baseC.length - 1].time : 0;
                const closedSince = arc.filter((k: any) => k.time > lastT);
                // The INSTRUMENT belongs in this key. Without it, switching index kept the
                // previous one's zones: both indices return the same number of candles at
                // the same timeframe, so the key matched, nothing recomputed, and levels
                // from the old index were drawn far off the new chart's scale — invisible.
                const sig = `${instrumentToken}|${timeframe}|${baseC.length}|${closedSince.length}|${closedSince.length ? closedSince[closedSince.length - 1].time : 0}`;
                if (sig !== fvgSigRef.current) {
                  fvgSigRef.current = sig;
                  fvgZonesRef.current = computeFvgZones(closedSince.length ? [...baseC, ...closedSince] : baseC);
                }
                const live = lastCandleDataRef.current;
                const zonesNow = fvgZonesRef.current
                  .map((z: any) => {
                    if (!live) return z;
                    if (z.type === 'bull') {
                      if (live.low <= z.bottom) return null;
                      return live.low < z.top ? { ...z, top: live.low } : z;
                    }
                    if (live.high >= z.top) return null;
                    return live.high > z.bottom ? { ...z, bottom: live.high } : z;
                  })
                  .filter((z: any) => z && z.top - z.bottom > 0.5);
                const pctF = Math.min(100, Math.max(1, parseFloat(dsZoneOpacity) || 8)) / 100;
                for (const z of zonesNow) {
                  const yTop = mainSeriesRef.current.priceToCoordinate(z.top);
                  const yBot = mainSeriesRef.current.priceToCoordinate(z.bottom);
                  if (yTop === null || yBot === null) continue;
                  const x0 = mainChartRef.current?.timeScale()?.timeToCoordinate(z.time as any);
                  const zx = (x0 === null || x0 === undefined) ? 0 : Math.max(0, x0);
                  const zw = Math.max(0, textAlignX - zx);
                  if (zw <= 0) continue;
                  const rgb = z.type === 'bull' ? '34,211,238' : '217,70,239';
                  ctx.fillStyle = `rgba(${rgb},${Math.min(0.35, pctF + 0.04)})`;
                  ctx.fillRect(zx, Math.min(yTop, yBot), zw, Math.abs(yBot - yTop));
                  ctx.strokeStyle = `rgba(${rgb},0.5)`;
                  ctx.lineWidth = 1;
                  ctx.strokeRect(zx, Math.min(yTop, yBot), zw, Math.abs(yBot - yTop));
                  ctx.font = 'bold 9px monospace';
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'middle';
                  ctx.fillStyle = `rgba(${rgb},0.85)`;
                  ctx.fillText(z.type === 'bull' ? 'FVG▲' : 'FVG▼', zx + 6, (yTop + yBot) / 2);
                }
              }

              // Order Blocks — recomputed only when a candle CLOSES, same as the FVG
              // zones. A finished block is drawn with a hard right edge at the point it
              // was superseded or broken; only the live one runs to the current candle.
              // Confluence buy/sell arrows — forward-test signals from the server
              // log. Closed candles only, so an arrow can never repaint. Drawn on
              // the 5-minute index chart, where the rule actually runs.
              if (showConfSignals && !isOptionView && String(timeframe) === '5' && mainSeriesRef.current) {
                const rows = (confSignalsRef.current || []).filter((s: any) => s.symbol === underlying);
                if (rows.length) {
                  const baseC2 = chartDataRef.current?.candles || [];
                  const extra2 = (liveClosedCandlesRef.current || []).filter((k: any) => !baseC2.length || k.time > baseC2[baseC2.length - 1].time);
                  const allC = [...baseC2, ...extra2];
                  const tms = (t: any) => { const n = Number(t); return n < 1e12 ? n * 1000 : n; };
                  for (const s of rows) {
                    let cd: any = null, bd = Infinity;
                    for (const c of allC) { const d = Math.abs(tms(c.time) - s.fired_t); if (d < bd) { bd = d; cd = c; } }
                    if (!cd || bd > 150000) continue;
                    const x = mainChartRef.current?.timeScale()?.timeToCoordinate(cd.time);
                    if (x === null || x === undefined) continue;
                    const long = s.dir === 'LONG';
                    const y = mainSeriesRef.current.priceToCoordinate(long ? cd.low : cd.high);
                    if (y === null) continue;
                    const yy = long ? y + 16 : y - 16;
                    ctx.beginPath();
                    if (long) { ctx.moveTo(x, yy - 8); ctx.lineTo(x - 5, yy); ctx.lineTo(x + 5, yy); }
                    else { ctx.moveTo(x, yy + 8); ctx.lineTo(x - 5, yy); ctx.lineTo(x + 5, yy); }
                    ctx.closePath();
                    ctx.fillStyle = long ? 'rgba(52,211,153,1)' : 'rgba(251,113,133,1)';
                    ctx.fill();
                    ctx.font = 'bold 9px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = long ? 'top' : 'bottom';
                    ctx.fillText(long ? 'BUY' : 'SELL', x, long ? yy + 2 : yy - 2);
                    // Once graded, the arrow carries its result in option points —
                    // the signal and its consequence stay attached to each other.
                    if (s.status === 'GRADED' && s.option_pts != null) {
                      ctx.fillStyle = (s.option_pts || 0) > 0 ? 'rgba(52,211,153,0.9)' : 'rgba(251,113,133,0.9)';
                      ctx.fillText(`${(s.option_pts || 0) > 0 ? '+' : ''}${s.option_pts}`, x, long ? yy + 13 : yy - 13);
                    }
                  }
                }
              }

              // Market structure: a dashed line at the broken level running from the
              // swing that set it to the candle that closed through it, tagged BOS or
              // CHoCH. Index charts only, and recomputed only on a candle close.
              if (showStructure && !isOptionView && mainSeriesRef.current) {
                const baseC = chartDataRef.current?.candles || [];
                const arc = liveClosedCandlesRef.current;
                const lastT = baseC.length ? baseC[baseC.length - 1].time : 0;
                const closedSince = arc.filter((k: any) => k.time > lastT);
                // The INSTRUMENT belongs in this key. Without it, switching index kept the
                // previous one's zones: both indices return the same number of candles at
                // the same timeframe, so the key matched, nothing recomputed, and levels
                // from the old index were drawn far off the new chart's scale — invisible.
                const sig = `${instrumentToken}|${timeframe}|${baseC.length}|${closedSince.length}|${closedSince.length ? closedSince[closedSince.length - 1].time : 0}`;
                if (sig !== structSigRef.current) {
                  structSigRef.current = sig;
                  structRef.current = computeMarketStructure(closedSince.length ? [...baseC, ...closedSince] : baseC);
                }
                for (const ev of structRef.current) {
                  const y = mainSeriesRef.current.priceToCoordinate(ev.level);
                  if (y === null) continue;
                  const x0 = mainChartRef.current?.timeScale()?.timeToCoordinate(ev.fromTime as any);
                  const x1 = mainChartRef.current?.timeScale()?.timeToCoordinate(ev.toTime as any);
                  if (x0 === null || x0 === undefined || x1 === null || x1 === undefined) continue;
                  // CHoCH is the one that says the trend may be turning, so it is the
                  // one that stands out: solid and brighter. BOS is continuation and
                  // stays quiet — the chart should not shout the ordinary event.
                  const isChoch = ev.type === 'CHOCH';
                  const rgb = ev.dir === 'bull' ? '56,189,248' : '244,114,182';
                  ctx.beginPath();
                  ctx.setLineDash(isChoch ? [] : [4, 3]);
                  ctx.strokeStyle = `rgba(${rgb},${isChoch ? 0.95 : 0.55})`;
                  ctx.lineWidth = isChoch ? 1.6 : 1;
                  ctx.moveTo(Math.max(0, x0), y);
                  ctx.lineTo(Math.max(0, x1), y);
                  ctx.stroke();
                  ctx.setLineDash([]);
                  ctx.font = `bold ${isChoch ? 10 : 9}px monospace`;
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'bottom';
                  ctx.fillStyle = `rgba(${rgb},${isChoch ? 1 : 0.8})`;
                  ctx.fillText(isChoch ? 'CHoCH' : 'BOS', Math.max(0, x1) + 4, y - 2);
                }
              }

              if (showOrderBlocks && !isOptionView && mainSeriesRef.current) {
                const baseC = chartDataRef.current?.candles || [];
                const arc = liveClosedCandlesRef.current;
                const lastT = baseC.length ? baseC[baseC.length - 1].time : 0;
                const closedSince = arc.filter((k: any) => k.time > lastT);
                // The INSTRUMENT belongs in this key. Without it, switching index kept the
                // previous one's zones: both indices return the same number of candles at
                // the same timeframe, so the key matched, nothing recomputed, and levels
                // from the old index were drawn far off the new chart's scale — invisible.
                const sig = `${instrumentToken}|${timeframe}|${baseC.length}|${closedSince.length}|${closedSince.length ? closedSince[closedSince.length - 1].time : 0}`;
                if (sig !== obSigRef.current) {
                  obSigRef.current = sig;
                  obZonesRef.current = computeOrderBlocks(closedSince.length ? [...baseC, ...closedSince] : baseC);
                }
                const liveC = lastCandleDataRef.current;
                const pctB = Math.min(100, Math.max(1, parseFloat(dsZoneOpacity) || 8)) / 100;
                for (const z of obZonesRef.current) {
                  const yTop = mainSeriesRef.current.priceToCoordinate(z.top);
                  const yBot = mainSeriesRef.current.priceToCoordinate(z.bottom);
                  if (yTop === null || yBot === null) continue;
                  const x0 = mainChartRef.current?.timeScale()?.timeToCoordinate(z.time as any);
                  const zx = (x0 === null || x0 === undefined) ? 0 : Math.max(0, x0);
                  // A live block can be broken by the candle forming right now — end it at
                  // the current bar rather than letting it run on a level price has left.
                  const brokenLive = !z.endTime && liveC &&
                    (z.type === 'bull' ? liveC.close < z.bottom : liveC.close > z.top);
                  let zRight = textAlignX;
                  if (z.endTime || brokenLive) {
                    const endT = z.endTime || (liveC && liveC.time);
                    const x1 = endT ? mainChartRef.current?.timeScale()?.timeToCoordinate(endT as any) : null;
                    if (x1 !== null && x1 !== undefined) zRight = Math.min(textAlignX, x1);
                  }
                  const zw = Math.max(0, zRight - zx);
                  if (zw <= 0) continue;
                  const rgb = z.type === 'bull' ? '245,158,11' : '139,92,246';
                  const yA = Math.min(yTop, yBot), h = Math.abs(yBot - yTop);
                  ctx.fillStyle = `rgba(${rgb},${Math.min(0.30, pctB + 0.03)})`;
                  ctx.fillRect(zx, yA, zw, h);
                  ctx.strokeStyle = `rgba(${rgb},0.55)`;
                  ctx.lineWidth = 1;
                  ctx.strokeRect(zx, yA, zw, h);
                  // Hard cap on a finished block, so "this one stopped here" is visible at a
                  // glance rather than inferred from where the shading happens to end.
                  if (z.endTime || brokenLive) {
                    ctx.beginPath();
                    ctx.strokeStyle = `rgba(${rgb},0.9)`;
                    ctx.lineWidth = 1.5;
                    ctx.moveTo(zx + zw, yA);
                    ctx.lineTo(zx + zw, yA + h);
                    ctx.stroke();
                  }
                  ctx.font = 'bold 9px monospace';
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'middle';
                  ctx.fillStyle = `rgba(${rgb},0.85)`;
                  ctx.fillText(z.type === 'bull' ? 'OB▲' : 'OB▼', zx + 6, yA + h / 2);
                }
              }

              if (showDsZones && !isOptionView && dz && mainSeriesRef.current) {
                const pct = Math.min(100, Math.max(1, parseFloat(dsZoneOpacity) || 8)) / 100;
                const drawZone = (z: any, rgb: string, labelColor: string, label: string) => {
                  const yTop = mainSeriesRef.current.priceToCoordinate(z.top);
                  const yBot = mainSeriesRef.current.priceToCoordinate(z.bottom);
                  if (yTop === null || yBot === null) return;
                  const zx = 0, zw = textAlignX; // span the chart area
                  ctx.fillStyle = `rgba(${rgb},${pct})`;
                  ctx.fillRect(zx, Math.min(yTop, yBot), zw, Math.abs(yBot - yTop));
                  ctx.font = 'bold 9px monospace';
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'middle';
                  ctx.fillStyle = labelColor;
                  ctx.fillText(label, 8, (yTop + yBot) / 2);
                };
                (dz.demand || []).forEach((z: any) => drawZone(z, '16,185,129', 'rgba(16,185,129,0.55)', 'DEMAND'));
                (dz.supply || []).forEach((z: any) => drawZone(z, '244,63,94', 'rgba(244,63,94,0.55)', 'SUPPLY'));
              }

              const snrDash = snrStyle === 1 ? [5, 5] : snrStyle === 2 ? [2, 4] : [];
              if (showSnR && !isOptionView && localAnalytics?.supportZone?.strikePrice) {
                 const y = mainSeriesRef.current.priceToCoordinate(localAnalytics.supportZone.strikePrice);
                 if (y !== null) linesToDraw.push({ text: `SUP`, y, color: supportColor, dash: snrDash, lineWidth: snrWidth });
              }
              if (showSnR && !isOptionView && localAnalytics?.resistanceZone?.strikePrice) {
                 const y = mainSeriesRef.current.priceToCoordinate(localAnalytics.resistanceZone.strikePrice);
                 if (y !== null) linesToDraw.push({ text: `RES`, y, color: resistanceColor, dash: snrDash, lineWidth: snrWidth });
              }
              const pdhPdlDash = pdhPdlStyle === 1 ? [5, 5] : pdhPdlStyle === 2 ? [2, 4] : [];
              if (showPdhPdl && !isOptionView && pdhPrice !== null) {
                 const y = mainSeriesRef.current.priceToCoordinate(pdhPrice);
                 if (y !== null) linesToDraw.push({ text: `PDH ${pdhPrice}`, y, color: pdhColor, dash: pdhPdlDash, lineWidth: pdhPdlWidth });
              }
              if (showPdhPdl && !isOptionView && pdlPrice !== null) {
                 const y = mainSeriesRef.current.priceToCoordinate(pdlPrice);
                 if (y !== null) linesToDraw.push({ text: `PDL ${pdlPrice}`, y, color: pdlColor, dash: pdhPdlDash, lineWidth: pdhPdlWidth });
              }
              // 15m Opening Range (first 15 min high/low) — centered labels, no Y-axis value
              {
                const or = (taInfo as any)?.openingRange;
                if (showOpeningRange && !isOptionView && or) {
                  if (typeof or.high === 'number') {
                    const y = mainSeriesRef.current.priceToCoordinate(or.high);
                    if (y !== null) linesToDraw.push({ text: `15M HIGH`, y, color: '#ffffff', dash: [], lineWidth: 1 });
                  }
                  if (typeof or.low === 'number') {
                    const y = mainSeriesRef.current.priceToCoordinate(or.low);
                    if (y !== null) linesToDraw.push({ text: `15M LOW`, y, color: '#ffffff', dash: [], lineWidth: 1 });
                  }
                }
              }
              if (showFiftyPercentLevels && !isOptionView && hLevels) {
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
              if (showHLevels && !isOptionView && hLevels) {
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
              
              // Line labels sit on the LEFT edge of the chart so the candlesticks are
              // never covered. leftAnchor() returns the centre-x a pill of width w
              // needs in order for its LEFT edge to land on the padding line.
              const LABEL_LEFT_PAD = 8;
              const leftAnchor = (w: number) => LABEL_LEFT_PAD + w / 2;
              
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

                 // Measure first — the left anchor depends on the pill's width.
                 const textWidth = ctx.measureText(displayText).width;
                 const paddingX = 16; 
                 const totalWidth = textWidth + paddingX;
                 const totalHeight = 18;

                 // Anchor on the LEFT edge. If another label already occupies this
                 // row, step to the RIGHT only (stepping left would run off-chart).
                 let currentX = leftAnchor(totalWidth);
                 let collision = true;
                 let offsetMultiplier = 1;
                 while (collision) {
                    collision = assignedPositions.some(pos => 
                       Math.abs(pos.y - label.y) < 20 && Math.abs(pos.x - currentX) < Math.max(120, textWidth + 30)
                    );
                    if (collision) {
                       currentX = leftAnchor(totalWidth) + offsetMultiplier * 140;
                       offsetMultiplier++;
                       if (offsetMultiplier > 8) break; // safety: never spin forever
                    }
                 }
                 assignedPositions.push({ x: currentX, y: label.y });
                 
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

                    // Left-anchored like every other line label; step RIGHT on collision.
                    let currentX = leftAnchor(tw + 16);
                    let collision = true;
                    let offsetMultiplier = 1;
                    while (collision) {
                       collision = assignedPositions.some(pos =>
                          Math.abs(pos.y - yy) < 20 && Math.abs(pos.x - currentX) < Math.max(120, tw + 30)
                       );
                       if (collision) {
                          currentX = leftAnchor(tw + 16) + offsetMultiplier * 140;
                          offsetMultiplier++;
                          if (offsetMultiplier > 8) break;
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
  }, [showOiBars, oiData, showBB, bbData, timeframe, chartData, bbColor, oiMaxBarWidth, oiCallColor, oiPutColor, oiBarGap, oiBarThickness, localAnalytics, showPdhPdl, pdhPdlData, pdhColor, pdlColor, pdhPdlStyle, pdhPdlWidth, showSnR, supportColor, resistanceColor, snrStyle, snrWidth, showFiftyPercentLevels, hLevels, fiftyPercentColor, showHLevels, hLevelsStyle, hLevelsWidth, taInfo, showOpeningRange, showDsZones, dsZoneOpacity, showFvg, showOrderBlocks, showStructure, showConfSignals, confData]);

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
    <div className="px-1 pt-0 pb-0 md:p-8 animate-in fade-in duration-500 max-w-[1600px] w-full mx-auto md:pb-20 flex flex-col h-[calc(100dvh-124px-env(safe-area-inset-bottom))] md:h-auto md:min-h-screen overflow-hidden md:overflow-visible relative">
      
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

      <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-2 md:gap-3 pb-2 mb-2 md:mb-4">
        <div className="relative flex items-center gap-2 md:gap-4 flex-wrap max-md:pr-28">
          <h1 className="text-base md:text-2xl font-bold text-foreground tracking-tight whitespace-nowrap">
            {isFocusedChart && selectedInstrument
              ? prettyOptionName(selectedInstrument.tradingsymbol,
                  contractExpiry?.symbol === selectedInstrument.tradingsymbol ? contractExpiry.expiry : null)
              : 'Advanced Trading Chart'}
          </h1>
          {/* Mobile: chevron toggles the biases dropdown */}
          <button
            onClick={() => setShowBiases(!showBiases)}
            className="md:hidden p-1 rounded-md bg-muted/50 text-foreground/80"
            aria-label="Show market biases"
          >
            <ChevronDown size={16} className={`transition-transform ${showBiases ? 'rotate-180' : ''}`} />
          </button>
          <IstSessionClock />
          <div className={`${showBiases ? 'flex' : 'hidden'} md:flex absolute md:static top-full left-0 mt-1 md:mt-0 z-[80] md:z-auto flex-col md:flex-row items-start md:items-center gap-1.5 md:gap-4 bg-card md:bg-transparent border border-white/10 md:border-0 rounded-lg md:rounded-none p-2 md:p-0 shadow-xl md:shadow-none max-h-[60vh] md:max-h-none overflow-y-auto md:overflow-visible md:flex-wrap`}>
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
          {decision && (() => {
            const biasText = decision.bullScore > decision.bearScore ? 'BULLISH' : decision.bearScore > decision.bullScore ? 'BEARISH' : 'NEUTRAL';
            const color = biasText === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-400'
              : biasText === 'BEARISH' ? 'bg-rose-500/20 text-rose-400'
              : 'bg-slate-500/20 text-slate-300';
            return (
              <span className={`px-3 py-1 rounded-md text-xs font-mono font-bold whitespace-nowrap ${color}`}
                title={`Master Signal — composite bias. Roughly half its weight is OI-derived support/resistance levels + PCR, the rest technicals (RSI/DI/pattern), VWAP, and FII/DII flow. Bull ${decision.bullScore} vs Bear ${decision.bearScore} · regime ${decision.regime}. Being OI-heavy, it lags price much like the OI bias — weigh against price.`}>
                SIGNAL: {biasText}
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
          {htfTrend && (() => {
            const color = htfTrend.tone === 'up' ? 'bg-emerald-500/20 text-emerald-400'
              : htfTrend.tone === 'down' ? 'bg-rose-500/20 text-rose-400'
              : 'bg-slate-500/20 text-slate-300';
            return (
              <span className={`px-3 py-1 rounded-md text-xs font-mono font-bold whitespace-nowrap ${color}`}
                title={`Higher-timeframe trend (BTST context) — the bigger tide behind intraday moves. Daily: ${htfTrend.dWord} (${htfTrend.dParts}). 1-hour: ${htfTrend.hWord} (${htfTrend.hParts}). ${htfTrend.btst} Always confirm with price; this is context, not a trigger.`}>
                TREND: {htfTrend.label}
              </span>
            );
          })()}
          {breakoutInfo && (() => {
            const v = breakoutInfo.verdict;
            const color = v === 'STRONG' ? (breakoutInfo.direction === 'up' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400')
              : v === 'FAKEOUT_RISK' ? 'bg-amber-500/20 text-amber-400'
              : 'bg-slate-500/20 text-slate-300';
            const word = v === 'STRONG' ? `BREAKOUT ✓ ${breakoutInfo.direction === 'up' ? 'UP' : 'DOWN'}` : v === 'FAKEOUT_RISK' ? 'FAKEOUT RISK' : 'BREAKOUT ?';
            return (
              <span className={`px-3 py-1 rounded-md text-xs font-mono font-bold whitespace-nowrap ${color}`}
                title={`${breakoutInfo.level} ${breakoutInfo.direction === 'up' ? 'break up' : 'break down'} @ ${breakoutInfo.price} — authenticity ${breakoutInfo.score}/100 (${breakoutInfo.reasons.join(', ')}). Structural read of the breakout candle + volume + live futures pressure; NOT true order-flow delta. Confirm with price.`}>
                {word} {breakoutInfo.score}
              </span>
            );
          })()}
          {deltaInfo && (() => {
            const p = deltaInfo.pressure;
            const color = p >= 0.15 ? 'bg-emerald-500/20 text-emerald-400' : p <= -0.15 ? 'bg-rose-500/20 text-rose-400' : 'bg-slate-500/20 text-slate-300';
            const word = p >= 0.15 ? 'BUY' : p <= -0.15 ? 'SELL' : 'FLAT';
            return (
              <span className={`px-3 py-1 rounded-md text-xs font-mono font-bold whitespace-nowrap ${color}`}
                title={`Futures pressure proxy (~90s window): ${word}, pressure ${p.toFixed(2)}, session lean ${deltaInfo.dayBias.toFixed(2)}, CVD ${deltaInfo.cvd}. Tick-rule uptick/downtick VOLUME on the front-month NIFTY future — a live approximation, NOT true aggressor delta (Kite doesn't provide that). Weigh with price.`}>
                Δ: {word}
              </span>
            );
          })()}
          {wsError && (
             <span className="bg-red-500/20 text-red-400 px-3 py-1 rounded-md text-xs font-mono font-bold animate-pulse whitespace-nowrap">
              WS ERROR: {wsError}
             </span>
          )}
          </div>
          <AiMarketRead taInfo={taInfo} oiData={oiData} pulseBias={pulseBias} model="claude-sonnet-4-6" />
          <MarketContext />
        </div>
        <div ref={bottomBarRef} className="fixed md:static bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-auto left-0 right-0 z-40 bg-[#141618] md:bg-transparent border-t border-white/10 md:border-0 px-2 py-1.5 md:p-0 flex items-center gap-2 md:gap-4 flex-nowrap md:flex-wrap md:justify-end w-full md:w-auto">
          <div className="flex items-center gap-2 shrink-0 min-w-0 md:contents">
          <div className="w-28 max-w-[112px] sm:max-w-none shrink-0 sm:w-auto md:order-1">
          <SymbolSearch 
            onSelect={setSelectedInstrument} 
            currentSymbol={selectedInstrument ? selectedInstrument.tradingsymbol : indexLabel} 
          />
          </div>
          <div className="flex items-center gap-2 shrink-0 md:order-4">
            <span className="hidden md:inline text-sm text-muted-foreground font-medium">
              Timeframe:
            </span>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="appearance-none text-center bg-muted/40 text-foreground border border-0 text-xs md:text-sm rounded-md px-3 focus:outline-none focus:ring-1 focus:ring-primary h-9 [&::-ms-expand]:hidden shrink-0"
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
          <div className="flex md:bg-muted md:p-1 rounded-md shrink-0 md:order-3">
            <div className="relative" ref={indicatorsRef}>
              <button
                onClick={() => setIsIndicatorsOpen(!isIndicatorsOpen)}
                className={`flex items-center justify-center md:justify-start gap-1.5 h-9 w-9 md:w-auto md:h-auto md:px-3 md:py-1.5 text-sm font-medium rounded-md md:rounded-sm transition-colors ${isIndicatorsOpen ? 'bg-primary/20 text-primary md:bg-background/50' : 'bg-muted/40 md:bg-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground'}`}
              >
                <SlidersHorizontal size={18} className="md:hidden" />
                <span className="hidden md:inline">Indicators</span>
                <ChevronDown size={14} className={`hidden md:block transition-transform ${isIndicatorsOpen ? 'rotate-180' : ''}`} />
              </button>
              {isIndicatorsOpen && (
                <div className="fixed md:absolute inset-x-2 md:inset-x-auto bottom-[calc(4rem+env(safe-area-inset-bottom)+3.25rem)] md:bottom-auto md:top-full md:mt-1.5 md:right-0 min-w-0 md:min-w-[240px] max-h-[55vh] md:max-h-none overflow-y-auto md:overflow-hidden bg-card border border-white/10 md:border-0 rounded-md py-1.5 z-[45] shadow-2xl flex flex-col">
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

                  {/* 15m Opening Range (first-15-min high/low lines) */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowOpeningRange(!showOpeningRange)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showOpeningRange && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>15m Opening Range (High/Low)</span>
                    </button>
                  </div>

                  {/* Buy/Sell confluence signals — forward test, 5-min index charts */}
                  {!isOptionView && (
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowConfSignals(!showConfSignals)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showConfSignals && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Buy/Sell Signals (5-min · forward test)</span>
                    </button>
                  </div>
                  )}

                  {/* Market Structure (BOS / CHoCH) — an index study */}
                  {!isOptionView && (
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowStructure(!showStructure)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showStructure && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Market Structure (BOS / CHoCH)</span>
                    </button>
                  </div>
                  )}

                  {/* Order Blocks */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowOrderBlocks(!showOrderBlocks)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showOrderBlocks && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Order Blocks</span>
                    </button>
                  </div>

                  {/* Fair Value Gaps */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowFvg(!showFvg)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showFvg && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Fair Value Gaps (3-candle)</span>
                    </button>
                  </div>

                  {/* Demand / Supply Zones */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setShowDsZones(!showDsZones)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {showDsZones && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Demand/Supply Zones (intraday)</span>
                    </button>
                    <div className="flex items-center gap-1 pr-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        value={dsZoneOpacity}
                        onChange={e => setDsZoneOpacity(e.target.value)}
                        inputMode="numeric"
                        title="Zone darkness (% opacity, 1–100)"
                        className="w-11 bg-muted rounded px-1.5 py-0.5 text-xs text-foreground text-center"
                      />
                      <span className="text-[10px] text-muted-foreground">%</span>
                    </div>
                  </div>

                  {/* Level Touch Alerts */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setLevelAlertsOn(!levelAlertsOn)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {levelAlertsOn && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Level Touch Alerts (sound + popup)</span>
                    </button>
                  </div>

                  {/* Breakout Authenticity Alerts */}
                  <div className="flex items-center justify-between px-3 hover:bg-muted transition-colors group">
                    <button
                      onClick={() => setBreakoutAlertsOn(!breakoutAlertsOn)}
                      className="flex items-center gap-2 py-2 text-sm text-foreground/80 hover:text-foreground transition-colors text-left flex-grow"
                    >
                      <div className="w-4 flex items-center justify-center">
                        {breakoutAlertsOn && <Check size={14} className="text-emerald-400" />}
                      </div>
                      <span>Breakout / Fakeout Alerts (sound + popup)</span>
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

                  {/* OI Bars — an INDEX study. The bars were already suppressed on an
                      option chart, but leaving the switch visible invited turning on
                      something that could never draw. */}
                  {!isOptionView && (
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
                  )}

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
          </div>
          <div className="flex items-center gap-2 flex-1 basis-0 min-w-[52%] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:contents md:min-w-0 md:basis-auto pr-1">
          {(
          <div className="flex items-center justify-center gap-2 h-9 w-9 md:w-auto bg-muted/40 border border-0 rounded-md md:px-3 shrink-0 md:order-2 cursor-pointer" onClick={() => { const next = !quickTradeEnabled; setQuickTradeEnabled(next); try { toast(next ? 'Quick Trade enabled' : 'Quick Trade disabled'); } catch (e) {} }} title="Quick Trade">
             <Zap size={18} className={`md:hidden ${quickTradeEnabled ? 'text-primary' : 'text-muted-foreground'}`} />
             <span className="hidden md:inline text-xs font-medium text-foreground/80">Quick Trade</span>
             <label className="relative hidden md:inline-flex items-center cursor-pointer pointer-events-none">
               <input type="checkbox" className="sr-only peer" checked={quickTradeEnabled} readOnly />
               <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after: after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary"></div>
             </label>
          </div>
          )}
            <button
              onClick={() => {
                setTbReloading(true);
                try { window.dispatchEvent(new CustomEvent('chart_reload')); } catch (e) {}
                setTimeout(() => { try { window.location.reload(); } catch (e) {} }, 150);
              }}
              className="md:hidden shrink-0 md:order-4 flex items-center justify-center h-9 w-9 rounded-md bg-muted/40 text-foreground/80"
              title="Reload chart and hard-refresh the app"
            >
              <RefreshCw size={18} className={tbReloading ? 'animate-spin' : ''} />
            </button>
          <div className="shrink-0 md:order-5 [&>button]:h-9"><BounceConviction taInfo={taInfo} oiData={oiData} pulseBias={pulseBias} /></div>

          </div>
        </div>
      </div>
      


      {isLoading && (!chartData || chartData.candles.length === 0) ? (
        <div className="flex items-center justify-center flex-grow">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
      <div className="flex flex-col flex-grow gap-0 md:gap-2 min-h-0">
        <div className={`items-center gap-1.5 px-1 pb-1 shrink-0 overflow-x-auto ${isFocusedChart ? 'hidden' : 'flex'}`}>
          <button onClick={() => { setUnderlying('NIFTY'); setSelectedInstrument(null); }}
            className={`px-3 h-7 rounded-md text-xs font-mono font-bold transition-colors ${!selectedInstrument && underlying === 'NIFTY' ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-muted/40 text-muted-foreground'}`}>
            NIFTY 50
          </button>
          <button onClick={() => { setUnderlying('BANKNIFTY'); setSelectedInstrument(null); }}
            className={`px-3 h-7 rounded-md text-xs font-mono font-bold transition-colors ${!selectedInstrument && underlying === 'BANKNIFTY' ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-muted/40 text-muted-foreground'}`}>
            BANK NIFTY
          </button>
          <button onClick={() => { setUnderlying('SENSEX'); setSelectedInstrument(null); }}
            className={`px-3 h-7 rounded-md text-xs font-mono font-bold transition-colors ${!selectedInstrument && underlying === 'SENSEX' ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-muted/40 text-muted-foreground'}`}>
            SENSEX
          </button>

          {/* Charts opened this session, kept after the index tabs. Tapping an index
              does not close them; the highlight simply moves. */}
          {openCharts.map((c) => {
            const active = selectedInstrument?.tradingsymbol === c.tradingsymbol;
            return (
              <div key={c.tradingsymbol}
                className={`flex items-center gap-1 pl-2 pr-1 h-7 rounded-md shrink-0 transition-colors ${active ? 'bg-primary/20 border border-primary/30' : 'bg-muted/40'}`}>
                <button
                  onClick={() => setSelectedInstrument(c)}
                  className={`text-xs font-mono font-bold whitespace-nowrap ${active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                  {prettyOptionName(c.tradingsymbol,
                    contractExpiry?.symbol === c.tradingsymbol ? contractExpiry.expiry : null)}
                </button>
                <button
                  onClick={() => {
                    setOpenCharts(prev => prev.filter(x => x.tradingsymbol !== c.tradingsymbol));
                    // Only leave the chart if the one being closed is the one on screen.
                    if (active) setSelectedInstrument(null);
                  }}
                  title="Close this chart"
                  className={`text-sm leading-none px-1 ${active ? 'text-primary/70 hover:text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                  ×
                </button>
              </div>
            );
          })}

          {tradeTabInstr && (
          <button onClick={() => setSelectedInstrument(tradeTabInstr)}
            className={`px-3 h-7 rounded-md text-xs font-mono font-bold transition-colors ${selectedInstrument && String(selectedInstrument.instrument_token) === String(tradeTabInstr.instrument_token) ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-muted/40 text-muted-foreground'}`}>
            {tradeTabInstr.tradingsymbol}
          </button>
          )}
          <TradePnl sync={premSync} />
        </div>


          {/* Main Chart (Price & Volume) */}
          <div className="relative flex-grow flex w-full bg-card rounded-none md:rounded-xl min-h-0 md:min-h-[450px]" onMouseLeave={() => setCrosshairInfo(null)}>
            {/* Leverage meter — why the premium is moving more (or less) than the
                index right now. Display only: pointer-events-none, so it can never
                block a drag, a crosshair, or a level being placed. */}
            {isOptionView && lev && !lev.error && (
              <div className="absolute top-11 left-2 z-[5] pointer-events-none rounded-md bg-background/80 border border-border/60 px-2.5 py-1.5 text-[11px] leading-snug font-mono max-w-[85%]">
                <div className="text-foreground font-semibold">
                  {lev.lambda != null ? `1% index ≈ ${lev.lambda}% premium` : 'gearing — solving…'}
                  {/* The inputs behind the number, so it can be checked at a glance
                      instead of inferred from the OHLC row — which shows the HOVERED
                      candle, not the live premium, and misled us both once already. */}
                  {lev.spot != null && lev.premium != null && (
                    <span className="text-foreground/50 font-normal"> ({lev.spot} / {lev.premium})</span>
                  )}
                </div>
                <div className="text-foreground/80">
                  Δ {lev.delta ?? '—'} · +{lev.gammaPer50 ?? '—'}Δ/50pt · θ {lev.thetaPerDay ?? '—'}/day{lev.iv != null ? ` · IV ${lev.iv}%` : ''}
                </div>
                {lev.window?.text && (
                  <div className={
                    lev.window.tone === 'up' ? 'text-emerald-400'
                    : lev.window.tone === 'down' ? 'text-amber-400'
                    : 'text-foreground/60'
                  }>
                    {lev.window.text}{lev.stale ? ' · market closed' : ''}
                  </div>
                )}
              </div>
            )}
            <div
              ref={chartContainerRef}
              onPointerDownCapture={handlePointerDown}
              onPointerMoveCapture={handlePointerMove}
              onPointerUpCapture={handlePointerUp}
              onPointerLeave={handlePointerUp}
              className="border border-0 rounded-none md:rounded-xl stretch-self flex-grow relative w-full overflow-hidden z-20"
            />
            {showJumpToLatest && (
              <button
                onClick={() => {
                  try {
                    const ts = mainChartRef.current?.timeScale?.();
                    if (ts) {
                      ts.scrollToRealTime();
                      const data = chartDataRef.current?.candles;
                      if (data && data.length) {
                        const barsToShow = Math.min(120, data.length);
                        ts.setVisibleLogicalRange({ from: data.length - barsToShow, to: data.length + 2 });
                      }
                      // Bring the PRICE range back to the candles too — scrolling to
                      // the right edge alone can leave them off-screen vertically.
                      refitPriceScaleRef.current();
                    }
                  } catch (e) {}
                  setShowJumpToLatest(false);
                }}
                title="Scroll to the latest candle"
                className="absolute bottom-3 right-[60px] z-[55] h-9 w-9 rounded-full bg-primary/90 text-white shadow-lg flex items-center justify-center hover:bg-primary transition-colors animate-in fade-in duration-200"
              >
                <ChevronsRight size={18} />
              </button>
            )}
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

                <div className="mb-2 p-1.5 rounded bg-muted/50">
                  <div className="text-foreground/90 font-medium mb-1">Structure stop · on close</div>
                  <div className="flex items-center gap-1">
                    {([['', 'Off'], ['VWAP', 'VWAP'], ['OR', 'Op.Range']] as const).map(([val, lbl]) => (
                      <button
                        key={val || 'off'}
                        onClick={() => setSlStructureStop(val)}
                        className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors ${slStructureStop === val ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                      >{lbl}</button>
                    ))}
                  </div>
                  {slStructureStop && (
                    <div className="text-[9px] text-muted-foreground mt-1 leading-tight">
                      Auto-exits when a candle closes {slIsBullish ? 'below' : 'above'} {slStructureStop === 'VWAP' ? 'VWAP' : `the opening-range ${slIsBullish ? 'low' : 'high'}`}.
                    </div>
                  )}
                </div>

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
              if (showOiBars && !isOptionView && oiData && crosshairInfo) {
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
                <div className="border-t border-white/10 mt-0.5 pt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openStrikeChart('CE', clickMenu.price); }}
                    className="flex-1 text-xs bg-transparent hover:bg-primary/20 border border-primary/30 rounded px-2 py-1 text-primary font-semibold transition-colors cursor-pointer"
                    title="Open this strike's CALL chart in a new tab"
                  >
                    CE Chart
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openStrikeChart('PE', clickMenu.price); }}
                    className="flex-1 text-xs bg-transparent hover:bg-primary/20 border border-primary/30 rounded px-2 py-1 text-primary font-semibold transition-colors cursor-pointer"
                    title="Open this strike's PUT chart in a new tab"
                  >
                    PE Chart
                  </button>
                </div>
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
          {/* Divider between chart and RSI: visual border + drag to resize the RSI pane */}
          {showRsi && (
            <div
              onPointerDown={(e) => {
                const h = rsiPaneRef.current?.getBoundingClientRect().height || 140;
                rsiDragRef.current = { startY: e.clientY, startH: h };
                try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch (err) {}
              }}
              onPointerMove={(e) => {
                const d = rsiDragRef.current;
                if (!d) return;
                const nh = Math.round(Math.min(420, Math.max(70, d.startH + (d.startY - e.clientY))));
                setRsiPaneHeight(nh);
              }}
              onPointerUp={() => {
                if (!rsiDragRef.current) return;
                rsiDragRef.current = null;
                try { localStorage.setItem('rsiPaneHeight', String(rsiPaneHeightRef.current || '')); } catch (err) {}
              }}
              onPointerCancel={() => { rsiDragRef.current = null; }}
              className="w-full h-3 shrink-0 cursor-row-resize touch-none select-none bg-white/5 border-y border-white/10 flex items-center justify-center active:bg-white/15"
              title="Drag to resize the RSI pane"
            >
              <div className="w-10 h-1 rounded-full bg-white/25" />
            </div>
          )}

          {/* One-tap EXIT — its own full-width bar BELOW the chart, so it never
              covers a single candle and is an easy thumb target on mobile. */}
          {tradeTabInstr && slActivePos && !slActivePos.testMode && (
            <button
              disabled={exitBusy}
              onClick={async () => {
                if (exitBusy) return;
                setExitBusy(true);
                const sym = slActivePos.symbol;
                try {
                  const r = await fetch('/api/exit-position', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tradingsymbol: sym })
                  });
                  const d = await r.json().catch(() => ({ success: false }));
                  if (d.success || d.alreadyClosed) {
                    try {
                      const raw = localStorage.getItem('active_positions');
                      const list = raw ? JSON.parse(raw) : [];
                      localStorage.setItem('active_positions', JSON.stringify(list.filter((p: any) => p.symbol !== sym)));
                      window.dispatchEvent(new Event('active_positions_updated'));
                    } catch (e) {}
                    toast.success(`${sym} exit order placed`);
                  } else {
                    toast.error(`Exit failed: ${d.error || 'order rejected'} — position still OPEN, check Zerodha.`);
                  }
                } catch (e) {
                  toast.error('Exit failed: network error — position may still be OPEN, check Zerodha.');
                }
                setExitBusy(false);
              }}
              className={`w-full shrink-0 h-11 mt-1.5 rounded-lg text-sm font-mono font-bold tracking-widest transition-colors bg-red-500/15 text-red-400 border border-red-500/40 active:bg-red-500 active:text-white ${exitBusy ? 'opacity-50' : ''}`}>
              {exitBusy ? 'EXITING…' : `EXIT ${slActivePos.symbol}`}
            </button>
          )}
          {/* RSI Chart */}
          <div ref={rsiPaneRef} style={rsiPaneHeight ? { height: `${rsiPaneHeight}px` } : undefined} className={`relative w-full shrink-0 h-[140px] md:h-[200px] ${!showRsi ? 'hidden' : ''}`}>
            <div
              ref={rsiContainerRef}
              className="bg-card border border-0 rounded-none md:rounded-xl overflow-hidden w-full h-full absolute inset-0"
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

      {/* OPTION REALITY CHECK. A call can fall on a day the index rises, and the
          reasons are not visible anywhere on a price chart: the index never crossed
          the strike, a day of time value evaporated, and calm markets make hope
          cheaper. These are those numbers, stated plainly. */}
      {isOptionView && optionReality && (
        <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1 shrink-0">
          <span className={`text-[10px] font-mono font-bold px-2 py-1 rounded ${optionReality.inTheMoney ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
            {optionReality.inTheMoney
              ? `IN THE MONEY by ${Math.round(optionReality.intrinsic)}`
              : `NEEDS ${Math.round(Math.abs(optionReality.type === 'CE' ? optionReality.strike - optionReality.spot : optionReality.spot - optionReality.strike))} PTS TO REACH STRIKE`}
          </span>
          <span className="text-[10px] font-mono px-2 py-1 rounded bg-muted/50 text-muted-foreground">
            BREAK EVEN {Math.round(optionReality.breakeven)}
            <span className="text-foreground/80 font-bold"> · {optionReality.moveNeeded > 0 ? `${Math.round(optionReality.moveNeeded)} pts away` : 'passed'}</span>
          </span>
          {optionReality.thetaPerDayRupees != null && (
            <span className="text-[10px] font-mono px-2 py-1 rounded bg-rose-500/15 text-rose-300" title="What one lot loses per day from time alone, index unchanged">
              TIME COST ₹{Math.abs(optionReality.thetaPerDayRupees).toLocaleString('en-IN')}/day
              {optionReality.thetaPctPerDay ? ` (${optionReality.thetaPctPerDay}%)` : ''}
            </span>
          )}
          <span className="text-[10px] font-mono px-2 py-1 rounded bg-muted/50 text-muted-foreground">
            HOPE VALUE {optionReality.timeValuePct}%
            <span className="opacity-70"> · {optionReality.daysLeft < 1 ? 'expires today' : `${Math.floor(optionReality.daysLeft)}d left`}</span>
          </span>
          {optionReality.iv != null && (
            <span className="text-[10px] font-mono px-2 py-1 rounded bg-muted/50 text-muted-foreground">IV {optionReality.iv}%</span>
          )}
        </div>
      )}

      {/* Armed triggers — always visible while any exist. A pending instruction to
          buy or sell that the user cannot SEE is the thing most likely to surprise
          them later, so this is not tucked behind a menu. */}
      {armedTriggers.length > 0 && (
        <div className="fixed left-2 bottom-[calc(7.5rem+env(safe-area-inset-bottom))] md:bottom-4 z-40 flex flex-col gap-1.5">
          {armedTriggers.map((t: any) => (
            <div key={t.id} className="flex items-center gap-2 bg-amber-500/15 border border-amber-500/40 rounded-lg px-2.5 py-1.5">
              <span className="text-[10px] font-mono font-bold text-amber-300">
                {t.side} {prettyOptionName(t.tradingsymbol)} @ {Number(t.trigger_price).toFixed(2)}
                <span className="opacity-70"> · {t.direction === 'UP' ? 'on rise' : 'on fall'}</span>
              </span>
              <button
                onClick={async () => {
                  const r = await fetch(`/api/triggers/${t.id}`, { method: 'DELETE' }).then(x => x.json()).catch(() => null);
                  if (r?.ok) { toast.success('Trigger cancelled'); } else { toast.error(r?.error || 'Could not cancel'); }
                  refetchTriggers();
                }}
                className="text-[10px] font-bold text-amber-200 hover:text-white px-1.5 py-0.5 rounded bg-black/30"
              >
                CANCEL
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Trigger box — minimal by request: side, product, lots, margin, confirm. */}
      {triggerBox && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setTriggerBox(null)}>
          <div className="bg-card border border-border rounded-xl p-4 w-full max-w-[300px]" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-bold">{prettyOptionName(triggerBox.contract.tradingsymbol, triggerBox.contract.expiry)}</div>
            <div className="text-[11px] text-muted-foreground mb-3">
              now {triggerBox.current.toFixed(2)} · fires on a{' '}
              {triggerBox.level > triggerBox.current ? 'rise' : 'fall'} to{' '}
              <span className="text-foreground font-bold">{triggerBox.level.toFixed(2)}</span>
            </div>

            <div className="flex gap-1.5 mb-2">
              {(['BUY', 'SELL'] as const).map(sd => (
                <button key={sd} onClick={() => setTriggerBox({ ...triggerBox, side: sd })}
                  className={`flex-1 text-xs font-bold py-1.5 rounded-lg transition-colors ${triggerBox.side === sd ? (sd === 'BUY' ? 'bg-emerald-500/25 text-emerald-300' : 'bg-rose-500/25 text-rose-300') : 'bg-muted/40 text-muted-foreground'}`}>
                  {sd}
                </button>
              ))}
            </div>

            <div className="flex gap-1.5 mb-2">
              {(['MIS', 'NRML'] as const).map(pr => (
                <button key={pr} onClick={() => setTriggerBox({ ...triggerBox, product: pr })}
                  className={`flex-1 text-xs font-bold py-1.5 rounded-lg transition-colors ${triggerBox.product === pr ? 'bg-primary/25 text-primary' : 'bg-muted/40 text-muted-foreground'}`}>
                  {pr}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold text-muted-foreground">Lot Sizing</span>
              <div className="flex gap-1">
                {(['AUTO', 'MANUAL'] as const).map(md => (
                  <button key={md} onClick={() => setTriggerBox({ ...triggerBox, lotMode: md })}
                    className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${triggerBox.lotMode === md ? 'bg-primary/25 text-primary' : 'bg-muted/40 text-muted-foreground'}`}>
                    {md === 'AUTO' ? 'AUTO MAX' : 'MANUAL'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between bg-muted/40 rounded-lg px-2 py-1.5 mb-1.5">
              <button
                onClick={() => setTriggerBox({ ...triggerBox, lotMode: 'MANUAL', lots: Math.max(1, triggerBox.lots - 1) })}
                className="w-7 h-7 rounded bg-black/30 text-sm font-bold">−</button>
              <span className="text-xs font-mono">
                {triggerBox.lots} lot{triggerBox.lots > 1 ? 's' : ''}
                <span className="text-muted-foreground"> · {triggerBox.lots * (triggerBox.contract.lot_size || 0)} qty</span>
              </span>
              <button
                onClick={() => setTriggerBox({ ...triggerBox, lotMode: 'MANUAL', lots: triggerBox.lots + 1 })}
                className="w-7 h-7 rounded bg-black/30 text-sm font-bold">+</button>
            </div>

            <div className="flex gap-1.5 mb-2">
              {([
                { label: '1 LOT', lots: 1 },
                { label: 'HALF', lots: Math.max(1, Math.floor(maxLots / 2)) },
                { label: 'MAX', lots: Math.max(1, maxLots) },
              ] as const).map(b => (
                <button key={b.label}
                  disabled={b.label !== '1 LOT' && maxLots < 1}
                  onClick={() => setTriggerBox({ ...triggerBox, lotMode: 'MANUAL', lots: b.lots })}
                  className={`flex-1 text-[10px] font-bold py-1.5 rounded transition-colors disabled:opacity-40 ${triggerBox.lots === b.lots ? 'bg-primary/25 text-primary' : 'bg-muted/40 text-muted-foreground hover:text-foreground'}`}>
                  {b.label}
                </button>
              ))}
            </div>

            <div className="text-[11px] mb-3 px-1">
              Margin:{' '}
              {triggerMargin === 'loading' ? <span className="text-muted-foreground">checking…</span>
                : triggerMargin === 'unavailable' || !triggerMargin
                  ? <span className="text-amber-400">unavailable from Zerodha — arm only if you know the requirement</span>
                  : <span className="text-foreground font-bold font-mono">₹{Math.round(triggerMargin.total).toLocaleString('en-IN')}</span>}
            </div>

            <button onClick={armTrigger} disabled={armingTrigger}
              className={`w-full text-sm font-bold py-2.5 rounded-lg transition-colors disabled:opacity-50 ${triggerBox.side === 'BUY' ? 'bg-emerald-500/25 text-emerald-300 hover:bg-emerald-500/35' : 'bg-rose-500/25 text-rose-300 hover:bg-rose-500/35'}`}>
              {armingTrigger ? 'Arming…' : `Arm ${triggerBox.side} at ${triggerBox.level.toFixed(2)}`}
            </button>
            <button onClick={() => setTriggerBox(null)}
              className="w-full mt-2 text-xs py-2 rounded-lg bg-muted/40 text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Expiry picker — shown between tapping CE/PE Chart and the chart opening. */}
      {expiryPick && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setExpiryPick(null)}>
          <div className="bg-card border border-border rounded-xl p-4 w-full max-w-[280px]" onClick={(e) => e.stopPropagation()}>
            <div className="text-base font-bold mb-3">
              {expiryPick.under} {expiryPick.strike} {expiryPick.optionType}
            </div>
            <div className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto">
              {expiryPick.expiries.map((e) => (
                <button
                  key={e}
                  onClick={() => { const p = expiryPick; setExpiryPick(null); openStrikeChart(p.optionType, p.price, e); }}
                  className="text-left text-sm font-mono px-3 py-2 rounded-lg bg-muted/40 hover:bg-primary/20 hover:text-primary transition-colors"
                >
                  {e}
                </button>
              ))}
            </div>
            <button onClick={() => setExpiryPick(null)}
              className="w-full mt-3 text-xs py-2 rounded-lg bg-muted/40 text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
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


