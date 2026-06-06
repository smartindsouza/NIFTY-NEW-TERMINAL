import React, { useMemo, useRef, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X, Plus, ChevronDown, Check, Eye, Settings } from "lucide-react";
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
import { computeMasterSignal } from "../../lib/decisionEngine";

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
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>(ticket.orderType);
  const [lots, setLots] = useState<number>(() => {
    if (!ticket.lotSize || ticket.lotSize <= 0) return 0;
    return Math.max(1, Math.round(ticket.quantity / ticket.lotSize));
  });
  const [limitPrice, setLimitPrice] = useState<string>(String(ticket.limitPrice));

  const [showChargesBreakdown, setShowChargesBreakdown] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const isBuy = ticket.action === 'BUY';
  const lotSize = ticket.lotSize;
  const quantity = lotSize ? (lots * lotSize) : 0;
  const missingContext = !ticket.instrument_token || !ticket.tradingsymbol;

  const currentPrice = orderType === 'LIMIT' ? (parseFloat(limitPrice) || 0) : ticket.ltp;
  
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

  if (lots > 0) {
    if (isKite) {
      costPerLot = (reqAmount / lots) + (charges / lots);
      calculationSource = 'Kite Margin API';
    } else if (isLocalFallback) {
      costPerLot = (reqAmount / lots) + (charges / lots);
      calculationSource = 'Local Estimate';
    }
  }

  if (costPerLot > 0) {
    maxAffordableLots = Math.floor(availBalance / costPerLot);
  }

  const [oscillationGuard, setOscillationGuard] = useState<{prev: number, curr: number}>({prev: 0, curr: 0});
  
  useEffect(() => {
    if (lotSizingMode !== 'AUTO MAX') return;
    if (costPerLot <= 0) return;
    
    let targetLots = maxAffordableLots >= 1 ? maxAffordableLots : 1;
    
    if (lots !== targetLots) {
       if (oscillationGuard.prev === targetLots && oscillationGuard.curr === lots) {
          targetLots = Math.min(oscillationGuard.prev, oscillationGuard.curr);
          if (lots === targetLots) return;
       }
       setOscillationGuard({prev: oscillationGuard.curr, curr: targetLots});
       setLots(targetLots);
    }
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
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 backdrop-blur-[2px] p-4 text-slate-200">
      <div className="bg-[#1e222d] border border-slate-700/80 rounded-xl shadow-2xl w-full max-w-[420px] overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* Header with buy/sell color */}
        <div className={`p-4 flex items-center justify-between border-b border-slate-805/70 ${isBuy ? 'bg-emerald-950/40 text-emerald-400' : 'bg-rose-950/30 text-rose-400'}`}>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded tracking-wide ${isBuy ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
              {ticket.action}
            </span>
            <span className="font-semibold text-sm tracking-wider">
              {ticket.tradingsymbol}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-white">
          
          {/* Main option contract metadata visualizer */}
          <div className="grid grid-cols-2 gap-3 bg-slate-900/50 border border-slate-800 p-3 rounded-lg text-xs">
            <div>
              <span className="text-slate-500 block mb-1">Underlying</span>
              <span className="text-slate-300 font-medium">{ticket.underlying}</span>
            </div>
            <div className="bg-amber-500/15 border-2 border-amber-500/50 p-2 rounded-lg flex flex-col justify-between shadow-[0_0_12px_rgba(245,158,11,0.2)] animate-pulse-subtle">
              <span className="text-amber-400 font-bold text-[10px] uppercase tracking-wider block mb-1">⚠️ Expiry Date</span>
              <select
                value={ticket.expiry}
                onChange={(e) => onExpiryChange(e.target.value)}
                className="w-full bg-[#2a2e3d] border border-amber-400 rounded px-3 py-1.5 text-xs text-yellow-300 font-bold focus:outline-none focus:border-amber-300 focus:ring-1 focus:ring-amber-300 cursor-pointer"
              >
                {expiries.map((exp) => (
                  <option key={exp} value={exp} className="bg-[#1e222d] text-white">
                    {exp}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="text-slate-500 block">Strike / Option</span>
              <span className="text-slate-300 font-medium">{ticket.strike} {ticket.optionType}</span>
            </div>
            <div>
              <span className="text-slate-500 block">LTP</span>
              <span className="text-cyan-400 font-bold">₹{ticket.ltp.toFixed(2)}</span>
            </div>
            <div className="col-span-2 border-t border-slate-800/65 pt-2 mt-1 flex justify-between">
              <div>
                <span className="text-[10px] text-slate-500 block">Token</span>
                <span className="text-[10px] text-slate-400 font-mono">{ticket.instrument_token || "N/A"}</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 block text-right">Lot Size</span>
                <span className="text-[10px] text-slate-400 block text-right font-mono font-semibold">
                  {lotSize != null ? lotSize : "Unavailable"}
                </span>
              </div>
            </div>
          </div>

          {/* Option Contract Diagnostics Box */}
          <div className="bg-slate-950/45 border border-slate-800/60 rounded-lg p-2.5 text-[11px] font-sans">
            <button 
              type="button"
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className="w-full flex justify-between items-center text-cyan-400/90 font-semibold pb-1 border-b border-slate-800/40 hover:text-cyan-300 transition-colors"
            >
              <span>📋 Instrument Master Diagnostics</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] bg-cyan-950 text-cyan-400 px-1.5 py-0.5 rounded font-mono">
                  {ticket.exchange || 'NFO'}
                </span>
                <span className="text-[9px] text-cyan-500/80 hover:text-cyan-300 font-sans ml-1">
                  ({showDiagnostics ? 'hide' : 'show'})
                </span>
              </div>
            </button>
            
            {showDiagnostics && (
              <div className="space-y-1 text-slate-400 font-sans leading-normal mt-1.5 animate-in fade-in slide-in-from-top-1">
                <div className="flex justify-between">
                  <span>Trading Symbol:</span>
                  <span className="text-slate-200 font-mono font-medium">{ticket.tradingsymbol || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span>Instrument Token:</span>
                  <span className="text-slate-200 font-mono">{ticket.instrument_token || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span>Segment:</span>
                  <span className="text-slate-200">{ticket.segment || 'NFO-OPT'}</span>
                </div>
                <div className="flex justify-between">
                  <span>Expiry Date:</span>
                  <span className="text-slate-200 font-mono">{ticket.expiry}</span>
                </div>
                <div className="flex justify-between">
                  <span>Strike Price:</span>
                  <span className="text-slate-200 font-mono">{ticket.strike}</span>
                </div>
                <div className="flex justify-between">
                  <span>Option Type:</span>
                  <span className={`font-mono font-bold ${ticket.optionType === 'CE' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {ticket.optionType}
                  </span>
                </div>
                <div className="flex justify-between border-t border-slate-800/40 pt-1.5 mt-1 pb-0.5">
                  <span className="font-semibold text-slate-300">Lot Size from Kite Master:</span>
                  <span className="font-mono text-cyan-400 font-bold">
                    {lotSize != null ? lotSize : (
                      <span className="text-rose-400 animate-pulse font-sans font-medium text-[10px]">
                        Unavailable
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[10px] text-slate-500">Source:</span>
                  <span className="text-[10px] text-cyan-500/80 italic font-medium">
                    {ticket.source_of_lot_size || 'Kite Live Instrument Master'}
                  </span>
                </div>

                <div className="text-[10px] font-semibold text-cyan-400/80 mb-1 border-b border-slate-800/40 pb-0.5 mt-2 pt-1 uppercase tracking-widest">
                   Auto Lot Diagnostics
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Lot Sizing Mode:</span>
                  <span className={`font-mono font-medium ${lotSizingMode === 'AUTO MAX' ? 'text-amber-400' : 'text-slate-300'}`}>{lotSizingMode}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Cost Per Lot:</span>
                  <span className="font-mono text-emerald-400">{costPerLot > 0 ? `₹${costPerLot.toFixed(2)}` : 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Max Affordable Lots:</span>
                  <span className="font-mono text-cyan-400">{maxAffordableLots > 0 ? maxAffordableLots : '0'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Selected Lots:</span>
                  <span className="font-mono text-indigo-300">{lots}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Auto Lot Calculation Source:</span>
                  <span className="font-mono text-[9px] text-cyan-500/80">{calculationSource}</span>
                </div>
              </div>
            )}
          </div>

          {/* Missing Lot Size Alert Box */}
          {!lotSize && (
            <div className="bg-rose-950/30 border border-rose-500/35 p-3 rounded-lg text-xs flex flex-col gap-1.5 mt-2 shadow-[0_0_12px_rgba(239,68,68,0.15)] animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="flex items-center gap-1.5 text-rose-450 text-rose-400 font-semibold">
                <span>⚠️ Lot size unavailable. Refresh instruments.</span>
              </div>
              <div className="text-slate-400 text-[11px] leading-relaxed">
                NIFTY options require a dynamic lot size from the latest instrument master. Click below to refresh the cached database.
              </div>
              <button
                type="button"
                onClick={handleRefreshInstruments}
                className={`text-[10px] uppercase font-bold self-start mt-1 cursor-pointer underline transition-all ${refreshing ? 'text-slate-500' : 'text-cyan-400 hover:text-cyan-305 hover:text-cyan-300'}`}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing Master Cache...' : 'Click to Refetch & Rebuild Master'}
              </button>
            </div>
          )}

          {/* Product Type (MIS vs NRML) */}
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1.5">Product</label>
            <div className="grid grid-cols-2 gap-2 bg-slate-900/40 p-1 rounded-lg border border-slate-800">
              <button
                type="button"
                onClick={() => setProduct('MIS')}
                className={`py-1.5 text-xs font-semibold rounded-md transition-all ${product === 'MIS' ? 'bg-[#292e3d] text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}
              >
                Intraday (MIS)
              </button>
              <button
                type="button"
                onClick={() => setProduct('NRML')}
                className={`py-1.5 text-xs font-semibold rounded-md transition-all ${product === 'NRML' ? 'bg-[#292e3d] text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}
              >
                Overnight (NRML)
              </button>
            </div>
          </div>

          {/* Order Type (MARKET vs LIMIT) */}
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1.5">Order Type</label>
            <div className="grid grid-cols-2 gap-2 bg-slate-900/40 p-1 rounded-lg border border-slate-800">
              <button
                type="button"
                onClick={() => setOrderType('MARKET')}
                className={`py-1.5 text-xs font-semibold rounded-md transition-all ${orderType === 'MARKET' ? 'bg-[#292e3d] text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}
              >
                Market
              </button>
              <button
                type="button"
                onClick={() => setOrderType('LIMIT')}
                className={`py-1.5 text-xs font-semibold rounded-md transition-all ${orderType === 'LIMIT' ? 'bg-[#292e3d] text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-white'}`}
              >
                Limit
              </button>
            </div>
          </div>

          {/* Dynamic input blocks based on selection */}
          <div className="flex flex-col gap-4">
             {/* Lot Sizing */}
             <div className="bg-slate-900/60 p-2.5 rounded-lg border border-slate-800">
                <div className="flex justify-between items-center mb-2">
                   <label className="text-xs font-semibold text-slate-300">Lot Sizing</label>
                   <div className="flex gap-1 bg-slate-950 p-0.5 rounded border border-slate-800 text-[10px]">
                      <button type="button" onClick={() => setLotSizingMode('AUTO MAX')} className={`px-2 py-0.5 rounded font-bold transition-colors ${lotSizingMode === 'AUTO MAX' ? 'bg-cyan-900/50 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}>AUTO MAX</button>
                      <button type="button" onClick={() => setLotSizingMode('MANUAL')} className={`px-2 py-0.5 rounded font-bold transition-colors ${lotSizingMode === 'MANUAL' ? 'bg-slate-800 text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}>MANUAL</button>
                   </div>
                </div>

                {lotSizingMode === 'AUTO MAX' && !isKite && !marginPreview.loading && (
                   <div className="mb-2 text-[10px] text-rose-400 font-semibold bg-rose-950/30 py-1 px-2 rounded border border-rose-900/50">
                     Auto lot sizing unavailable (Kite API failed)
                   </div>
                )}
                
                <div className="flex items-center gap-3">
                   <div className="flex items-center">
                     <button type="button" onClick={() => { setLotSizingMode('MANUAL'); adjustLots(-1); }} className="bg-slate-850 hover:bg-slate-755 text-slate-300 border border-slate-700 w-8 h-9 rounded-l focus:outline-none flex items-center justify-center font-bold" disabled={lotSizingMode === 'AUTO MAX' && isKite}>-</button>
                     <input type="number" value={lots || ''} onChange={(e) => { setLotSizingMode('MANUAL'); handleLotsChange(e.target.value); }} disabled={lotSizingMode === 'AUTO MAX' && isKite} className={`w-14 text-center bg-slate-900/40 border-y border-slate-750 font-mono text-sm h-9 focus:outline-none focus:border-cyan-500 ${lotSizingMode === 'AUTO MAX' && isKite ? 'text-cyan-400 cursor-not-allowed' : 'text-white'}`} />
                     <button type="button" onClick={() => { setLotSizingMode('MANUAL'); adjustLots(1); }} className="bg-slate-850 hover:bg-slate-755 text-slate-300 border border-slate-700 w-8 h-9 rounded-r focus:outline-none flex items-center justify-center font-bold" disabled={lotSizingMode === 'AUTO MAX' && isKite}>+</button>
                   </div>
                   
                   <div className="flex flex-1 justify-end gap-1.5 h-9">
                      <button type="button" onClick={() => { setLotSizingMode('MANUAL'); setLots(1); }} className={`px-2 rounded border text-[10px] uppercase font-bold tracking-wider transition-colors hover:bg-slate-700 hover:text-cyan-300 ${lotSizingMode === 'MANUAL' && lots === 1 ? 'bg-cyan-900/50 border-cyan-700/50 text-cyan-400' : 'bg-slate-800/80 border-slate-700/60 text-slate-400'}`}>1 Lot</button>
                      <button type="button" onClick={() => { setLotSizingMode('MANUAL'); setLots(Math.max(1, Math.floor(maxAffordableLots / 2))); }} className={`px-2 rounded border text-[10px] uppercase font-bold tracking-wider transition-colors hover:bg-slate-700 hover:text-cyan-300 ${lotSizingMode === 'MANUAL' && lots === Math.max(1, Math.floor(maxAffordableLots / 2)) && maxAffordableLots > 2 ? 'bg-cyan-900/50 border-cyan-700/50 text-cyan-400' : 'bg-slate-800/80 border-slate-700/60 text-slate-400'}`} disabled={maxAffordableLots <= 0}>Half</button>
                      <button type="button" onClick={() => { setLotSizingMode('AUTO MAX'); }} className={`px-2 rounded border text-[10px] uppercase font-bold tracking-wider transition-colors hover:bg-slate-700 hover:text-cyan-300 ${lotSizingMode === 'AUTO MAX' ? 'bg-cyan-900/50 border-cyan-700/50 text-cyan-400' : 'bg-slate-800/80 border-slate-700/60 text-slate-400'}`}>Max</button>
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-2.5 pt-2 border-t border-slate-800/60 text-[10px]">
                   <div className="flex justify-between">
                     <span className="text-slate-500">Total Qty:</span>
                     <span className="font-mono text-slate-300">{quantity} <span className="text-slate-600 text-[9px]">(x{lotSize})</span></span>
                   </div>
                   <div className="flex justify-between items-center">
                     <span className="text-slate-500">Cost/Lot:</span>
                     <span className="font-mono text-emerald-400/90 flex items-center gap-1">
                        {costPerLot > 0 ? `₹${costPerLot.toFixed(1)}` : '...' }
                        {!isKite && costPerLot > 0 && <span className="text-amber-500/80 text-[8px]" title="Estimated">*Est</span>}
                     </span>
                   </div>
                   <div className="flex justify-between items-center">
                     <span className="text-slate-500">Max Afford:</span>
                     <span className="font-mono text-cyan-400 flex items-center gap-1">
                        {maxAffordableLots > 0 ? maxAffordableLots : 0} lots
                        {!isKite && maxAffordableLots > 0 && <span className="text-amber-500/80 text-[8px]" title="Estimated">*Est</span>}
                     </span>
                   </div>
                   <div className="flex justify-between">
                     <span className="text-slate-500">Avail margin:</span>
                     <span className="font-mono text-emerald-400/90">₹{availBalance.toFixed(0)}</span>
                   </div>
                </div>
             </div>
             
             {/* Price input when LIMIT type */}
            <div>
              <label className="text-xs font-medium text-slate-400 block mb-1">Price</label>
              <input
                type="number"
                step="0.05"
                disabled={orderType === 'MARKET'}
                value={orderType === 'MARKET' ? ticket.ltp.toFixed(2) : limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                className={`w-full bg-slate-900/60 border border-slate-705 rounded-md text-center text-xs h-9 focus:outline-none focus:border-cyan-500 font-mono ${orderType === 'MARKET' ? 'text-slate-500 cursor-not-allowed bg-slate-950/20' : 'text-white'}`}
              />
              <span className="text-[10px] text-slate-500 block mt-1">Tick size ₹0.05</span>
            </div>
          </div>

          {/* Required vs Available details */}
          <div className="bg-slate-900 border border-slate-700/60 p-3 rounded-lg shadow-inner text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-slate-400 font-medium tracking-wide font-sans">Required Margin:</span>
                <span className="text-white font-bold font-mono text-[13px]">
                  ₹{Math.round(reqAmount).toLocaleString('en-IN')}
                </span>
                <button
                  type="button"
                  onClick={() => setShowChargesBreakdown(!showChargesBreakdown)}
                  className="text-slate-500 font-mono text-xs hover:text-cyan-400 focus:outline-none transition-colors inline-flex items-center gap-0.5 cursor-pointer"
                  title="Click to view Zerodha charges breakdown"
                >
                  + ₹{charges.toFixed(2)}
                  <span className={`text-[9px] px-1 py-0.5 rounded ml-1 font-bold font-sans uppercase ${isKite ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                    {isKite ? 'Kite API' : 'Local Calculation'}
                  </span>
                  <span className="text-[9px] text-cyan-400/80 hover:underline font-sans font-normal ml-1">
                    ({showChargesBreakdown ? 'hide' : 'details'})
                  </span>
                </button>
              </div>
              
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-slate-400 font-medium font-sans">Available Margin:</span>
                <span className={`font-mono font-bold px-2 py-0.5 rounded flex items-center transition-all ${
                  (reqAmount + charges) > availBalance 
                    ? 'text-rose-400 bg-rose-950/45 border border-rose-500/30 shadow-[0_0_8px_rgba(239,68,68,0.15)] animate-pulse' 
                    : 'text-emerald-400 bg-emerald-950/25 border border-emerald-500/20'
                }`}>
                  ₹{availBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  <button
                    type="button"
                    onClick={() => {
                      onRefreshBalance();
                      toast.success("Refreshing Kite account balance...");
                    }}
                    className="text-[10px] text-cyan-400 hover:text-cyan-300 ml-2 cursor-pointer font-sans font-normal"
                    title="Refresh Balance"
                  >
                    <Loader2 className={`w-3.5 h-3.5 ${processing ? 'animate-spin' : ''}`} />
                  </button>
                </span>
              </div>
            </div>

            {showChargesBreakdown && (
              <div className="mt-3 pt-2.5 border-t border-slate-800/80 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] text-slate-400 font-sans leading-relaxed animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="text-slate-500 font-medium col-span-2 text-[11px] text-cyan-400 flex justify-between items-center pb-1 border-b border-slate-800/40 mb-1">
                  <span className="font-semibold flex items-center gap-2">
                    Charges Breakdown
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase ${isKite ? 'bg-emerald-500/20 text-emerald-400' : isLocalFallback ? 'bg-amber-500/20 text-amber-400' : 'bg-rose-500/20 text-rose-400'}`}>
                      {isKite ? 'Kite Margin API' : isLocalFallback ? 'Local Estimate' : 'Margin Unavailable'}
                    </span>
                  </span>
                  <span className="text-[10px] text-slate-500 italic">NSE F&O Options</span>
                </div>
                
                {isLocalFallback && (
                  <div className="col-span-2 text-amber-500/90 text-[10px] leading-relaxed bg-amber-500/10 border border-amber-500/20 px-2 py-1.5 rounded-md mb-1.5">
                    <strong>⚠️ Fallback Active:</strong> Charges are estimated and may differ from Zerodha.
                  </div>
                )}
                
                {marginPreview.loading ? (
                  <div className="col-span-2 text-center text-slate-400 py-3 flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-cyan-500" />
                    Fetching live charges from Kite...
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between border-b border-slate-800/20 pb-1">
                      <span>Brokerage:</span>
                      <span className="font-mono text-slate-300">₹{(isKite ? marginPreview.data!.charges.brokerage : estimatedChargesDetails.brokerage).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/20 pb-1">
                      <span>Exchange Turnover Fee:</span>
                      <span className="font-mono text-slate-300">₹{(isKite ? marginPreview.data!.charges.exchange_turnover_charge : estimatedChargesDetails.txnCharge).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/20 pb-1">
                      <span>GST:</span>
                      <span className="font-mono text-slate-300">₹{(isKite ? marginPreview.data!.charges.gst.total : estimatedChargesDetails.gst).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/20 pb-1">
                      <span>Stamp Duty:</span>
                      <span className="font-mono text-slate-300">₹{(isKite ? marginPreview.data!.charges.stamp_duty : estimatedChargesDetails.stamp).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/20 pb-1">
                      <span>STT:</span>
                      <span className="font-mono text-slate-300">₹{(isKite ? marginPreview.data!.charges.transaction_tax : estimatedChargesDetails.stt).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-800/20 pb-1">
                      <span>SEBI Charges:</span>
                      <span className="font-mono text-slate-300">₹{(isKite ? marginPreview.data!.charges.sebi_turnover_charge : estimatedChargesDetails.sebi).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b-2 border-slate-700/60 pb-1 font-bold pt-1">
                      <span className="text-cyan-400">Total Charges:</span>
                      <span className="font-mono text-cyan-400">₹{(isKite ? marginPreview.data!.charges.total : estimatedChargesDetails.total).toFixed(2)}</span>
                    </div>
                    <div className="col-span-2 text-[10px] text-slate-500 leading-normal italic mt-0.5 pt-0.5">
                      {isKite 
                        ? "* Sourced from Zerodha Kite Margin API." 
                        : `* Local estimate calculated dynamically. ${marginPreview.error ? 'Kite Error: ' + marginPreview.error : ''}`}
                    </div>
                  </>
                )}
              </div>
            )}

            {(reqAmount + charges) > availBalance && (
              <div className="mt-2.5 pt-2 border-t border-rose-500/20 flex flex-col gap-1 text-[11px]">
                <div className="flex items-center gap-1.5 text-rose-400 font-semibold">
                  <span>⚠️ Insufficient Funds for this transaction</span>
                </div>
                <div className="text-slate-400 font-medium">
                  Shortfall: <span className="font-mono text-rose-350 font-bold">₹{((reqAmount + charges) - availBalance).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="text-[10px] text-slate-500 leading-relaxed italic">
                  Tip: You can edit and increase the simulated "Available" balance above to test successfully.
                </div>
              </div>
            )}
          </div>

          {/* Warning banner when instrument context is incomplete */}
          {missingContext && (
            <div className="bg-amber-950/25 border border-amber-900/80 text-amber-500 p-2.5 rounded-lg text-[10px] leading-relaxed">
              <strong>Warning:</strong> Trading symbol or instrument token is missing. Real-time index feed is fallback or simulated. Order placement is restricted to simulated confirmation.
            </div>
          )}

          {/* Actions panel */}
          <div className="pt-3 border-t border-slate-800 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-1.5 text-xs font-semibold rounded bg-slate-800 hover:bg-slate-750 text-slate-300 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={processing || lots <= 0 || (reqAmount + charges) > availBalance}
              className={`flex-1 py-1.5 text-xs font-bold rounded text-white transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer ${isBuy ? 'bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900/10 disabled:text-emerald-500/40' : 'bg-rose-600 hover:bg-rose-500 disabled:bg-rose-900/10 disabled:text-rose-500/40'}`}
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
        className="flex items-center justify-center border border-white/20 rounded p-1.5 cursor-pointer bg-transparent hover:bg-white/5 transition-colors h-8 w-14"
      >
        <div className="w-5 h-5 rounded-sm shadow-sm" style={{ backgroundColor: color }} />
      </button>

      {/* Popover */}
      {isOpen && (
        <div 
          className="absolute left-0 top-10 w-[240px] bg-[#1a1e27] border border-white/10 rounded-lg shadow-2xl z-[1000] p-4 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-100"
          onClick={e => e.stopPropagation()}
        >
          {/* Top line preview (like screenshot) */}
          <div className="flex items-center gap-3 border border-[#2a2e39] bg-[#222631] rounded p-2">
            <div className="w-6 h-6 rounded shadow-sm" style={{ backgroundColor: color }} />
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
                onClick={() => onColorChange(c)}
                className={`w-5 h-5 rounded-sm cursor-pointer border hover:scale-110 transition-transform ${color.toLowerCase() === c.toLowerCase() ? 'border-white' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="w-full h-px bg-white/10 my-1" />

          {/* Custom + Button (Placeholder like screenshot) */}
          <div>
            <button className="text-white/70 hover:text-white transition-colors flex items-center justify-center p-1 border border-transparent hover:border-white/20 rounded">
              <Plus className="w-5 h-5" />
            </button>
          </div>

          {/* Opacity */}
          {onOpacityChange && opacity !== undefined && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-white/50 font-medium">Opacity</div>
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
                <div className="text-xs text-white/80 w-8 border border-white/10 bg-[#222631] rounded px-1 py-0.5 text-center">{opacity}%</div>
              </div>
            </div>
          )}

          {/* Thickness */}
          {onThicknessChange && thickness !== undefined && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-white/50 font-medium">Thickness</div>
              <div className="flex border border-white/20 rounded overflow-hidden h-8">
                {[1, 2, 3, 4].map((lw) => (
                  <button 
                    key={`lw-${lw}`}
                    onClick={() => onThicknessChange(lw)}
                    className={`flex-[1] flex items-center justify-center border-r border-white/20 last:border-r-0 hover:bg-white/10 transition-colors ${thickness === lw ? 'bg-[#2a2e39]' : 'bg-transparent'}`}
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
              <div className="text-[11px] text-white/50 font-medium">Line style</div>
              <div className="flex border border-white/20 rounded overflow-hidden h-8">
                {[
                  { val: 0, style: 'solid' },
                  { val: 1, style: 'dashed' },
                  { val: 2, style: 'dotted' }
                ].map((ls) => (
                  <button 
                    key={`ls-${ls.val}`}
                    onClick={() => onLineStyleChange(ls.val)}
                    className={`flex-[1] flex items-center justify-center border-r border-white/20 last:border-r-0 hover:bg-white/10 transition-colors ${lineStyle === ls.val ? 'bg-[#2a2e39]' : 'bg-transparent'}`}
                  >
                    <div className="w-5 border-t-[1.5px]" style={{ borderColor: '#fff', borderTopStyle: ls.style as any }} />
                  </button>
                ))}
              </div>
            </div>
          )}

        </div>
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
  onApply: (price: number, color: string, lineWidth: number, lineStyle: number, labelVisible: boolean) => void,
  onDelete: () => void,
  onChange?: (price: number, color: string, lineWidth: number, lineStyle: number, labelVisible: boolean) => void
}) {
  const [tab, setTab] = useState<'style' | 'coordinates'>('style');
  const [price, setPrice] = useState(Math.round(initialPrice));
  const [color, setColor] = useState(initialColor);
  const [lineWidth, setLineWidth] = useState(initialLineWidth);
  const [lineStyle, setLineStyle] = useState(initialLineStyle);
  const [labelVisible, setLabelVisible] = useState(initialLabelVisible);

  const isFirstRender = useRef(true);
  
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (onChange) {
      onChange(price, color, lineWidth, lineStyle, labelVisible);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, color, lineWidth, lineStyle, labelVisible]);

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
      <div className="bg-[#1e222d] border border-border rounded-lg shadow-xl w-full max-w-[400px] overflow-visible flex flex-col animate-in zoom-in-95 duration-200 relative">
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-white">Horizontal line</h2>
            <div className="w-3 h-3 text-muted-foreground ml-1">
               <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="flex px-4 border-b border-white/10 mt-2 gap-4">
          <button 
            onClick={() => setTab('style')}
            className={`pb-2 text-sm font-medium transition-colors ${tab === 'style' ? 'text-white border-b-2 border-white' : 'text-muted-foreground hover:text-white'}`}
          >
            Style
          </button>
          <button 
            onClick={() => setTab('coordinates')}
            className={`pb-2 text-sm font-medium transition-colors ${tab === 'coordinates' ? 'text-white border-b-2 border-white' : 'text-muted-foreground hover:text-white'}`}
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
              
              <label className="flex items-center gap-2 mt-4 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={labelVisible} 
                  onChange={e => setLabelVisible(e.target.checked)}
                  className="rounded border-white/20 bg-black/20 text-blue-500 focus:ring-0"
                />
                <span className="text-sm text-full text-foreground hover:text-white">Price label</span>
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
                className="bg-[#2a2e39] text-sm text-white px-3 py-1.5 rounded border border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500 w-[120px]"
                step="1"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-white/10 bg-[#151822]">
           <div>
             {/* Left section, currently blank in screenshot except for Template dropdown, using simple Delete for now */}
             <button onClick={onDelete} className="text-sm text-red-500 hover:text-red-400 transition-colors">Delete</button>
           </div>
           <div className="flex gap-2">
             <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-white/20 hover:bg-white/5 rounded text-white transition-colors">Cancel</button>
             <button onClick={() => onApply(price, color, lineWidth, lineStyle, labelVisible)} className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium">Ok</button>
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
  const ist = getIstDateTime(unixSeconds);
  if (ist.dayOfWeek === 0 || ist.dayOfWeek === 6) {
    return false; // Weekend
  }
  return ist.timeOfDaySec >= MARKET_OPEN_SECONDS_IST && ist.timeOfDaySec < MARKET_CLOSE_SECONDS_IST;
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-[#1e222d] border border-border rounded-lg shadow-xl w-full max-w-[320px] overflow-visible flex flex-col pt-1 relative"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-white">Bollinger Bands Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-slate-300">Period length:</span>
            <input
              type="number"
              value={period}
              min={2}
              max={100}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 2 && val <= 100) setPeriod(val);
              }}
              className="w-16 bg-slate-950 border border-slate-700/50 rounded px-2.5 py-1 text-white text-right focus:outline-none focus:border-cyan-500 text-sm"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-slate-300">Std Dev:</span>
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
              className="w-16 bg-slate-950 border border-slate-700/50 rounded px-2.5 py-1 text-white text-right focus:outline-none focus:border-cyan-500 text-sm"
            />
          </div>

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-slate-300">Bands Color</div>
             <TVStylePicker 
               color={color}
               onColorChange={setColor}
             />
          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-white/10 bg-[#151822] gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-white/20 hover:bg-white/5 rounded text-white transition-colors">Cancel</button>
          <button onClick={() => onApply(period, stdDev, color)} className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium">Ok</button>
        </div>
      </div>
    </div>
  );
}

function OiBarsEditorModal({
  onClose,
  initialMaxBarWidth,
  initialCallColor,
  initialPutColor,
  onApply
}: {
  onClose: () => void,
  initialMaxBarWidth: number,
  initialCallColor: string,
  initialPutColor: string,
  onApply: (maxBarWidth: number, callColor: string, putColor: string) => void
}) {
  const [maxBarWidth, setMaxBarWidth] = useState(initialMaxBarWidth);
  const [callColor, setCallColor] = useState(initialCallColor);
  const [putColor, setPutColor] = useState(initialPutColor);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-[#1e222d] border border-border rounded-lg shadow-xl w-full max-w-[320px] overflow-visible flex flex-col pt-1 relative"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-white">OI Bars Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-6">
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Max Bar Width</span>
              <span className="font-mono text-white">{maxBarWidth}px</span>
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

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-slate-300">Call OI Color (CE)</div>
             <TVStylePicker 
               color={callColor}
               onColorChange={setCallColor}
             />
          </div>

          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-slate-300">Put OI Color (PE)</div>
             <TVStylePicker 
               color={putColor}
               onColorChange={setPutColor}
             />
          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-white/10 bg-[#151822] gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-white/20 hover:bg-white/5 rounded text-white transition-colors">Cancel</button>
          <button onClick={() => onApply(maxBarWidth, callColor, putColor)} className="px-4 py-1.5 text-sm bg-white text-black hover:bg-gray-200 rounded transition-colors font-medium">Ok</button>
        </div>
      </div>
    </div>
  );
}

function RsiEditorModal({
  onClose,
  initialColor,
  initialOverbought,
  initialOverbought2,
  initialOversold,
  initialOversold2,
  initialSmaColor,
  initialOverboughtColor,
  initialOversoldColor,
  onApply
}: {
  onClose: () => void,
  initialColor: string,
  initialOverbought: number,
  initialOverbought2: number,
  initialOversold: number,
  initialOversold2: number,
  initialSmaColor: string,
  initialOverboughtColor: string,
  initialOversoldColor: string,
  onApply: (
    color: string,
    overbought: number,
    overbought2: number,
    oversold: number,
    oversold2: number,
    smaColor: string,
    overboughtColor: string,
    oversoldColor: string
  ) => void
}) {
  const [color, setColor] = useState(initialColor);
  const [overbought, setOverbought] = useState(initialOverbought);
  const [overbought2, setOverbought2] = useState(initialOverbought2);
  const [oversold, setOversold] = useState(initialOversold);
  const [oversold2, setOversold2] = useState(initialOversold2);
  const [smaColor, setSmaColor] = useState(initialSmaColor);
  const [overboughtColor, setOverboughtColor] = useState(initialOverboughtColor);
  const [oversoldColor, setOversoldColor] = useState(initialOversoldColor);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-[#1e222d] border border-border rounded-lg shadow-xl w-full max-w-[420px] overflow-visible flex flex-col pt-1 relative text-white"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-white">RSI Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Overbought Levels */}
          <div className="space-y-2">
            <div className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Overbought Levels</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">Level 1 (Inner):</span>
                <input
                  type="number"
                  value={overbought}
                  min={50}
                  max={95}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 50 && val <= 95) setOverbought(val);
                  }}
                  className="w-full bg-slate-950 border border-slate-700/50 rounded px-2.5 py-1.5 text-white text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">Level 2 (Outer):</span>
                <input
                  type="number"
                  value={overbought2}
                  min={50}
                  max={99}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 50 && val <= 99) setOverbought2(val);
                  }}
                  className="w-full bg-slate-950 border border-slate-700/50 rounded px-2.5 py-1.5 text-white text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Oversold Levels */}
          <div className="space-y-2">
            <div className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Oversold Levels</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">Level 1 (Inner):</span>
                <input
                  type="number"
                  value={oversold}
                  min={5}
                  max={50}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 5 && val <= 50) setOversold(val);
                  }}
                  className="w-full bg-slate-950 border border-slate-700/50 rounded px-2.5 py-1.5 text-white text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">Level 2 (Outer):</span>
                <input
                  type="number"
                  value={oversold2}
                  min={1}
                  max={50}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 1 && val <= 50) setOversold2(val);
                  }}
                  className="w-full bg-slate-950 border border-slate-700/50 rounded px-2.5 py-1.5 text-white text-right focus:outline-none focus:border-cyan-500 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Line Colors */}
          <div className="space-y-4 pt-4 border-t border-white/10">
            
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-300">RSI Line</span>
              <TVStylePicker 
                color={color}
                onColorChange={setColor}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-300">SMA Line</span>
              <TVStylePicker 
                color={smaColor}
                onColorChange={setSmaColor}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-300">Overbought Level</span>
              <TVStylePicker 
                color={overboughtColor}
                onColorChange={setOverboughtColor}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-300">Oversold Level</span>
              <TVStylePicker 
                color={oversoldColor}
                onColorChange={setOversoldColor}
              />
            </div>

          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-white/10 bg-[#151822] gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-white/20 hover:bg-white/5 rounded text-white transition-colors">Cancel</button>
          <button 
            onClick={() => onApply(color, overbought, overbought2, oversold, oversold2, smaColor, overboughtColor, oversoldColor)} 
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
  spotPrice,
  onApply
}: {
  onClose: () => void,
  initialLevels: number[],
  initialLineStyle: number,
  spotPrice?: number,
  onApply: (levels: number[], lineStyle: number) => void
}) {
  const [levels, setLevels] = useState<number[]>(() => {
    return [...initialLevels];
  });
  const [lineStyle, setLineStyle] = useState(initialLineStyle);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-250">
      <div className="bg-[#1e222d] border border-border rounded-lg shadow-xl w-full max-w-[420px] overflow-visible flex flex-col animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-white">H Levels Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {spotPrice && spotPrice > 0 ? (
            <div className="flex items-center justify-between bg-slate-900/40 border border-slate-800 rounded p-2 text-xs">
              <span className="text-slate-400 font-sans">Spot price: <span className="font-mono text-slate-200 font-medium">{spotPrice.toFixed(2)}</span></span>
              <button 
                onClick={autoAlign}
                className="px-2 py-1 bg-cyan-600 hover:bg-cyan-500 hover:text-white rounded text-white text-[11px] font-medium transition-colors font-sans"
                title="Automatically calculate levels centered around current price"
              >
                Auto-align to Spot
              </button>
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
                  <label className="text-[10px] text-slate-400 uppercase font-sans">Red Level 1</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[0] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(0, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-slate-950 border border-red-900/30 rounded px-2 py-1 text-white text-right focus:outline-none focus:border-red-500 text-sm font-mono h-9"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase font-sans">Red Level 2</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[1] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(1, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-slate-950 border border-red-900/30 rounded px-2 py-1 text-white text-right focus:outline-none focus:border-red-500 text-sm font-mono h-9"
                  />
                </div>
              </div>
            </div>

            {/* Trap zones */}
            <div className="rounded-lg bg-yellow-950/10 border border-yellow-900/25 p-3 space-y-2.5">
              <div className="text-xs font-semibold text-yellow-500 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                Trap Zones (Intraday ranges)
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase font-sans">Trap Level 1</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[2] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(2, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-slate-950 border border-yellow-900/30 rounded px-2 py-1 text-white text-right focus:outline-none focus:border-yellow-500 text-sm font-mono h-9"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase font-sans">Trap Level 2</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[3] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(3, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-slate-950 border border-yellow-900/30 rounded px-2 py-1 text-white text-right focus:outline-none focus:border-yellow-500 text-sm font-mono h-9"
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
                  <label className="text-[10px] text-slate-400 uppercase font-sans">Green Level 1</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[4] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(4, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-slate-950 border border-green-900/30 rounded px-2 py-1 text-white text-right focus:outline-none focus:border-emerald-500 text-sm font-mono h-9"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase font-sans">Green Level 2</label>
                  <input
                    type="number"
                    step="1"
                    value={levels[5] || ""}
                    placeholder="0"
                    onChange={(e) => handleLevelChange(5, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className="w-full bg-slate-950 border border-emerald-500/30 rounded px-2 py-1 text-white text-right focus:outline-none focus:border-emerald-500 text-sm font-mono h-9"
                  />
                </div>
              </div>
            </div>

            {/* Line style selection */}
            <div className="space-y-2 pt-1">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-sans text-slate-400">Line style</div>
              <div className="flex border border-white/20 rounded overflow-hidden">
                {[
                  { val: 0, dash: 'solid', label: 'Solid' },
                  { val: 1, dash: 'dashed', label: 'Dashed' },
                  { val: 2, dash: 'dotted', label: 'Dotted' }
                ].map((ls) => (
                  <div 
                    key={`ls-${ls.val}`}
                    onClick={() => setLineStyle(ls.val)}
                    className={`flex-[1] h-8 flex items-center justify-center cursor-pointer border-r border-white/20 last:border-r-0 hover:bg-white/10 ${lineStyle === ls.val ? 'bg-white text-black font-semibold' : 'bg-[#2a2e39] text-white'}`}
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

          </div>
        </div>

        <div className="flex items-center justify-end p-4 border-t border-white/10 bg-[#151822] gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-white/20 hover:bg-white/5 rounded text-white transition-colors font-sans">Cancel</button>
          <button 
            onClick={() => onApply(levels, lineStyle)} 
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-[#1e222d] border border-border rounded-lg shadow-xl w-full max-w-[320px] overflow-visible flex flex-col pt-1 relative"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium text-white">PDH & PDL Settings</h2>
            <div className="w-3 h-3 text-muted-foreground ml-1">
               <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-slate-300">Previous Day High (PDH)</div>
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
             <div className="text-sm font-medium text-slate-300">Previous Day Low (PDL)</div>
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

        <div className="flex items-center justify-end p-4 border-t border-white/10 bg-[#151822] gap-2 mt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-transparent border border-white/20 hover:bg-white/5 rounded text-white transition-colors">Cancel</button>
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
    panel.className = 'ohlc-panel absolute top-2 left-2 z-[20] flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono select-none pointer-events-none px-2.5 py-1.5 rounded bg-[#1e222d]/90 backdrop-blur shadow-sm border border-white/10';
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 animate-in fade-in duration-250" onClick={onClose}>
      <div 
        className="bg-[#1e222d] border border-border rounded-lg shadow-xl w-full max-w-[320px] overflow-visible flex flex-col pt-1"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h3 className="text-lg font-medium text-white">Support/Resistance Settings</h3>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>
        
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
             <div className="text-sm font-medium text-slate-300">Support Line</div>
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
             <div className="text-sm font-medium text-slate-300">Resistance Line</div>
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

        <div className="flex bg-[#151822] p-4 gap-2 border-t border-white/10 mt-2">
          <button onClick={onClose} className="flex-1 py-1.5 text-sm bg-transparent border border-white/20 hover:bg-white/5 rounded text-white transition-colors">Cancel</button>
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
      <div className="w-full h-px bg-slate-800 my-2" />
      <div className="flex justify-between items-center mb-1">
        <span className="text-slate-400 font-semibold uppercase text-[11px]">Kite Order API</span>
        {d.lastApiStatus === 'Success' ? (
          <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold uppercase">Success</span>
        ) : d.lastApiStatus === 'Failed' ? (
          <span className="text-[9px] bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded font-bold uppercase">Failed</span>
        ) : d.lastApiStatus === 'Calling' ? (
          <span className="text-[9px] bg-sky-500/20 text-sky-400 px-1.5 py-0.5 rounded font-bold uppercase">Calling</span>
        ) : (
          <span className="text-[9px] bg-slate-500/20 text-slate-400 px-1.5 py-0.5 rounded font-bold uppercase">Not Called</span>
        )}
      </div>

      <div className="flex justify-between items-center bg-slate-900 border border-slate-700/60 p-2 rounded-lg mt-1 mb-2">
        <span className="text-[10px] text-slate-300 font-medium tracking-wide">Test Order Placement Mode</span>
        <label className="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" className="sr-only peer" checked={testMode} onChange={e => setTestMode(e.target.checked)} />
          <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-cyan-500"></div>
        </label>
      </div>

      <div className="flex flex-col gap-1.5 text-[10px] space-y-1">
        <div className="flex justify-between">
          <span className="text-slate-500">Order API Status</span>
          <span className={`font-mono ${d.lastApiStatus === 'Success' ? 'text-emerald-400' : d.lastApiStatus === 'Failed' ? 'text-rose-400' : 'text-slate-300'}`}>
            {d.lastApiStatus}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Last Order ID</span>
          <span className="text-slate-300 font-mono text-right truncate max-w-[150px]">
            {d.lastOrderId || 'N/A'}
          </span>
        </div>
        <div className="flex justify-between border-b border-slate-800/40 pb-1">
          <span className="text-slate-500">Exchange Order ID</span>
          <span className="text-slate-300 font-mono">
            {d.lastExchangeOrderId || 'N/A'}
          </span>
        </div>
        
        <div className="flex flex-col gap-0.5">
          <span className="text-slate-500">Request Payload</span>
          <div className="bg-slate-900 overflow-x-auto p-1.5 rounded border border-slate-800 text-slate-300 font-mono whitespace-pre-wrap max-h-32 text-[9px]">
            {d.lastOrderPayload || 'N/A'}
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-slate-500">Response Payload</span>
          <div className="bg-slate-900 overflow-x-auto p-1.5 rounded border border-slate-800 text-slate-300 font-mono whitespace-pre breaks-all max-h-32 text-[9px]">
            {d.lastOrderResponse || 'N/A'}
          </div>
        </div>

        {d.lastOrderError && (
            <div className="flex flex-col gap-0.5 mt-1 border-t border-slate-800/40 pt-1">
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
      <div className="w-full h-px bg-slate-800 my-1" />
      <div className="flex justify-between items-center mb-1">
        <span className="text-slate-400 font-semibold uppercase">Kite Margin API</span>
        {getMarginDiagnostics().lastApiStatus === 'Success' ? (
          <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold uppercase">Success</span>
        ) : getMarginDiagnostics().lastApiStatus === 'Failed' ? (
          <span className="text-[9px] bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded font-bold uppercase">Failed</span>
        ) : getMarginDiagnostics().lastApiStatus === 'Calling' ? (
          <span className="text-[9px] bg-sky-500/20 text-sky-400 px-1.5 py-0.5 rounded font-bold uppercase">Calling</span>
        ) : (
          <span className="text-[9px] bg-slate-500/20 text-slate-400 px-1.5 py-0.5 rounded font-bold uppercase">Not Called</span>
        )}
      </div>
      
      <div className="flex justify-between">
         <span className="text-slate-500">Margin Source</span>
         <span className={getMarginDiagnostics().lastResponseTimestamp > 0 ? "text-emerald-400" : "text-amber-400"}>
            {getMarginDiagnostics().lastResponseTimestamp > 0 ? 'Kite Margin API' : 'Local Estimate'}
         </span>
      </div>
      <div className="flex justify-between">
         <span className="text-slate-500">Fallback Count Today</span>
         <span className={getMarginDiagnostics().fallbackCount > 0 ? "text-amber-400 font-bold" : "text-slate-300"}>
            {getMarginDiagnostics().fallbackCount}
         </span>
      </div>
      {getMarginDiagnostics().fallbackCount > 0 && (
        <div className="flex justify-between text-[10px] mt-0.5">
           <span className="text-slate-500 truncate mr-2">Last Reason:</span>
           <span className="text-rose-400 text-right truncate max-w-[150px]" title={getMarginDiagnostics().lastFallbackReason}>
             {getMarginDiagnostics().lastFallbackReason}
           </span>
        </div>
      )}
      
      <div className="flex justify-between mt-1">
         <span className="text-slate-500">Cache Hit/Miss</span>
         <span className="text-purple-400">{getMarginDiagnostics().hits} / {getMarginDiagnostics().misses}</span>
      </div>
      <div className="flex justify-between">
         <span className="text-slate-500">Resp Time / Size</span>
         <span className="text-sky-400">
           {getMarginDiagnostics().lastApiTime > 0 ? `${getMarginDiagnostics().lastApiTime}ms / ${getMarginDiagnostics().lastResponseSize}B` : 'N/A'}
         </span>
      </div>
      
      <div className="mt-2 bg-slate-900/50 p-2 rounded-lg border border-slate-700/50">
        <span className="text-[10px] uppercase text-slate-500 font-bold block mb-1.5 text-center tracking-wider">Side-by-Side Comparison</span>
        <div className="grid grid-cols-[1fr_1fr_1fr] text-[10px] gap-x-2 pb-1 border-b border-slate-700/60 mb-1 text-center">
           <span className="text-slate-500 text-left">Metric</span>
           <span className="text-emerald-400">Kite API</span>
           <span className="text-amber-400">Local Est</span>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr] text-[10px] gap-x-2 text-center items-center">
           <span className="text-slate-400 text-left font-medium">Margin</span>
           <span className="text-emerald-300 font-mono">
             {getMarginDiagnostics().totalMargin > 0 ? `₹${Math.round(getMarginDiagnostics().totalMargin)}` : '-'}
           </span>
           <span className="text-amber-300 font-mono">
             {getMarginDiagnostics().localMargin > 0 ? `₹${Math.round(getMarginDiagnostics().localMargin)}` : '-'}
           </span>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr] text-[10px] gap-x-2 text-center items-center mt-1">
           <span className="text-slate-400 text-left font-medium">Charges</span>
           <span className="text-emerald-300 font-mono">
             {getMarginDiagnostics().totalCharges > 0 ? `₹${getMarginDiagnostics().totalCharges.toFixed(1)}` : '-'}
           </span>
           <span className="text-amber-300 font-mono">
             {getMarginDiagnostics().localCharges > 0 ? `₹${getMarginDiagnostics().localCharges.toFixed(1)}` : '-'}
           </span>
        </div>
        {getMarginDiagnostics().totalCharges > 0 && getMarginDiagnostics().localCharges > 0 && (
           <div className="text-[9px] text-center mt-1.5 pt-1 border-t border-slate-800/60 text-slate-400">
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

      <div className="w-full h-px bg-slate-800 my-2" />
      <div className="text-slate-400 font-semibold uppercase mb-1">Kite API Status</div>
      <div className="flex flex-col gap-1.5 text-[10px] mt-1 space-y-1">
         <div className="flex justify-between">
           <span className="text-slate-500">Kite API Keys Configured</span>
           <span className={`font-mono font-bold ${kiteDiagnosticsData?.kiteApiKeysConfigured ? 'text-emerald-400' : 'text-rose-400 animate-pulse'}`}>
             {kiteDiagnosticsData?.kiteApiKeysConfigured ? 'TRUE' : 'FALSE'}
           </span>
         </div>
         <div className="flex justify-between">
           <span className="text-slate-500">Kite Access Token Present</span>
           <span className={`font-mono font-bold ${kiteDiagnosticsData?.kiteAccessTokenPresent ? 'text-emerald-400' : 'text-rose-400 animate-pulse'}`}>
             {kiteDiagnosticsData?.kiteAccessTokenPresent ? 'TRUE' : 'FALSE'}
           </span>
         </div>
      </div>

      <div className="w-full h-px bg-slate-800 my-2" />
      <div className="text-slate-400 font-semibold uppercase mb-1">Margin API Debug</div>
      <div className="flex flex-col gap-1.5 text-[10px] mt-1 space-y-1">
        <div className="flex justify-between">
          <span className="text-slate-500">API Status</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiStatus === 'Success' ? 'text-emerald-400' : getMarginDiagnostics().lastApiStatus === 'Failed' ? 'text-rose-400' : 'text-slate-300'}`}>
            {getMarginDiagnostics().lastApiStatus}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Last Endpoint</span>
          <span className="text-slate-300 font-mono">
            {getMarginDiagnostics().lastApiEndpoint || 'N/A'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-slate-500">Last Payload</span>
          <div className="bg-slate-900 overflow-x-auto p-1.5 rounded border border-slate-800 text-slate-300 font-mono whitespace-pre-wrap max-h-32 text-[9px]">
            {getMarginDiagnostics().lastApiRequestPayload || 'N/A'}
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Res Status Code</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiStatusCode === 200 ? 'text-emerald-400' : getMarginDiagnostics().lastApiStatusCode > 0 ? 'text-rose-400' : 'text-slate-300'}`}>
            {getMarginDiagnostics().lastApiStatusCode || 'N/A'}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-slate-500">Last Response Body</span>
          <div className="bg-slate-900 overflow-x-auto p-1.5 rounded border border-slate-800 text-slate-300 font-mono whitespace-pre breaks-all max-h-32 text-[9px]">
            {getMarginDiagnostics().lastApiResponseBody || 'N/A'}
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Last Success</span>
          <span className={`font-mono ${getMarginDiagnostics().lastResponseTimestamp > 0 ? 'text-emerald-400' : 'text-slate-300'}`}>
            {getMarginDiagnostics().lastResponseTimestamp > 0 ? new Date(getMarginDiagnostics().lastResponseTimestamp).toLocaleTimeString() : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Margin API Res Parsed</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiResponseParsed ? 'text-emerald-400' : 'text-slate-300'}`}>
            {getMarginDiagnostics().lastApiResponseParsed ? 'TRUE' : 'FALSE'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Kite API Total Margin</span>
          <span className="font-mono text-cyan-400">
            {getMarginDiagnostics().totalMargin > 0 ? `₹${getMarginDiagnostics().totalMargin.toFixed(2)}` : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Kite API Total Charges</span>
          <span className="font-mono text-cyan-400">
            {getMarginDiagnostics().totalCharges > 0 ? `₹${getMarginDiagnostics().totalCharges.toFixed(2)}` : 'N/A'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Applied To Order Ticket</span>
          <span className={`font-mono ${getMarginDiagnostics().lastApiAppliedToTicket ? 'text-emerald-400' : 'text-slate-300'}`}>
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
  const [testOrderMode, setTestOrderMode] = useState(() => {
    try {
      return localStorage.getItem('testOrderMode') === 'true';
    } catch(e) {}
    return false;
  });

  useEffect(() => {
    try {
      localStorage.setItem('timeframe', timeframe);
    } catch(e) {}
  }, [timeframe]);

  useEffect(() => {
    try {
      localStorage.setItem('testOrderMode', String(testOrderMode));
    } catch(e) {}
  }, [testOrderMode]);
  const [crosshairInfo, setCrosshairInfo] = useState<{ y: number, price: number } | null>(null);
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
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [isEditingPdhPdl, setIsEditingPdhPdl] = useState(false);
  const [isEditingSnR, setIsEditingSnR] = useState(false);
  const [isEditingBB, setIsEditingBB] = useState(false);
  const [isEditingOiBars, setIsEditingOiBars] = useState(false);
  const [isEditingRsi, setIsEditingRsi] = useState(false);

  const logicalRangeRef = useRef<any>(null);

  useEffect(() => {
    logicalRangeRef.current = null;
  }, [selectedInstrument, timeframe]);

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

  const [rsiOverbought, setRsiOverbought] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOverbought');
      return saved ? parseInt(saved, 10) : 60;
    } catch (e) {}
    return 60;
  });

  const [rsiOverbought2, setRsiOverbought2] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOverbought2');
      return saved ? parseInt(saved, 10) : 70;
    } catch (e) {}
    return 70;
  });

  const [rsiOversold, setRsiOversold] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOversold');
      return saved ? parseInt(saved, 10) : 40;
    } catch (e) {}
    return 40;
  });

  const [rsiOversold2, setRsiOversold2] = useState(() => {
    try {
      const saved = localStorage.getItem('rsiOversold2');
      return saved ? parseInt(saved, 10) : 30;
    } catch (e) {}
    return 30;
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
    } catch(e) {}
  }, [rsiColor]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOverbought', String(rsiOverbought));
    } catch(e) {}
  }, [rsiOverbought]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOverbought2', String(rsiOverbought2));
    } catch(e) {}
  }, [rsiOverbought2]);

  useEffect(() => {
    try {
      localStorage.setItem('rsiOversold', String(rsiOversold));
    } catch(e) {}
  }, [rsiOversold]);

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
  const draggingLineRef = useRef<{ id: number, startY: number, dragged: boolean } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!chartContainerRef.current || !mainSeriesRef.current || !mainChartRef.current) return;
    const rect = chartContainerRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    
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
    if (newPrice !== null) {
       const lineObj = manualLinesRef.current.find((l: any) => l.id === draggingLineRef.current!.id);
       if (lineObj) {
           lineObj.price = newPrice;
           lineObj.instance.applyOptions({ price: newPrice });
       }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
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

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({...data, test_mode: testOrderMode})
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
    queryKey: ["ta-data-live", timeframe, instrumentToken],
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
    // Prevent background polling to save computer/broker resources
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: Infinity,
    gcTime: 10 * 60000,
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

  const { data: fiiDiiData } = useQuery({
    queryKey: ["fii-dii"],
    queryFn: async () => {
      const res = await fetch("/api/fii-dii");
      if (!res.ok) throw new Error("Network error");
      return res.json();
    }
  });

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
     if (!localAnalytics || !taInfo) return null;
     return computeMasterSignal(localAnalytics, taInfo, fiiDiiData);
  }, [localAnalytics, taInfo, fiiDiiData]);

  const [lastTickMessage, setLastTickMessage] = useState<string>('');

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
          if (seededLastCandle && seededLastCandle.time === updateTime) {
            updatedCandle = {
              time: updateTime,
              open: seededLastCandle.open,
              high: Math.max(seededLastCandle.high, msg.candle.close),
              low: Math.min(seededLastCandle.low, msg.candle.close),
              close: msg.candle.close,
            };
          } else {
            const prevClose = seededLastCandle ? seededLastCandle.close : msg.candle.close;
            updatedCandle = {
              time: updateTime,
              open: prevClose,
              high: Math.max(prevClose, msg.candle.close),
              low: Math.min(prevClose, msg.candle.close),
              close: msg.candle.close,
            };
            lastCandleTimeRef.current = updateTime;
          }
          lastCandleDataRef.current = updatedCandle;

          try {
            mainSeriesRef.current.update(updatedCandle);
            setWsError(''); // Clear error on successful tick processing
          } catch(e: any) {
            setWsError(`WS TICK ERR: ${e.message} (t=${updateTime}, last=${lastCandleDataRef.current?.time})`);
          }
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

           const updatedCandle = {
             time: updateTime,
             open: latestCandle.open,
             high: latestCandle.high,
             low: latestCandle.low,
             close: latestCandle.close,
           };
           lastCandleTimeRef.current = updateTime;
           lastCandleDataRef.current = updatedCandle;
           mainSeriesRef.current.update(updatedCandle);
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
        segment: selectedInstrument?.segment || "INDICES",
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
          volume: c.volume || Math.floor(Math.abs(c.close - c.open) * 1000) + 100
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

  const bbData = useMemo(() => {
    if (!chartData || !chartData.candles || !showBB) return [];
    return calculateBollingerBands(chartData.candles, bbPeriod, bbStdDev);
  }, [chartData, showBB, bbPeriod, bbStdDev]);

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

  useEffect(() => {
    if (!chartContainerRef.current || !chartData || chartData.candles.length === 0) return;

    const VISIBLE_BARS = 100;
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
        background: { type: ColorType.Solid, color: '#0d1117' },
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
        tickMarkFormatter: (time: any, tickMarkType: any, locale: string) => {
          const date = new Date(time * 1000);
          switch (tickMarkType) {
            case 0: // Year
              return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(date);
            case 1: // Month
              return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'short' }).format(date);
            case 2: // DayOfMonth
              return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric' }).format(date);
            case 3: // Time
              return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
            case 4: // TimeWithSeconds
              return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
            default:
              return Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
          }
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
      priceLineColor: 'rgba(34, 197, 94, 0.45)',
      priceLineWidth: 1,
      priceLineStyle: 1, // 1 is Dashed
    });

    mainSeriesRef.current = mainSeries;

    const { pdhPrice, pdlPrice, pStartTime } = pdhPdlData;

    // S&R Lines are now drawn via canvas in requestAnimationFrame

    manualLinesRef.current = [];
    manualLineIds.forEach(line => {
      try {
        const newPriceLine = mainSeries.createPriceLine({
          price: line.price,
          color: line.color || '#facc15',
          lineWidth: line.lineWidth || 2,
          lineStyle: line.lineStyle || 0,
          axisLabelVisible: line.axisLabelVisible ?? true,
          title: '',
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
          if (price !== null) {
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

      const lowerSeries = mainChart.addSeries(LineSeries, {
        color: hexToRgba(bbColor, 0.75),
        lineWidth: 1,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        title: ''
      });
      lowerSeries.setData(bbData.map(d => ({ time: d.time as any, value: d.lower })));
    }

    // Draw H Levels if enabled
    if (showHLevels && hLevels) {
      const colors = ['#ef4444', '#ef4444', '#fbbf24', '#fbbf24', '#22c55e', '#22c55e'];
      hLevels.forEach((priceLevel, index) => {
        if (priceLevel && priceLevel > 0) {
          mainSeries.createPriceLine({
            price: priceLevel,
            color: colors[index],
            lineWidth: 1,
            lineStyle: hLevelsStyle,
            axisLabelVisible: false,
            title: '',
          });
        }
      });
    }

    // Draw selected strike on chart (if selected)
    if (selectedStrikeOnChart && selectedStrikeOnChart.strike > 0) {
      try {
        mainSeries.createPriceLine({
          price: selectedStrikeOnChart.strike,
          color: selectedStrikeOnChart.optionType === 'CE' ? '#22c55e' : '#ef4444',
          lineWidth: 2,
          lineStyle: 1, // Dashed
          axisLabelVisible: true,
          title: `Selected ATM: ${selectedStrikeOnChart.tradingsymbol}`,
        });
      } catch (e) {
        console.error("Error creating selected strike price line:", e);
      }
    }

    // Recreate manual lines
    manualLinesRef.current.forEach((lineData) => {
      const newLine = mainSeries.createPriceLine({
        price: lineData.price,
        color: '#facc15',
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: 'Line',
      });
      lineData.instance = newLine;
    });

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

    // Create RSI Chart
    const rsiChart = createChart(rsiContainerRef.current, {
      ...commonOptions,
      timeScale: {
        ...commonOptions.timeScale,
        visible: false, // Hide time axis on RSI since they sync
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        autoScale: false,
      },
    });

    // Add RSI Series
    const rsiSeries = rsiChart.addSeries(LineSeries, {
      color: rsiColor,
      lineWidth: 2,
      priceLineVisible: false,
    });

    const rsiData = chartData.candles.map((c: any) => ({
      time: c.time as any,
      value: c.rsi14 || 50,
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
      { price: rsiOversold2, color: hexToRgba(rsiOversoldColor, 0.25) }, // OS 2 (outer)
      { price: rsiOversold, color: hexToRgba(rsiOversoldColor, 0.45) },  // OS 1 (inner)
      { price: rsiOverbought, color: hexToRgba(rsiOverboughtColor, 0.45) }, // OB 1 (inner)
      { price: rsiOverbought2, color: hexToRgba(rsiOverboughtColor, 0.25) } // OB 2 (outer)
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
        lineWidth: 1,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
    });
    rsiSmaSeries.setData(rsiSmaData);

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
          if (!isHoveringButtonRef.current) {
             setCrosshairInfo(null);
          }
        } else {
          const price = mainSeries.coordinateToPrice(param.point.y);
          if (price !== null) {
            setCrosshairInfo({ y: param.point.y, price });
          }

          if (param.time) {
            const dataPoint = getCrosshairDataPoint(mainSeries, param);
            const rVal = rsiDataMap.get(param.time) as number | undefined;
            if (rVal !== undefined) setRsiHoverValue(rVal.toFixed(2));
            
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
        
        if (!isHoveringButtonRef.current) {
          setCrosshairInfo(null);
        }

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
  }, [chartData, divergences, showRsi, showBB, bbData, bbColor, rsiColor, rsiOverbought, rsiOverbought2, rsiOversold, rsiOversold2, rsiSmaColor, rsiOverboughtColor, rsiOversoldColor, showHLevels, hLevels, hLevelsStyle, selectedStrikeOnChart]);

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
        // Update canvas logical size to match CSS layout
        const cw = Math.floor(rect.width);
        const ch = Math.floor(rect.height);
        if (canvas.width !== cw) canvas.width = cw;
        if (canvas.height !== ch) canvas.height = ch;
        
        ctx.clearRect(0,0, canvas.width, canvas.height);
        
        // 1. Draw Bollinger Bands fill if active
        if (showBB && bbData && bbData.length > 0) {
          ctx.beginPath();
          let first = true;
          
          for (let i = 0; i < bbData.length; i++) {
            const p = bbData[i];
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
          
          for (let i = bbData.length - 1; i >= 0; i--) {
            const p = bbData[i];
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

        // 2. Draw OI Bars if active
        if (showOiBars && oiData && oiData.strikes && oiData.ceData && oiData.peData) {
          const optionRows = oiData.strikes.map((strike: number) => ({
            strike,
            call_oi: oiData.ceData[strike]?.oi || 0,
            put_oi: oiData.peData[strike]?.oi || 0
          }));
          
          const maxOI = Math.max(...optionRows.map((o: any) => Math.max(o.call_oi, o.put_oi)));
          
          ctx.font = '10px Inter, sans-serif';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          
          // Draw from left edge to avoid overlapping with price labels on the right
          const leftEdge = 0;
          const maxBarWidth = oiMaxBarWidth; // max length of bars
          
          optionRows.forEach((row: any) => {
              const y = mainSeriesRef.current!.priceToCoordinate(row.strike);
              if (y === null || y < 0 || y > canvas.height) return;
              
              const callWidth = (row.call_oi / maxOI) * maxBarWidth;
              const putWidth = (row.put_oi / maxOI) * maxBarWidth;
              
              const barHeight = 8;
              
              // Call (Red) goes slightly above
              ctx.fillStyle = hexToRgba(oiCallColor, 0.75);
              ctx.fillRect(leftEdge, y - barHeight/2, callWidth, barHeight/2);
              
              // Put (Green) goes slightly below
              ctx.fillStyle = hexToRgba(oiPutColor, 0.75);
              ctx.fillRect(leftEdge, y, putWidth, barHeight/2);
          });
        }
        
        // 3. Draw Countdown to bar close on Y axis
        const lastCandle = lastCandleDataRef.current || (chartData && chartData.candles && chartData.candles.length > 0 ? chartData.candles[chartData.candles.length - 1] : null);
        if (lastCandle) {
          const y = mainSeriesRef.current!.priceToCoordinate(lastCandle.close);
          if (y !== null && y >= 0 && y <= canvas.height) {
            const priceScaleWidth = mainChartRef.current ? mainChartRef.current.priceScale('right').width() : 60;
            const badgeWidth = priceScaleWidth;
            const x = canvas.width - priceScaleWidth;
            const badgeHeight = 18;
            const badgeY = y + 9; 

            if (badgeY + badgeHeight <= canvas.height) {
              const nowMs = Date.now();
              const istMs = nowMs + (5.5 * 60 * 60 * 1000);
              const ist = new Date(istMs);
              const istDay = ist.getUTCDay();
              const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
              const marketOpen = istDay !== 0 && istDay !== 6 && istMinutes >= 9 * 60 + 15 && istMinutes <= 15 * 60 + 30;

              ctx.fillStyle = '#1e222d';
              ctx.fillRect(x, badgeY, badgeWidth, badgeHeight);
              ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';

              if (!marketOpen) {
                ctx.fillStyle = '#6b7280';
                ctx.fillText('MKT CLOSED', x + badgeWidth / 2, badgeY + badgeHeight / 2);
              } else {
                const now = Math.floor(nowMs / 1000) + serverTimeOffsetRef.current;
                const barDurationSeconds = parseInt(timeframe, 10) * 60;
                const alignedBarStart = Math.floor(now / barDurationSeconds) * barDurationSeconds;
                const remainingSec = Math.max(0, alignedBarStart + barDurationSeconds - now);
                ctx.fillStyle = '#f59e0b';
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
           const textAlignX = canvas.width - priceScaleWidth;
           
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
                 if (y !== null) linesToDraw.push({ text: `Support ${localAnalytics.supportZone.strikePrice}`, y, color: supportColor, dash: snrDash, lineWidth: snrWidth });
              }
              if (showSnR && localAnalytics?.resistanceZone?.strikePrice) {
                 const y = mainSeriesRef.current.priceToCoordinate(localAnalytics.resistanceZone.strikePrice);
                 if (y !== null) linesToDraw.push({ text: `Resistance ${localAnalytics.resistanceZone.strikePrice}`, y, color: resistanceColor, dash: snrDash, lineWidth: snrWidth });
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

              // Draw Lines
              linesToDraw.forEach(item => {
                 ctx.beginPath();
                 ctx.strokeStyle = item.color;
                 ctx.lineWidth = item.lineWidth || 1;
                 if (item.dash && item.dash.length > 0) ctx.setLineDash(item.dash);
                 ctx.moveTo(startX, item.y);
                 ctx.lineTo(endX, item.y);
                 ctx.stroke();
                 ctx.setLineDash([]);
              });

              // Collision avoidance for text labels
              const labels = [...linesToDraw];
              labels.sort((a, b) => a.y - b.y); // Top to bottom
              for (let i = 1; i < labels.length; i++) {
                 if (labels[i].y - labels[i - 1].y < 14) { // Minimum 14px vertical gap
                    labels[i].y = labels[i - 1].y + 14;
                 }
              }

              ctx.font = '11px sans-serif';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'middle';
              
              labels.forEach(label => {
                 // Optional: Draw a subtle background behind text for better readability
                 const textWidth = ctx.measureText(label.text).width;
                 ctx.fillStyle = 'rgba(13, 17, 23, 0.7)';
                 ctx.fillRect(textDrawX - textWidth - 2, label.y - 7, textWidth + 4, 14);
                 
                 ctx.fillStyle = label.color;
                 ctx.fillText(label.text, textDrawX, label.y);
              });
           }
        }

      } catch (e) {
        // Suppress "Object is disposed" errors from lightweight-charts within this drawing frame
      }
      
      animationFrameId = requestAnimationFrame(draw);
    };
    
    draw();
    
    return () => cancelAnimationFrame(animationFrameId);
  }, [showOiBars, oiData, showBB, bbData, timeframe, chartData, bbColor, oiMaxBarWidth, oiCallColor, oiPutColor, localAnalytics, showPdhPdl, pdhPdlData, pdhColor, pdlColor, pdhPdlStyle, pdhPdlWidth, showSnR, supportColor, resistanceColor, snrStyle, snrWidth]);

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
    <div className="p-6 md:p-8 animate-in fade-in duration-500 max-w-[1200px] w-full mx-auto pb-20 flex flex-col min-h-screen relative">
      
      {showDiagnostic && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#0d1117]/95 backdrop-blur-md border border-slate-700 p-4 rounded-lg shadow-2xl text-xs font-mono w-[340px] max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between border-b border-slate-700 pb-2 mb-2">
            <span className="text-slate-400 font-semibold uppercase">Diagnostic Panel</span>
            <button onClick={() => setShowDiagnostic(false)} className="text-slate-500 hover:text-white transition-colors">
              <X size={14} />
            </button>
          </div>
          {serverStats && (
            <div className="flex flex-col gap-1.5 mb-2">
              <span className="text-slate-400 font-semibold uppercase mb-1">Backend Connectivity</span>
              <div className="flex justify-between">
                 <span className="text-slate-500">Req / Min</span>
                 <span className="text-sky-400">{serverStats.requestCountPerMinute} req/min</span>
              </div>
              <div className="flex justify-between">
                 <span className="text-slate-500">Cache Hit/Miss</span>
                 <span className="text-purple-400">{serverStats.cacheHits} / {serverStats.cacheMisses}</span>
              </div>
              <div className="flex justify-between">
                 <span className="text-slate-500">Total 429 Errors</span>
                 <span className={serverStats.error429Count > 0 ? "text-red-400 font-bold" : "text-emerald-400"}>{serverStats.error429Count}</span>
              </div>
              <div className="flex justify-between">
                 <span className="text-slate-500">Last Req</span>
                 <span className="text-slate-300">{serverStats.lastRequestTime ? new Date(serverStats.lastRequestTime).toLocaleTimeString() : 'N/A'}</span>
              </div>
              <div className="w-full h-px bg-slate-800 my-1" />
              <span className="text-slate-400 font-semibold uppercase mb-1">WebSocket Connections</span>
              <div className="flex justify-between">
                 <span className="text-slate-500">Status</span>
                 <span className={`font-medium ${
                   getWsDiagnostics().status === 'Connected' ? 'text-emerald-400' : 
                   getWsDiagnostics().status === 'Failed' ? 'text-red-400' : 'text-amber-400'
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
              <span className="text-slate-400 font-semibold uppercase mb-1">Chart Data</span>
              <div className="flex justify-between">
                <span className="text-slate-500">Token</span>
              <span className="text-white">{instrumentToken}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Symbol</span>
              <span className="text-cyan-400">{selectedInstrument?.tradingsymbol || 'NIFTY 50'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Exchange</span>
              <span className="text-white">{selectedInstrument?.exchange || 'NSE'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Segment</span>
              <span className="text-white">{selectedInstrument?.segment || 'INDICES'}</span>
            </div>
            <div className="w-full h-px bg-slate-800 my-1" />
            <div className="flex justify-between">
              <span className="text-slate-500">Latest Vol</span>
              <span className="text-emerald-400">{taInfo.rawTop5?.[0]?.volume ?? '0'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Vol Source</span>
              <span className="text-amber-400">Raw Kite Data</span>
            </div>
            <div className="w-full h-px bg-slate-800 my-1" />
            <span className="text-slate-400 font-semibold uppercase mb-1">Bollinger Bands</span>
            <div className="flex justify-between">
              <span className="text-slate-500">Status</span>
              <span className={showBB ? "text-emerald-400 font-bold" : "text-slate-500"}>
                {showBB ? "ENABLED" : "DISABLED"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Period</span>
              <span className="text-white">{bbPeriod}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Std Dev</span>
              <span className="text-white">{bbStdDev}</span>
            </div>
            {showBB && bbData.length > 0 ? (
              <>
                <div className="flex justify-between">
                  <span className="text-slate-500">Latest Upper</span>
                  <span className="text-cyan-400 font-mono">{bbData[bbData.length - 1].upper.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Latest Basis</span>
                  <span className="text-purple-400 font-mono">{bbData[bbData.length - 1].middle.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Latest Lower</span>
                  <span className="text-cyan-400 font-mono">{bbData[bbData.length - 1].lower.toFixed(2)}</span>
                </div>
              </>
            ) : showBB && (
              <div className="text-[10px] text-amber-500 italic">No calculation data available</div>
            )}
            {taInfo.rawVolumeStats && (
              <>
                <div className="w-full h-px bg-slate-800 my-1" />
                <div className="flex justify-between">
                  <span className="text-slate-500">Max Hist Vol</span>
                  <span className="text-pink-400">{taInfo.rawVolumeStats.max}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Min Hist Vol</span>
                  <span className="text-pink-400">{taInfo.rawVolumeStats.min}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Avg Hist Vol</span>
                  <span className="text-pink-400">{taInfo.rawVolumeStats.avg}</span>
                </div>
              </>
            )}
            {taInfo.rawTop5 && taInfo.rawTop5.length > 0 && (
              <>
                <div className="w-full h-px bg-slate-800 my-1" />
                <span className="text-slate-400 font-semibold uppercase mb-1">Historical Candle Audit</span>
                <div className="flex flex-col gap-2 relative">
                  {taInfo.rawTop5.map((c: any, i: number) => (
                    <div key={i} className="flex flex-col bg-slate-800/50 p-2 rounded text-[10px]">
                      <div className="text-slate-400 flex justify-between">
                        <span>{new Date(c.date || c.time).toLocaleString()}</span>
                        <span className="text-emerald-400">Vol: {c.volume ?? 'N/A'}</span>
                      </div>
                      <div className="grid grid-cols-4 gap-1 mt-1 text-slate-300">
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

      <div className="flex justify-between items-end pb-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">
            Advanced Trading Chart
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live price action with Candlesticks, Volume, and RSI Divergences
          </p>
          <div className="flex gap-2 items-center mt-2 flex-wrap">
             {lastTickMessage && (
               <span className="bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-md text-xs font-mono font-bold animate-pulse">
                LIVE TICK: {lastTickMessage}
               </span>
             )}
             {wsError && (
               <span className="bg-red-500/20 text-red-400 px-3 py-1 rounded-md text-xs font-mono font-bold animate-pulse">
                WS ERROR: {wsError}
               </span>
             )}
          </div>
          {parseInt(timeframe) < 15 && (
            <p className="text-sm text-amber-500 mt-2 font-medium">
              RSI Divergence is available only on 15-minute and higher timeframes.
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          <SymbolSearch 
            onSelect={setSelectedInstrument} 
            currentSymbol={selectedInstrument ? selectedInstrument.tradingsymbol : "NIFTY 50"} 
          />
          {decision && localAnalytics && (
             <div className="flex items-center gap-4 px-3 py-1 bg-slate-800/40 border border-slate-700/50 rounded-md ml-2">
                <div className="flex items-center gap-2">
                   {(() => {
                      const biasText = decision.bullScore > decision.bearScore ? 'Bullish' : decision.bearScore > decision.bullScore ? 'Bearish' : 'Neutral';
                      const textColor = biasText === 'Bullish' ? 'text-green-500' : biasText === 'Bearish' ? 'text-red-500' : 'text-[#f59e0b]';
                      return (
                         <span className={`font-bold ${textColor}`}>
                            {biasText}
                         </span>
                      );
                   })()}
                </div>
             </div>
          )}
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
                <div className="absolute top-full mt-1.5 right-0 min-w-[240px] bg-[#0d1117] border border-slate-700/50 rounded-md shadow-xl py-1.5 z-50 overflow-hidden flex flex-col">
                  <div className="px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase">Available Indicators</div>
                  
                  {/* Previous Day High/Low */}
                  <div className="flex items-center justify-between px-3 hover:bg-slate-800 transition-colors group">
                    <button
                      onClick={() => setShowPdhPdl(!showPdhPdl)}
                      className="flex items-center gap-2 py-2 text-sm text-slate-300 hover:text-white transition-colors text-left flex-grow"
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
                      className="text-slate-500 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                      title="PDH/PDL Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* Support/Resistance Lines */}
                  <div className="flex items-center justify-between px-3 hover:bg-slate-800 transition-colors group">
                    <button
                      onClick={() => setShowSnR(!showSnR)}
                      className="flex items-center gap-2 py-2 text-sm text-slate-300 hover:text-white transition-colors text-left flex-grow"
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
                      className="text-slate-500 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                      title="Support/Resistance Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* OI Bars */}
                  <div className="flex items-center justify-between px-3 hover:bg-slate-800 transition-colors group">
                    <button
                      onClick={() => setShowOiBars(!showOiBars)}
                      className="flex items-center gap-2 py-2 text-sm text-slate-300 hover:text-white transition-colors text-left flex-grow"
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
                      className="text-slate-500 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                      title="OI Bars Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* RSI */}
                  <div className="flex items-center justify-between px-3 hover:bg-slate-800 transition-colors group">
                    <button
                      onClick={() => setShowRsi(!showRsi)}
                      className="flex items-center gap-2 py-2 text-sm text-slate-300 hover:text-white transition-colors text-left flex-grow"
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
                      className="text-slate-500 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                      title="RSI Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* Bollinger Bands */}
                  <div className="flex items-center justify-between px-3 hover:bg-slate-800 transition-colors group">
                    <button
                      onClick={() => setShowBB(!showBB)}
                      className="flex items-center gap-2 py-2 text-sm text-slate-300 hover:text-white transition-colors text-left flex-grow"
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
                      className="text-slate-500 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                      title="Bollinger Bands Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* H Levels */}
                  <div className="flex items-center justify-between px-3 hover:bg-slate-800 transition-colors group">
                    <button
                      onClick={() => setShowHLevels(!showHLevels)}
                      className="flex items-center gap-2 py-2 text-sm text-slate-300 hover:text-white transition-colors text-left flex-grow"
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
                      className="text-slate-500 hover:text-white p-1 hover:bg-slate-700 rounded transition-colors"
                      title="H Levels Settings"
                    >
                      <Settings size={13} />
                    </button>
                  </div>

                  {/* Diagnostic Panel */}
                  <button
                    onClick={() => setShowDiagnostic(!showDiagnostic)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors text-left"
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
              className="bg-background text-foreground border border-border text-sm rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary h-9"
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
          <div className="relative flex-grow flex w-full" style={{ minHeight: "450px" }} onMouseLeave={() => setCrosshairInfo(null)}>
            <div
              ref={chartContainerRef}
              onPointerDownCapture={handlePointerDown}
              onPointerMoveCapture={handlePointerMove}
              onPointerUpCapture={handlePointerUp}
              onPointerLeave={handlePointerUp}
              className="bg-[#0d1117] border border-border rounded-xl stretch-self shadow-sm flex-grow relative w-full overflow-hidden"
            />
            {crosshairInfo && (
              <button
                onClick={handleAddManualLine}
                onMouseEnter={() => { isHoveringButtonRef.current = true; }}
                onMouseLeave={() => { isHoveringButtonRef.current = false; }}
                className="absolute right-[65px] w-6 h-6 rounded-full bg-[#1e222d] border border-slate-600 flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700 shadow-sm z-[60] transition-colors"
                style={{
                  top: `${crosshairInfo.y}px`,
                  transform: 'translateY(-50%)' // Center vertically
                }}
              >
                <Plus size={14} />
              </button>
            )}
            <canvas
              ref={overlayCanvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none rounded-xl z-10"
            />
            
            {clickMenu && (
              <div 
                className="absolute z-[100] bg-[#1a1f2c] border border-slate-705 rounded-lg shadow-2xl p-2 flex flex-col gap-1.5 w-[160px] transition-all duration-150 animate-in fade-in zoom-in-95"
                style={{
                  top: `${Math.max(5, Math.min(clickMenu.y, (chartContainerRef.current?.getBoundingClientRect().height || 450) - 170))}px`,
                  left: `${Math.min(clickMenu.x, (chartContainerRef.current?.getBoundingClientRect().width || 600) - 175)}px`,
                }}
              >
                <div className="text-[10px] font-semibold text-slate-400 border-b border-slate-800 pb-1 mb-0.5 px-1 flex justify-between items-center">
                  <span>Strike Click</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setClickMenu(null); }} className="text-slate-500 hover:text-white transition-colors text-xs font-bold font-mono">✕</button>
                </div>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('BUY', 'CE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-emerald-950/25 hover:bg-emerald-900 border border-emerald-800/40 rounded px-2 py-1 text-emerald-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Buy Call</span>
                  <span className="text-[9px] bg-emerald-500/20 px-1 rounded text-emerald-400">CE</span>
                </button>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('SELL', 'CE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-rose-955/15 hover:bg-rose-900 border border-rose-900/40 rounded px-2 py-1 text-rose-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Sell Call</span>
                  <span className="text-[9px] bg-rose-500/20 px-1 rounded text-rose-400">CE</span>
                </button>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('BUY', 'PE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-emerald-950/25 hover:bg-emerald-900 border border-emerald-800/40 rounded px-2 py-1 text-emerald-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Buy Put</span>
                  <span className="text-[9px] bg-emerald-500/20 px-1 rounded text-emerald-400">PE</span>
                </button>
                <button 
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStrikeAction('SELL', 'PE', clickMenu.price); }}
                  className="w-full text-left text-xs bg-rose-955/15 hover:bg-rose-900 border border-rose-900/40 rounded px-2 py-1 text-rose-400 font-semibold transition-colors flex items-center justify-between cursor-pointer"
                >
                  <span>Sell Put</span>
                  <span className="text-[9px] bg-rose-500/20 px-1 rounded text-rose-400">PE</span>
                </button>
              </div>
            )}

            {isProcessingStrikeAction && (
              <div className="absolute inset-0 z-[120] bg-black/40 backdrop-blur-[1px] flex items-center justify-center rounded-xl">
                <div className="bg-[#1e222d] border border-slate-700/80 px-4 py-3 rounded-lg flex items-center gap-2.5 shadow-2xl">
                  <Loader2 className="w-5 h-5 animate-spin text-cyan-400" />
                  <span className="text-xs text-slate-250 font-medium text-slate-200">Resolving option strike details...</span>
                </div>
              </div>
            )}
          </div>
          {/* RSI Chart */}
          <div className={`relative w-full ${!showRsi ? 'hidden' : ''}`} style={{ height: "200px", minHeight: "200px" }}>
            <div
              ref={rsiContainerRef}
              className="bg-[#0d1117] border border-border rounded-xl overflow-hidden shadow-sm w-full h-full absolute inset-0"
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
          onChange={(price, color, lineWidth, lineStyle, labelVisible) => {
            const idx = manualLinesRef.current.findIndex((l: any) => l.id === editingLineId);
            if (idx > -1) {
              const lineData = manualLinesRef.current[idx];
              try {
                lineData.instance.applyOptions({
                  price: price,
                  color: color,
                  lineWidth: lineWidth,
                  lineStyle: lineStyle,
                  axisLabelVisible: labelVisible
                });
                lineData.price = price;
                lineData.color = color;
                lineData.lineWidth = lineWidth;
                lineData.lineStyle = lineStyle;
                lineData.axisLabelVisible = labelVisible;
              } catch(e){}
            }
          }}
          onApply={(price, color, lineWidth, lineStyle, labelVisible) => {
            const idx = manualLinesRef.current.findIndex((l: any) => l.id === editingLineId);
            if (idx > -1) {
              const lineData = manualLinesRef.current[idx];
              // To update we must remove and re-add in lightweight-charts for some properties,
              // but we can also use applyOptions. Let's use applyOptions
              try {
                lineData.instance.applyOptions({
                  price: price,
                  color: color,
                  lineWidth: lineWidth,
                  lineStyle: lineStyle,
                  axisLabelVisible: labelVisible
                });
                lineData.price = price;
                lineData.color = color;
                lineData.lineWidth = lineWidth;
                lineData.lineStyle = lineStyle;
                lineData.axisLabelVisible = labelVisible;
                setManualLineIds(prev => prev.map(l => l.id === editingLineId ? { ...l, price, color, lineWidth, lineStyle, axisLabelVisible: labelVisible } : l));
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
          initialCallColor={oiCallColor}
          initialPutColor={oiPutColor}
          onClose={() => setIsEditingOiBars(false)}
          onApply={(maxBarWidth, callColor, putColor) => {
            setOiMaxBarWidth(maxBarWidth);
            setOiCallColor(callColor);
            setOiPutColor(putColor);
            setIsEditingOiBars(false);
          }}
        />
      )}

      {isEditingRsi && (
        <RsiEditorModal
          initialColor={rsiColor}
          initialOverbought={rsiOverbought}
          initialOverbought2={rsiOverbought2}
          initialOversold={rsiOversold}
          initialOversold2={rsiOversold2}
          initialSmaColor={rsiSmaColor}
          initialOverboughtColor={rsiOverboughtColor}
          initialOversoldColor={rsiOversoldColor}
          onClose={() => setIsEditingRsi(false)}
          onApply={(color, overbought, overbought2, oversold, oversold2, smaColor, overboughtColor, oversoldColor) => {
            setRsiColor(color);
            setRsiOverbought(overbought);
            setRsiOverbought2(overbought2);
            setRsiOversold(oversold);
            setRsiOversold2(oversold2);
            setRsiSmaColor(smaColor);
            setRsiOverboughtColor(overboughtColor);
            setRsiOversoldColor(oversoldColor);
            setIsEditingRsi(false);
          }}
        />
      )}

      {isEditingHLevels && (
        <HLevelsEditorModal
          initialLevels={hLevels}
          initialLineStyle={hLevelsStyle}
          spotPrice={chartData?.spot || (chartData?.candles && chartData.candles.length > 0 ? chartData.candles[chartData.candles.length - 1].close : undefined)}
          onClose={() => setIsEditingHLevels(false)}
          onApply={(levels, style) => {
            setHLevels(levels);
            setHLevelsStyle(style);
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


