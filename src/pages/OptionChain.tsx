import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, TrendingDown, TrendingUp, AlertCircle, ArrowRight, Layers, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { addWsMessageListener } from '../hooks/useWebSocket';

export function OptionChain() {
  const [selectedExpiry, setSelectedExpiry] = useState<string>('latest');
  const [liveTicks, setLiveTicks] = useState<Record<number, { ltp: number; oi?: number; volume?: number }>>({});

  useEffect(() => {
    const unsub = addWsMessageListener((msg) => {
      if (msg && msg.type === 'optionTick') {
        const { token, ltp, oi, volume } = msg;
        setLiveTicks((prev) => ({
          ...prev,
          [token]: { ltp, oi, volume }
        }));
      }
    });
    return () => {
      unsub();
    };
  }, []);

  const { data: chain, isLoading: isChainLoading } = useQuery({
    queryKey: ['option-chain', selectedExpiry],
    queryFn: async () => {
      const url = selectedExpiry === 'latest' ? '/api/option-chain' : `/api/option-chain?expiry=${selectedExpiry}`;
      const res = await axios.get(url);
      return res.data;
    },
    refetchInterval: 5000
  });

  const { data: analytics, isLoading: isAnalyticsLoading } = useQuery({
    queryKey: ['analytics'],
    queryFn: async () => {
      const res = await axios.get('/api/analytics');
      return res.data;
    },
    refetchInterval: 5000
  });

  if (isChainLoading || isAnalyticsLoading || !chain || !analytics) {
    return (
      <div className="p-8 space-y-6">
        <Skeleton className="h-12 w-64 bg-card/50 backdrop-blur-md rounded-2xl" />
        <Skeleton className="h-[200px] w-full bg-card/50 backdrop-blur-md rounded-2xl" />
        <Skeleton className="h-[600px] w-full bg-card/50 backdrop-blur-md rounded-3xl" />
      </div>
    );
  }

  const { spot, strikes, ceData, peData, expiryDate } = chain;
  const { pcr, maxPain, topCeStrikes, topPeStrikes, supportZone, resistanceZone, marketBias } = analytics;

  const safeBias = (marketBias || '').toLowerCase();
  const biasColor = safeBias.includes('bull') ? 'text-green-500' : safeBias.includes('bear') ? 'text-red-500' : 'text-primary';
  const biasBorder = safeBias.includes('bull') ? 'border-green-500/30' : safeBias.includes('bear') ? 'border-red-500/30' : 'border-primary/30';

  const breakoutPct = 53;
  const breakdownPct = 55;

  const nextSupport = topPeStrikes[1] || topPeStrikes[0] || { strikePrice: spot, oi: 0 };
  const nextResistance = topCeStrikes[1] || topCeStrikes[0] || { strikePrice: spot, oi: 0 };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
  };
  
  const formattedExpiry = expiryDate ? formatDate(expiryDate) : 'Latest';

  return (
    <div className="p-6 md:p-8 space-y-6 animate-in fade-in duration-700 max-w-[1600px] mx-auto font-sans">
      
      {/* Header */}
      <div className="flex justify-between items-end pb-3 border-b border-0">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">OI Data Levels</h1>
          <p className="text-sm font-medium text-muted-foreground mt-2 flex items-center gap-3">
             <span className="text-foreground font-mono bg-card/80 backdrop-blur-md px-2 py-0.5 rounded-lg border border-0">Spot: {spot.toFixed(2)}</span>
             <span className="text-foreground font-mono bg-card/80 backdrop-blur-md px-2 py-0.5 rounded-lg border border-0">Expiry: {formattedExpiry}</span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Select value={selectedExpiry} onValueChange={(val) => setSelectedExpiry(val)}>
            <SelectTrigger className="w-[155px] bg-card border-0 text-xs h-8 rounded-lg text-foreground">
              <SelectValue placeholder="Expiry" />
            </SelectTrigger>
            <SelectContent className="bg-card border border-0 rounded-xl text-foreground">
              <SelectItem value="latest">Latest ({formattedExpiry})</SelectItem>
              {chain?.expiries?.filter((exp: string) => exp !== expiryDate).map((exp: string) => (
                <SelectItem key={exp} value={exp}>
                  {formatDate(exp)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1 bg-card/80 backdrop-blur-md border border-0 rounded-lg p-1">
             <button className="px-5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground hover:text-foreground rounded-md transition">Min</button>
             <button className="px-5 py-1 text-xs font-medium bg-primary/20 text-primary border border-primary/30 rounded-md transition">Max</button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs mb-2 px-2 uppercase tracking-widest font-bold">
        <span className="flex items-center gap-2 text-muted-foreground"><Activity className="w-3 h-3 text-primary" /> OI + IV Analysis <span className="text-muted-foreground ml-2 font-medium capitalize tracking-normal">Writer Intelligence</span></span>
        <span className="text-muted-foreground flex gap-4">
          <span>SPOT <span className="text-foreground font-mono">{spot.toFixed(2)}</span></span>
          <span className="text-muted-foreground">•</span>
          <span>PCR <span className="text-foreground font-mono">{pcr.toFixed(2)}</span></span>
          <span className="text-muted-foreground">•</span>
          <span>Max Pain <span className="text-foreground font-mono">{maxPain}</span></span>
        </span>
      </div>

      {/* Top Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
         
         {/* Support Zone */}
         <Card className="bg-card backdrop-blur-xl border-green-500/20 p-5 rounded-2xl relative overflow-hidden flex flex-col justify-between">
            <div className="absolute top-0 left-0 w-[4px] h-full bg-green-500/60"></div>
            <div>
              <p className="text-[11px] text-green-500 font-bold uppercase tracking-widest flex items-center gap-1.5 mb-2">
                <TrendingUp className="w-3 h-3" /> STRONGEST SUPPORT ZONE
              </p>
              <div className="flex items-center gap-3 mb-6">
                <p className="text-2xl font-mono font-bold text-green-500">{supportZone?.strikePrice.toLocaleString()}</p>
                <Badge variant="outline" className="bg-green-500/10 text-green-500 border-none rounded-[3px] h-4 px-1 text-[10px]">PE</Badge>
              </div>
              
              <div className="grid grid-cols-3 gap-4 mb-4">
                 <div>
                    <p className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider mb-1">OI</p>
                    <p className="text-sm font-mono text-green-500">{(supportZone?.oi || 0).toFixed(2)}L</p>
                 </div>
                 <div>
                    <p className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider mb-1">IV</p>
                    <p className="text-sm font-mono text-green-500">{(supportZone?.iv || 0).toFixed(1)}%</p>
                 </div>
                 <div>
                    <p className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider mb-1">ΔOI</p>
                    <p className="text-sm font-mono text-green-500">{supportZone?.chgOi > 0 ? '+' : ''}{(supportZone?.chgOi || 0).toFixed(0)}</p>
                 </div>
              </div>
            </div>

            <div className="space-y-1 pt-3 border-t border-green-500/10">
              <p className="text-[11px] text-muted-foreground">Next support: <span className="text-green-500 font-mono font-medium">{nextSupport?.strikePrice} ({(nextSupport?.oi || 0).toFixed(1)}L)</span></p>
              <p className="text-[11px] text-green-500 font-mono flex flex-row items-center gap-1"><ArrowRight className="w-2.5 h-2.5"/> {Math.abs(spot - supportZone?.strikePrice).toFixed(0)} pts {spot > supportZone?.strikePrice ? 'below' : 'above'} spot</p>
            </div>
         </Card>

         {/* Resistance Zone */}
         <Card className="bg-card backdrop-blur-xl border-red-500/20 p-5 rounded-2xl relative overflow-hidden flex flex-col justify-between">
            <div className="absolute top-0 left-0 w-[4px] h-full bg-red-500/60"></div>
            <div>
              <p className="text-[11px] text-red-500 font-bold uppercase tracking-widest flex items-center gap-1.5 mb-2">
                <TrendingDown className="w-3 h-3" /> STRONGEST RESISTANCE ZONE
              </p>
              <div className="flex items-center gap-3 mb-6">
                <p className="text-2xl font-mono font-bold text-red-500">{resistanceZone?.strikePrice.toLocaleString()}</p>
                <Badge variant="outline" className="bg-red-500/10 text-red-500 border-none rounded-[3px] h-4 px-1 text-[10px]">CE</Badge>
              </div>
              
              <div className="grid grid-cols-3 gap-4 mb-4">
                 <div>
                    <p className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider mb-1">OI</p>
                    <p className="text-sm font-mono text-red-500">{(resistanceZone?.oi || 0).toFixed(2)}L</p>
                 </div>
                 <div>
                    <p className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider mb-1">IV</p>
                    <p className="text-sm font-mono text-red-500">{(resistanceZone?.iv || 0).toFixed(1)}%</p>
                 </div>
                 <div>
                    <p className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider mb-1">ΔOI</p>
                    <p className="text-sm font-mono text-red-500">{resistanceZone?.chgOi > 0 ? '+' : ''}{(resistanceZone?.chgOi || 0).toFixed(0)}</p>
                 </div>
              </div>
            </div>

            <div className="space-y-1 pt-3 border-t border-red-500/10">
              <p className="text-[11px] text-muted-foreground">Next resistance: <span className="text-red-500 font-mono font-medium">{nextResistance?.strikePrice} ({(nextResistance?.oi || 0).toFixed(1)}L)</span></p>
              <p className="text-[11px] text-red-500 font-mono flex flex-row items-center gap-1"><ArrowRight className="w-2.5 h-2.5"/> {Math.abs(spot - resistanceZone?.strikePrice).toFixed(0)} pts {spot < resistanceZone?.strikePrice ? 'above' : 'below'} spot</p>
            </div>
         </Card>

         {/* OI Context */}
         <Card className="bg-card backdrop-blur-xl border-0 p-5 rounded-2xl flex flex-col">
            <div className="flex justify-between items-start mb-6">
              <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-primary rounded-sm"></span> OI CONTEXT
              </p>
            </div>
            
            <Badge variant="outline" className={cn("inline-flex w-fit text-[11px] font-bold uppercase tracking-wider mb-8 bg-transparent rounded px-3", biasColor, biasBorder)}>
               Bias: {marketBias.replace("Mildly ", "").replace("Strongly ", "") || "Neutral"}
            </Badge>

            <div className="space-y-6 mt-auto">
              <div>
                <div className="flex justify-between text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
                  <span>Breakout Prob {'>'} {resistanceZone?.strikePrice}</span>
                  <span className="text-green-500 font-mono">{breakoutPct}%</span>
                </div>
                <div className="h-1 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${breakoutPct}%` }}></div>
                </div>
              </div>
              
              <div>
                <div className="flex justify-between text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
                  <span>Breakdown Prob {'<'} {supportZone?.strikePrice}</span>
                  <span className="text-red-500 font-mono">{breakdownPct}%</span>
                </div>
                <div className="h-1 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-red-500 rounded-full" style={{ width: `${breakdownPct}%` }}></div>
                </div>
              </div>
            </div>
         </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
         {/* IV Interpretation */}
         <Card className="bg-card backdrop-blur-xl border-0 p-5 rounded-2xl">
           <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5 mb-5">
              <Activity className="w-3 h-3 text-primary" /> IV CONTEXT
           </p>
           <div className="flex items-center justify-between text-[11px] uppercase text-muted-foreground font-bold tracking-widest mb-2">
             <span className="text-red-500">CE IV {(resistanceZone?.iv || 0).toFixed(1)}%</span>
             <span className="text-primary">Skew 0.0pts</span>
             <span className="text-green-500">PE IV {(supportZone?.iv || 0).toFixed(1)}%</span>
           </div>
           
           <div className="mb-0">
             <p className="text-[11px] font-bold text-primary mb-1 leading-relaxed">
               {(resistanceZone?.iv || 0).toFixed(1)}% vs {(supportZone?.iv || 0).toFixed(1)}% IV — balanced, no directional fear premium
             </p>
           </div>
         </Card>

         {/* OI Interpretation */}
         <Card className="bg-card backdrop-blur-xl border-0 p-5 rounded-2xl">
           <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5 mb-4">
              <Layers className="w-3 h-3 border border-muted-foreground p-0.5 rounded-sm" /> OI CONTEXT
           </p>
           <ul className="space-y-1.5 mt-2 text-xs font-medium leading-relaxed">
              <li className="flex gap-2 p-1.5 px-3 bg-background hover:bg-muted rounded text-red-500 border border-transparent hover:border-red-500/10 transition-colors">
                <span className="text-muted-foreground">{'>'}</span> {resistanceZone?.strikePrice} CE resistance — {(resistanceZone?.oi || 0).toFixed(1)}L OI, writers active
              </li>
              <li className="flex gap-2 p-1.5 px-3 bg-background hover:bg-muted rounded text-green-500 border border-transparent hover:border-green-500/10 transition-colors">
                <span className="text-muted-foreground">{'>'}</span> {supportZone?.strikePrice} PE support — {(supportZone?.oi || 0).toFixed(1)}L OI, writers active
              </li>
           </ul>
         </Card>
      </div>

      {/* Writers Chart (Visual Layout Mockup) */}
      <div className="grid grid-cols-2 gap-px bg-card backdrop-blur-xl border border-0 rounded-2xl overflow-hidden">
        
        {/* Call Writers */}
        <div className="bg-transparent p-5 pb-8 relative">
           <div className="absolute inset-0 bg-gradient-to-r from-red-500/5 to-transparent opacity-50"></div>
           <div className="flex justify-between items-center mb-6">
              <p className="text-[11px] font-bold uppercase tracking-widest text-red-500 flex gap-1.5 items-center"><Target className="w-3 h-3" /> CALL WRITERS (RESISTANCE)</p>
              <p className="text-[11px] text-muted-foreground">5 strikes</p>
           </div>
           
           <div className="space-y-1.5 relative pr-[40px]">
              {topCeStrikes.map((s: any, idx: number) => {
                 const maxOi = topCeStrikes[0]?.oi || 1;
                 const pct = ((s?.oi || 0) / maxOi) * 100;
                 return (
                 <div key={s?.strikePrice} className="flex flex-row-reverse justify-start items-center h-[28px] relative group cursor-pointer">
                    <div className="bg-red-500/10 border border-red-500/20 h-full rounded-l-full transition-all group-hover:bg-red-500/20 absolute right-0" style={{ width: `${pct}%` }}></div>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-right">
                       <p className="text-[11px] text-red-400 font-mono mb-[1px] leading-none">{(s?.oi || 0).toFixed(1)}L OI</p>
                       <p className="text-[10px] text-muted-foreground leading-none text-right">IV —%</p>
                    </div>
                    <div className="flex items-center gap-2 absolute left-[-20px] top-1/2 -translate-y-1/2 font-mono text-[11px] font-bold text-muted-foreground z-10 w-[140px] pl-6">
                       <span className="text-muted-foreground w-3">{idx + 1}.</span> 
                       <span className="text-red-400 text-[11px]">{s?.strikePrice}</span>
                       {s?.strikePrice === resistanceZone?.strikePrice && <Badge className="h-3.5 text-[10px] px-1 rounded-[2px] bg-popover border border-0 text-muted-foreground ml-1">ATM zone</Badge>}
                    </div>
                 </div>
              )})}
           </div>
        </div>

        {/* Put Writers */}
        <div className="bg-transparent p-5 pb-8 relative">
           <div className="absolute inset-0 bg-gradient-to-l from-green-500/5 to-transparent opacity-50"></div>
           <div className="flex justify-between items-center mb-6 pl-[40px]">
              <p className="text-[11px] font-bold uppercase tracking-widest text-green-500 flex gap-1.5 items-center"><Target className="w-3 h-3" /> PUT WRITERS (SUPPORT)</p>
              <p className="text-[11px] text-muted-foreground">5 strikes</p>
           </div>
           
           <div className="space-y-1.5 relative pl-[40px]">
              {topPeStrikes.map((s: any, idx: number) => {
                 const maxOi = topPeStrikes[0]?.oi || 1;
                 const pct = ((s?.oi || 0) / maxOi) * 100;
                 return (
                 <div key={s?.strikePrice} className="flex justify-start items-center h-[28px] relative group cursor-pointer">
                    <div className="bg-green-500/10 border border-green-500/20 h-full rounded-r-full transition-all group-hover:bg-green-500/20 absolute left-0" style={{ width: `${pct}%` }}></div>
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-left">
                       <p className="text-[11px] text-green-400 font-mono mb-[1px] leading-none">{(s?.oi || 0).toFixed(1)}L OI</p>
                       <p className="text-[10px] text-muted-foreground leading-none">IV —%</p>
                    </div>
                    
                    <div className="flex flex-row-reverse items-center justify-end gap-2 absolute right-[-20px] top-1/2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground font-bold z-10 w-[140px] pr-6">
                       <span className="text-muted-foreground w-3 text-right">.{idx + 1}</span> 
                       <span className="text-green-400 text-[11px]">{s?.strikePrice}</span>
                       {s?.strikePrice === supportZone?.strikePrice && <Badge className="h-3.5 text-[10px] px-1 rounded-[2px] bg-popover border border-0 text-muted-foreground mr-1">ATM zone</Badge>}
                    </div>
                 </div>
              )})}
           </div>
        </div>
      </div>
      
      {/* Legend */}
      <div className="flex flex-wrap gap-2 text-[11px]">
         <div className="px-2 py-0.5 rounded border border-green-500/30 text-green-500 bg-green-500/10 font-bold uppercase tracking-wider">Long Buildup</div>
         <div className="px-2 py-0.5 rounded border border-red-500/30 text-red-500 bg-red-500/10 font-bold uppercase tracking-wider">Short Buildup</div>
         <div className="px-2 py-0.5 rounded border border-green-400/30 text-green-400 bg-green-400/10 font-bold uppercase tracking-wider">Short Covering</div>
         <div className="px-2 py-0.5 rounded border border-primary/30 text-primary bg-primary/10 font-bold uppercase tracking-wider">Long Unwind</div>
         <div className="px-2 py-0.5 rounded border border-orange-500/30 text-orange-500 bg-orange-500/10 font-bold uppercase tracking-wider">Call Unwind</div>
         <div className="px-2 py-0.5 rounded border border-primary/30 text-primary bg-primary/10 font-bold uppercase tracking-wider">Put Unwind</div>
      </div>

      {/* Option Chain Table */}
      <div className="bg-card backdrop-blur-xl border border-0 rounded-2xl overflow-hidden mt-6">
        <div className="overflow-x-auto scroller-hidden">
          <Table className="w-full text-xs">
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className="text-center text-red-500 font-bold uppercase tracking-widest text-[11px]" colSpan={4}>CALLS (CE)</TableHead>
                <TableHead className="text-center font-bold uppercase tracking-widest text-[11px] bg-emerald-100 text-emerald-850 dark:bg-emerald-950/40 dark:text-emerald-300 border-x border-0" colSpan={2}>STRIKE & IV</TableHead>
                <TableHead className="text-center text-green-500 font-bold uppercase tracking-widest text-[11px]" colSpan={4}>PUTS (PE)</TableHead>
              </TableRow>
              <TableRow className="border-0 bg-muted/40 dark:bg-black/20 hover:bg-muted/40 dark:hover:bg-black/20">
                <TableHead className="text-center w-16 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1">OI Chg%</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1">OI-lakh</TableHead>
                <TableHead className="text-center w-24 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1 flex items-center justify-end gap-2 px-2">Call OI <div className="w-4 h-1.5 rounded-full bg-red-500"></div></TableHead>
                <TableHead className="text-center w-20 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1 border-r border-0">LTP</TableHead>
                
                <TableHead className="text-center bg-emerald-50/70 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-350 w-20 h-8 p-1 border-l border-0 text-[11px] uppercase font-semibold">Strike &darr;</TableHead>
                <TableHead className="text-center bg-emerald-50/70 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-350 w-16 h-8 p-1 border-r border-0 text-[11px] uppercase font-semibold">IV</TableHead>
                
                <TableHead className="text-center w-20 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1 border-l border-0">LTP</TableHead>
                <TableHead className="text-center w-24 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1 flex items-center gap-2 px-2">Put OI <div className="w-4 h-1.5 rounded-full bg-green-500"></div></TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1">OI-lakh</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-medium text-muted-foreground h-8 p-1">OI Chg%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono">
              {(() => {
                const maxTableOi = Math.max(1, ...strikes.map((s: number) => {
                  const ce = ceData[s];
                  const pe = peData[s];
                  const ceLive = ce?.instrument_token ? liveTicks[ce.instrument_token] : null;
                  const peLive = pe?.instrument_token ? liveTicks[pe.instrument_token] : null;
                  const ceOiVal = ceLive?.oi !== undefined ? (ceLive.oi / 100000) : (ce?.oi || 0);
                  const peOiVal = peLive?.oi !== undefined ? (peLive.oi / 100000) : (pe?.oi || 0);
                  return Math.max(ceOiVal, peOiVal);
                }));

                return strikes.map((strike: number) => {
                  const ce = ceData[strike];
                  const pe = peData[strike];
                  
                  const ceLive = ce?.instrument_token ? liveTicks[ce.instrument_token] : null;
                  const peLive = pe?.instrument_token ? liveTicks[pe.instrument_token] : null;

                  const ceLtp = ceLive?.ltp !== undefined ? ceLive.ltp : (ce?.ltp || 0);
                  const peLtp = peLive?.ltp !== undefined ? peLive.ltp : (pe?.ltp || 0);

                  const ceOiValue = ceLive?.oi !== undefined ? (ceLive.oi / 100000) : (ce?.oi || 0);
                  const peOiValue = peLive?.oi !== undefined ? (peLive.oi / 100000) : (pe?.oi || 0);

                  const isAtm = Math.abs(strike - spot) < 25;
                  const isItmCE = strike < spot;
                  const isItmPE = strike > spot;
                  
                  const getSentimentChgOiClass = (chgOi: number) => {
                    const oiP = chgOi || 0;
                    if (oiP > 0) return 'text-green-500';
                    if (oiP < 0) return 'text-red-500';
                    return 'text-muted-foreground';
                  };

                  const cePct = (ceOiValue / maxTableOi) * 100;
                  const pePct = (peOiValue / maxTableOi) * 100;
                  
                  const getChgPct = (oiP?: number, chgOiP?: number) => {
                    const oi = oiP || 0;
                    const chgOi = chgOiP || 0;
                    if (oi === 0 || chgOi === 0) return 0;
                    const prevOi = oi - chgOi;
                    if (prevOi <= 0) return 100;
                    return (chgOi / prevOi) * 100;
                  };

                  const ceChgPct = getChgPct(ce?.oi, ce?.chgOi);
                  const peChgPct = getChgPct(pe?.oi, pe?.chgOi);

                  return (
                    <TableRow key={strike} className={cn("border-b border-0 hover:bg-popover transition-colors group",
                      isAtm ? "bg-popover" : ""
                    )}>
                      {/* Calls */}
                      <TableCell className={cn("text-center text-xs p-2", getSentimentChgOiClass(ce?.chgOi))}>{Math.round(ceChgPct)}%</TableCell>
                      <TableCell className={cn("text-center text-xs p-2", isItmCE ? "text-foreground" : "text-muted-foreground")}>{ceOiValue.toFixed(1)}</TableCell>
                      <TableCell className={cn("p-0 min-w-[60px] relative")}>
                        {isItmCE && <div className="absolute inset-0 bg-red-500/[0.03] pointer-events-none"></div>}
                        <div className="h-full w-full flex justify-end items-center px-1">
                          <div className="h-[20px] bg-red-500/20 rounded-l-[2px]" style={{ width: `${cePct}%` }}></div>
                        </div>
                      </TableCell>
                      <TableCell className={cn("text-center font-medium text-[11px] p-2 border-r border-0", isItmCE ? "bg-red-500/[0.04] text-foreground" : "text-muted-foreground")}>
                        {ceLtp.toFixed(2)}
                      </TableCell>
                      
                      {/* Strike */}
                      <TableCell className="text-center font-bold bg-popover border-x border-0 p-2 group-hover:bg-accent transition-colors relative">
                        <span className="text-[13px]">{strike}</span>
                        {isAtm && <div className="absolute top-0 right-0 h-full w-[2px] bg-primary"></div>}
                      </TableCell>
                      
                      <TableCell className="text-center text-xs text-muted-foreground p-2 border-r border-0 bg-popover group-hover:bg-accent">
                        {(ce?.iv || pe?.iv || 0).toFixed(1)}
                      </TableCell>
                      
                      {/* Puts */}
                      <TableCell className={cn("text-center font-medium text-[11px] p-2 border-l border-0", isItmPE ? "bg-green-500/[0.04] text-foreground" : "text-muted-foreground")}>
                        {peLtp.toFixed(2)}
                      </TableCell>
                      <TableCell className={cn("p-0 min-w-[60px] relative")}>
                        {isItmPE && <div className="absolute inset-0 bg-green-500/[0.03] pointer-events-none"></div>}
                        <div className="h-full w-full flex justify-start items-center px-1">
                          <div className="h-[20px] bg-green-500/20 rounded-r-[2px]" style={{ width: `${pePct}%` }}></div>
                        </div>
                      </TableCell>
                      <TableCell className={cn("text-center text-xs p-2", isItmPE ? "text-foreground" : "text-muted-foreground")}>{peOiValue.toFixed(1)}</TableCell>
                      <TableCell className={cn("text-center text-xs p-2", getSentimentChgOiClass(pe?.chgOi))}>{Math.round(peChgPct)}%</TableCell>
                    </TableRow>
                  );
                });
              })()}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
