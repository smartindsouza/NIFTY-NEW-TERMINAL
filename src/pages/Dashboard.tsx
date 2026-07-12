import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Card } from '@/components/ui/card';
import { TrendingUp, Activity, ArrowRight, ArrowDownRight, TrendingDown, AlignLeft, BarChart2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { computeMasterSignal } from '@/lib/decisionEngine';
import { motion } from 'motion/react';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { notificationService } from '../lib/notificationService';

export function Dashboard() {
  const [timeframe, setTimeframe] = useState(() => {
    try {
      return localStorage.getItem('timeframe') || "15";
    } catch(e) {
      return "15";
    }
  });

  useEffect(() => {
    const handleStorage = () => {
      try {
        const stored = localStorage.getItem('timeframe');
        if (stored && stored !== timeframe) setTimeframe(stored);
      } catch (e) {}
    };
    window.addEventListener('storage', handleStorage);
    const interval = setInterval(handleStorage, 1000);
    return () => {
      window.removeEventListener('storage', handleStorage);
      clearInterval(interval);
    };
  }, [timeframe]);

  const { data: chain } = useQuery({ queryKey: ['option-chain'], queryFn: async () => (await axios.get('/api/option-chain')).data, refetchInterval: 10000 });
  const { data: analytics } = useQuery({ queryKey: ['analytics'], queryFn: async () => (await axios.get('/api/analytics')).data, refetchInterval: 10000 });
  const { data: taData, error: taError } = useQuery({ 
    queryKey: ['ta-data-live-chart', timeframe, '256265'], // Matches AdvancedChart cache
    queryFn: async () => {
      const res = await axios.get(`/api/ta?symbol=NIFTY%2050&token=256265&timeframe=${timeframe}`);
      return res.data;
    }, 
    refetchInterval: 10000 
  });
  const { data: fiiDiiData } = useQuery({ queryKey: ['fii-dii'], queryFn: async () => (await axios.get('/api/fii-dii')).data, refetchInterval: 10000 });

  const alertedRef = useRef<Set<string>>(new Set());
  const alertedDateRef = useRef<string>('');

  // Market session awareness (IST timezone)
  const now = new Date();

  // Get IST date and time
  const istOptions: Intl.DateTimeFormatOptions = { 
    timeZone: 'Asia/Kolkata', 
    hour: 'numeric', 
    minute: 'numeric', 
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  };
  const istParts = new Intl.DateTimeFormat('en-US', istOptions).formatToParts(now);
  const getPart = (type: string) => istParts.find(p => p.type === type)?.value || '0';
  
  const currentISTDate = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
  
  if (alertedDateRef.current !== currentISTDate) {
    alertedRef.current = new Set();
    alertedDateRef.current = currentISTDate;
  }

  const istHour = parseInt(getPart('hour'));
  const istMinute = parseInt(getPart('minute'));
  const timeInMinutes = istHour * 60 + istMinute;
  const isMarketOpen = timeInMinutes >= 9 * 60 + 15 && timeInMinutes <= 15 * 60 + 30;

  useEffect(() => {
    if (!chain) return;
    
    const THRESHOLD = 2.0;
    const { spot } = chain;

    let marketSessionContext = '';
    
    // 09:15 to 15:30
    if (isMarketOpen) {
      marketSessionContext = 'INTRADAY OI ALERT';
    } else if (timeInMinutes > 15 * 60 + 30) {
      marketSessionContext = 'EOD POSITION BUILD-UP';
    } else {
      marketSessionContext = 'PRE-MARKET CONTEXT';
    }

    const checkAlerts = (data: any, type: 'CE' | 'PE') => {
      Object.keys(data).forEach((strikeStr) => {
        const option = data[strikeStr as any];
        const strike = option.strikePrice;
        const key = `${type}-${strike}`;
        
        const absoluteDistance = Math.abs(strike - spot);
        const distance = strike - spot;
        
        if (Math.abs(option.chgOi) > THRESHOLD) {
          if (!alertedRef.current.has(key)) {
            // Check if we should show this on dashboard
            if (absoluteDistance > 1000) {
               alertedRef.current.add(key); // We still add to ref so we don't spam, but we skip displaying
               return; // Hide from dashboard completely
            }
            
            if (isMarketOpen && absoluteDistance > 300) {
               // For intraday, only show alerts if absoluteDistance <= 300
               return; 
            }
            
            let labelContext = marketSessionContext;
            if (absoluteDistance > 500) {
              labelContext = 'FAR POSITIONAL BUILD-UP';
            }

            const direction = option.chgOi > 0 ? 'Added' : 'Unwound';
            const actionColor = option.chgOi > 0 ? 'text-green-500' : 'text-red-500';
            
            let actionLabel = '';
            let interpretation = '';
            let isHedging = false;

            if (type === 'PE') {
              if (strike > spot) {
                isHedging = true;
                actionLabel = 'ITM PUT POSITIONING / HEDGING';
                interpretation = 'Positional or hedging activity. Not intraday support.';
              } else {
                if (option.chgOi > 0) {
                  if (option.chgLtp < 0) {
                    actionLabel = 'PUT WRITING DETECTED';
                    interpretation = 'Bullish / support building.';
                  } else {
                    actionLabel = 'PUT BUYING DETECTED';
                    interpretation = 'Bearish / downside protection.';
                  }
                } else {
                   actionLabel = 'PUT UNWINDING DETECTED';
                   interpretation = 'Support weakening.';
                }
              }
            } else { // CE
              if (strike < spot) {
                isHedging = true;
                actionLabel = 'ITM CALL POSITIONING / HEDGING';
                interpretation = 'Positional or hedging activity. Not intraday resistance.';
              } else {
                if (option.chgOi > 0) {
                  if (option.chgLtp < 0) {
                    actionLabel = 'CALL WRITING DETECTED';
                    interpretation = 'Bearish / resistance building.';
                  } else {
                    actionLabel = 'CALL BUYING DETECTED';
                    interpretation = 'Bullish / breakout interest.';
                  }
                } else {
                   actionLabel = 'CALL UNWINDING DETECTED';
                   interpretation = 'Resistance weakening.';
                }
              }
            }
            
            if (absoluteDistance > 500) {
               interpretation = 'Too far from spot for intraday decision. Hidden from dashboard.';
               // Actually the prompt says if >1000 hide from dashboard completely. 
               // For >500 we can show "FAR POSITIONAL BUILD-UP" unless it's intraday. Wait, intraday is limited to 300. So we never see 500 if market is open.
            }

            // Dashboard rule: Do not show OI alerts on dashboard unless:
            // - Market is open
            // - absoluteDistance <= 300
            // - writing/buying interpretation is clear
            if (isMarketOpen && absoluteDistance <= 300 && !isHedging && (actionLabel.includes('WRITING') || actionLabel.includes('BUYING'))) {
              toast(`🚨 ${labelContext}`, {
                description: (
                  <div className="font-mono mt-1 space-y-1">
                    <div className="font-bold">{strike} {type}</div>
                    <div className="font-bold text-foreground">{actionLabel}</div>
                    <div>OI {direction}: <span className={cn("font-bold", actionColor)}>{Math.abs(option.chgOi).toFixed(2)}L</span></div>
                    <div>Distance from spot: {distance > 0 ? '+' : ''}{distance.toFixed(0)} pts</div>
                    <div className="text-muted-foreground mt-2">Interpretation: {interpretation}</div>
                  </div>
                ),
                duration: 8000,
              });

              notificationService.add('oi_alert', labelContext, `Strike: ${strike} ${type} at ${distance > 0 ? '+' : ''}${distance.toFixed(0)} pts: ${actionLabel}. Interpretation: ${interpretation}`, {
                strike,
                type,
                distance: distance.toFixed(0),
                actionLabel,
                interpretation
              });
            } else if (!isMarketOpen) {
              toast(`📊 ${labelContext}`, {
                description: (
                  <div className="font-mono mt-1 space-y-1">
                    <div className="font-bold">{strike} {type}</div>
                    <div className="font-bold text-foreground">{actionLabel}</div>
                    <div>OI {direction}: <span className={cn("font-bold", actionColor)}>{Math.abs(option.chgOi).toFixed(2)}L</span></div>
                    <div>Distance from spot: {distance > 0 ? '+' : ''}{distance.toFixed(0)} pts</div>
                    <div className="text-muted-foreground mt-2">Interpretation: {interpretation}</div>
                  </div>
                ),
                duration: 8000,
              });

              notificationService.add('oi_alert', labelContext, `Strike: ${strike} ${type} at ${distance > 0 ? '+' : ''}${distance.toFixed(0)} pts: ${actionLabel}. Interpretation: ${interpretation}`, {
                strike,
                type,
                distance: distance.toFixed(0),
                actionLabel,
                interpretation
              });
            }
            
            alertedRef.current.add(key);
          }
        } else {
          alertedRef.current.delete(key);
        }
      });
    };

    checkAlerts(chain.ceData, 'CE');
    checkAlerts(chain.peData, 'PE');
    
  }, [chain]);

  if (!chain || !analytics || !taData || !fiiDiiData) {
    return (
      <div className="p-8 space-y-6">
        <Skeleton className="h-12 w-64 bg-card/50 backdrop-blur-md rounded-xl" />
        <Skeleton className="h-[200px] w-full bg-card/50 backdrop-blur-md rounded-xl" />
        <Skeleton className="h-[600px] w-full bg-card/50 backdrop-blur-md rounded-xl" />
      </div>
    );
  }

  const { spot } = chain;
  const { totalCeOi, totalPeOi, pcr, maxPain, supportZone, resistanceZone } = analytics;
  
  const totalOi = totalCeOi + totalPeOi;
  const cePercent = totalOi > 0 ? (totalCeOi / totalOi) * 100 : 50;
  const pePercent = totalOi > 0 ? (totalPeOi / totalOi) * 100 : 50;

  const decision = computeMasterSignal({ ...analytics, spot }, taData, fiiDiiData);

  if (!decision) return null;

  const isBuyCall = decision.signal === 'BUY CALL';
  const isBuyPut = decision.signal === 'BUY PUT';
  const isRange = decision.signal === 'RANGE TRADE ONLY';
  
  const signalColor = isBuyCall ? 'text-green-500' : isBuyPut ? 'text-red-500' : isRange ? 'text-primary' : 'text-gray-500';
  const signalBg = isBuyCall ? 'bg-green-500' : isBuyPut ? 'bg-red-500' : isRange ? 'bg-primary' : 'bg-gray-500';
  const signalBorder = isBuyCall ? 'border-green-500/30' : isBuyPut ? 'border-red-500/30' : isRange ? 'border-primary/30' : 'border-gray-500/30';
  const signalBgMuted = isBuyCall ? 'bg-green-500/10' : isBuyPut ? 'bg-red-500/10' : isRange ? 'bg-primary/10' : 'bg-gray-500/10';

  const taBiasText = decision.bullScore > decision.bearScore ? "Bullish" : decision.bearScore > decision.bullScore ? "Bearish" : "Neutral";
  const taBiasColor = taBiasText === 'Bullish' ? 'text-green-500' : taBiasText === 'Bearish' ? 'text-red-500' : 'text-primary';

  // --- Trend Computation ---
  const vwap = taData.vwap || spot;
  const ema20 = taData.ema20 || spot;
  const { plusDi, minusDi, adx } = taData;

  let trendDirection = 'Neutral';
  let trendExplanation = 'No clear directional advantage.';
  
  if (spot > vwap && spot > ema20 && plusDi > minusDi) {
    trendDirection = 'Bullish';
    trendExplanation = 'Buyers currently have control.';
  } else if (spot < vwap && spot < ema20 && minusDi > plusDi) {
    trendDirection = 'Bearish';
    trendExplanation = 'Sellers currently have control.';
  }

  let trendStrength = 'Weak';
  if (adx >= 50) trendStrength = 'Extreme';
  else if (adx >= 35) trendStrength = 'Very Strong';
  else if (adx >= 25) trendStrength = 'Strong';
  else if (adx >= 20) trendStrength = 'Developing';

  let combinedSummaryText = 'RANGE / NO TREND';
  let combinedSummaryColor = 'bg-primary';
  
  if (adx >= 20) {
    if (trendDirection === 'Bullish') {
      combinedSummaryColor = 'bg-green-500';
      if (adx >= 35) combinedSummaryText = 'Very Strong Bullish Trend';
      else if (adx >= 25) combinedSummaryText = 'Strong Bullish Trend';
      else combinedSummaryText = 'Bullish Trend';
    } else if (trendDirection === 'Bearish') {
      combinedSummaryColor = 'bg-red-500';
      if (adx >= 35) combinedSummaryText = 'Very Strong Bearish Trend';
      else if (adx >= 25) combinedSummaryText = 'Strong Bearish Trend';
      else combinedSummaryText = 'Bearish Trend';
    }
  }

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 animate-in fade-in duration-500 max-w-[1600px] w-full mx-auto font-sans tracking-wide pb-20">
      {/* Header — elevated hero */}
      <div className="relative bg-card border border-border rounded-xl overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
        <div className="flex justify-between items-center gap-3 p-4 md:p-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight">NIFTY 50</h1>
              {isMarketOpen ? (
                <span className="inline-flex items-center gap-1.5 text-[9px] font-bold bg-green-500/15 text-green-500 px-2 py-1 rounded-full uppercase tracking-wider whitespace-nowrap">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> Market Open
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[9px] font-bold bg-muted text-muted-foreground px-2 py-1 rounded-full uppercase tracking-wider whitespace-nowrap">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" /> Market Closed
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground whitespace-nowrap mt-1.5">Expiry: Live Data</p>
          </div>
          <div className="text-right flex flex-col items-end shrink-0">
            <motion.h1 
              key={spot}
              initial={{ color: '#4ade80', scale: 1.05 }}
              animate={{ color: 'var(--foreground)', scale: 1 }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="text-3xl md:text-5xl font-mono font-bold tracking-tighter whitespace-nowrap"
            >
              {spot.toFixed(2)}
            </motion.h1>
            <p className="text-[10px] uppercase text-muted-foreground tracking-widest mt-1">SPOT PRICE</p>
          </div>
        </div>
      </div>

      {/* OI Bars — carded with section label */}
      <div className="bg-card border border-border rounded-xl p-4 md:p-5">
        <p className="text-[10px] font-bold text-muted-foreground tracking-widest uppercase mb-3">Open Interest Distribution</p>
        <div className="grid grid-cols-[1fr_2fr_1fr] items-center gap-3 md:gap-8">
          <div className="text-center">
            <p className="text-[10px] uppercase text-muted-foreground tracking-widest">Total CE OI</p>
            <p className="text-lg font-mono font-bold text-red-500 mt-1">{totalCeOi.toFixed(1)}L</p>
          </div>
          <div className="text-center w-full px-2 md:px-4">
            <p className="text-[10px] uppercase text-muted-foreground tracking-widest mb-2">CE / PE Split</p>
            <div className="h-2 w-full bg-muted flex overflow-hidden rounded-full">
              <div className="bg-red-500 rounded-l-full" style={{ width: `${cePercent}%` }}></div>
              <div className="bg-green-500 rounded-r-full" style={{ width: `${pePercent}%` }}></div>
            </div>
            <div className="flex justify-between text-[10px] mt-2 font-mono">
              <span className="text-red-500/80">{cePercent.toFixed(1)}% CE</span>
              <span className="text-green-500/80">{pePercent.toFixed(1)}% PE</span>
            </div>
          </div>
          <div className="text-center">
            <p className="text-[10px] uppercase text-muted-foreground tracking-widest">Total PE OI</p>
            <p className="text-lg font-mono font-bold text-green-500 mt-1">{totalPeOi.toFixed(1)}L</p>
          </div>
        </div>
      </div>

      {/* FINAL AI DECISION */}
      <div className="relative bg-card border border-border rounded-xl overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2 text-[10px] font-bold text-foreground tracking-widest uppercase">
            <Activity className="w-3 h-3 text-primary" />
            FINAL AI DECISION
            <span className="text-muted-foreground ml-2 font-mono text-[9px] lowercase">
              live at {new Date().toLocaleTimeString()}
            </span>
          </div>
          <div className={cn("text-[10px] font-bold tracking-widest border px-3 py-1 rounded-full uppercase", signalColor, signalBorder, signalBgMuted)}>
            REGIME: {decision.regime}
          </div>
        </div>
        
        <div className="p-6">
           <div className="flex justify-between items-end mb-4">
             <div>
               <p className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1">SIGNAL</p>
               <div className="flex items-center gap-3">
                 <ArrowRight className={cn("w-6 h-6", signalColor)} />
                 <h2 className={cn("text-3xl font-black tracking-wide uppercase", signalColor)}>{decision.signal}</h2>
               </div>
             </div>
             <div className="text-right">
               <h2 className={cn("text-3xl font-mono font-bold", signalColor)}>{decision.confidence.toFixed(0)}%</h2>
               <p className={cn("text-[9px] tracking-widest uppercase", signalColor, "opacity-50")}>CONFIDENCE</p>
             </div>
           </div>

           <div className="relative h-2 w-full bg-muted mb-10 overflow-visible mt-6 rounded-full">
             <div className={cn("absolute top-0 left-0 h-full rounded-l-full", decision.confidence === 100 ? "rounded-r-full" : "rounded-r-none", signalBg)} style={{width: `${decision.confidence}%`}}></div>
             <div className="absolute -top-1 bottom-[-4px] w-0.5 bg-muted-foreground" style={{left: '65%'}}></div>
             <p className="absolute top-4 text-[9px] text-muted-foreground whitespace-nowrap" style={{left: '65%', transform: 'translateX(-50%)'}}>65% entry threshold</p>
             <p className="absolute top-4 right-0 text-[10px] text-muted-foreground font-mono">100%</p>
             <p className="absolute top-4 left-0 text-[10px] text-muted-foreground font-mono">0%</p>
           </div>

           {/* Biases Split */}
           <div className="grid grid-cols-2 gap-4 md:gap-8 mb-6 md:mb-8">
             <div className="space-y-4">
                <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground tracking-widest border-b border-0 pb-2">
                   <TrendingUp className="w-3 h-3" /> TA CONTEXT
                </div>
                <div className="flex items-center gap-2">
                   <span className={cn("font-bold", taBiasColor)}>{taBiasText}</span>
                   <span className="text-muted-foreground text-xs font-mono ml-2">Score: {Math.max(decision.bullScore, decision.bearScore)}</span>
                </div>
             </div>
             <div className="space-y-4">
                <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground tracking-widest border-b border-0 pb-2">
                   <Activity className="w-3 h-3" /> OI ZONES
                </div>
                <div className="flex items-center gap-2">
                   <span className="text-muted-foreground text-xs font-mono">S {supportZone?.strikePrice} — R {resistanceZone?.strikePrice}</span>
                </div>
             </div>
           </div>

           <div className="space-y-4 text-xs font-mono bg-secondary/30 dark:bg-black/20 p-5 rounded-xl border border-border">
             <div className="grid grid-cols-[130px_1fr] items-center gap-4">
               <span className="text-primary uppercase tracking-wider font-bold text-[10px] bg-primary/10 px-2 py-1 rounded w-fit">ENTRY</span>
               <span className="text-muted-foreground font-sans">{decision.entry}</span>
             </div>
             <div className="grid grid-cols-[130px_1fr] items-center gap-4">
               <span className="text-primary uppercase tracking-wider font-bold text-[10px] bg-primary/10 px-2 py-1 rounded w-fit">STOP LOSS</span>
               <span className="text-muted-foreground font-sans">{decision.stopLoss}</span>
             </div>
             <div className="grid grid-cols-[130px_1fr] items-center gap-4">
               <span className="text-primary uppercase tracking-wider font-bold text-[10px] bg-primary/10 px-2 py-1 rounded w-fit">TARGET 1</span>
               <span className="text-muted-foreground font-sans">{decision.target1}</span>
             </div>
             <div className="grid grid-cols-[130px_1fr] items-center gap-4">
               <span className="text-primary uppercase tracking-wider font-bold text-[10px] bg-primary/10 px-2 py-1 rounded w-fit flex gap-1">INVALIDATION</span>
               <span className="text-muted-foreground font-sans">{decision.invalidation}</span>
             </div>
           </div>

           <div className="mt-8">
             <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 font-bold flex items-center gap-1">REASON</p>
             <ul className="text-xs text-muted-foreground leading-relaxed list-disc list-inside space-y-1">
                {decision.reasons.map((r, i) => <li key={i}>{r}</li>)}
             </ul>
           </div>
        </div>
      </div>

      {/* TREND SUMMARY */}
      <div className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground tracking-widest uppercase pt-2">
        <Activity className="w-3 h-3 text-primary" />
        TREND SUMMARY
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
        <Card className="bg-card border border-border p-6 rounded-xl flex flex-col justify-center">
          <p className="text-[10px] tracking-widest uppercase text-muted-foreground font-bold mb-2">Market Regime</p>
          <p className="text-xl font-bold uppercase text-foreground">{decision.regime}</p>
        </Card>

        <Card className="bg-card border border-border p-6 rounded-xl flex flex-col justify-center">
          <p className="text-[10px] tracking-widest uppercase text-muted-foreground font-bold mb-2">Trend Direction</p>
          <p className={cn("text-xl font-bold uppercase", trendDirection === 'Bullish' ? "text-green-500" : trendDirection === 'Bearish' ? "text-red-500" : "text-primary")}>{trendDirection}</p>
          <p className="text-xs text-muted-foreground mt-1">{trendExplanation}</p>
        </Card>

        <Card className="bg-card border border-border p-6 rounded-xl flex flex-col justify-center">
          <p className="text-[10px] tracking-widest uppercase text-muted-foreground font-bold mb-2">Trend Strength</p>
          <p className="text-xl font-bold text-foreground">{trendStrength} <span className="text-sm font-mono text-muted-foreground ml-1">(ADX {adx.toFixed(1)})</span></p>
          <div className="flex items-center gap-2 mt-2">
            <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", combinedSummaryColor)}></span>
            <p className="text-xs font-bold uppercase text-foreground">{combinedSummaryText}</p>
          </div>
        </Card>
      </div>

      {/* TECH INDICATORS TITLE */}
      <div className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground tracking-widest uppercase pt-2">
         <BarChart2 className="w-3 h-3 text-primary" />
         SUPPORTING EVIDENCE
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6">
         {/* PCR */}
         <Card className="bg-card border border-border p-6 rounded-xl flex flex-col items-center justify-center text-center">
            <p className="text-[10px] tracking-widest uppercase text-muted-foreground font-bold mb-4">PCR Context</p>
            <p className={cn("text-4xl font-mono font-bold", pcr < 0.7 ? "text-red-500" : pcr > 1.2 ? "text-green-500" : "text-primary")}>{pcr.toFixed(2)}</p>
            <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground mt-2">{pcr < 0.7 ? "Oversold" : pcr > 1.2 ? "Overbought" : "Neutral"}</p>
         </Card>

         {/* Max Pain */}
         <Card className="bg-card border border-border p-6 rounded-xl flex flex-col justify-center items-center text-center">
            <p className="text-[10px] tracking-widest uppercase text-muted-foreground font-bold mb-3">MAX PAIN LEVEL</p>
            <p className="text-4xl font-mono font-bold text-foreground mb-2 mt-auto">{maxPain}</p>
            {Math.abs(spot - maxPain) <= 300 ? (
              <>
                <p className="text-[11px] text-muted-foreground mb-1">Spot is <span className={cn("font-bold", spot > maxPain ? "text-green-500" : "text-red-500")}>{Math.abs(spot - maxPain).toFixed(0)} pts</span> {spot > maxPain ? "above" : "below"}</p>
                <p className="text-[9px] uppercase tracking-widest text-primary font-bold mt-1">Intraday Relevant</p>
              </>
            ) : (
              <>
                <p className="text-[11px] text-muted-foreground mb-1">Max Pain far from spot ({Math.abs(spot - maxPain).toFixed(0)} pts)</p>
                <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-bold mt-1">Influence: Weak for intraday</p>
              </>
            )}
         </Card>

         {/* RSI */}
         <Card className="bg-card border border-border p-6 rounded-xl flex flex-col justify-center items-center">
            <p className="text-[10px] tracking-widest uppercase text-muted-foreground font-bold mb-6">RSI (14, 15m)</p>
            <p className={cn("text-4xl font-mono font-bold", taData.rsi > 60 ? "text-green-500" : taData.rsi < 40 ? "text-red-500" : "text-primary")}>
              {taData.rsi.toFixed(1)}
            </p>
            <ul className="text-[11px] text-muted-foreground mt-4 text-center">
              <li>{taData.rsiZoneShift || (taData.rsi > 60 ? "Overbought Zone" : taData.rsi < 40 ? "Oversold Zone" : "Transition Zone")}</li>
            </ul>
         </Card>
      </div>

    </div>
  );
}
