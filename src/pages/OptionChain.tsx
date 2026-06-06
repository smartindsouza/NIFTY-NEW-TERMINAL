import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, TrendingDown, TrendingUp, AlertCircle, ArrowRight, Layers, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function OptionChain() {
  const [selectedExpiry, setSelectedExpiry] = useState<string>('latest');

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
  const biasColor = safeBias.includes('bull') ? 'text-green-500' : safeBias.includes('bear') ? 'text-red-500' : 'text-yellow-500';
  const biasBorder = safeBias.includes('bull') ? 'border-green-500/30' : safeBias.includes('bear') ? 'border-red-500/30' : 'border-yellow-500/30';

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
    <div className="p-6 md:p-8 space-y-6 animate-in fade-in duration-700 max-w-[1200px] mx-auto font-sans">
      
      {/* Header */}
      <div className="flex justify-between items-end pb-3 border-b border-border">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">OI Data Levels</h1>
          <p className="text-sm font-medium text-muted-foreground mt-2 flex items-center gap-3">
             <span className="text-foreground font-mono bg-card/80 backdrop-blur-md px-2 py-0.5 rounded-lg border border-border">Spot: {spot.toFixed(2)}</span>
             <span className="text-foreground font-mono bg-card/80 backdrop-blur-md px-2 py-0.5 rounded-lg border border-border">Expiry: {formattedExpiry}</span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Select value={selectedExpiry} onValueChange={(val) => setSelectedExpiry(val)}>
            <SelectTrigger className="w-[155px] bg-[#1a1c24] border-border text-xs h-8 rounded-lg text-white">
              <SelectValue placeholder="Expiry" />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1c24] border border-slate-700 rounded-xl text-white">
              <SelectItem value="latest">Latest ({formattedExpiry})</SelectItem>
              {chain?.expiries?.filter((exp: string) => exp !== expiryDate).map((exp: string) => (
                <SelectItem key={exp} value={exp}>
                  {formatDate(exp)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1 bg-card/80 backdrop-blur-md border border-border rounded-lg p-1">
             <button className="px-5 py-1 text-xs font-medium text-muted-foreground hover:bg-white/5 hover:text-foreground rounded-md transition">Min</button>
             <button className="px-5 py-1 text-xs font-medium bg-primary/20 text-primary border border-primary/30 rounded-md shadow-[0_0_10px_rgba(59,130,246,0.2)] transition">Max</button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs mb-2 px-2 uppercase tracking-widest font-bold">
        <span className="flex items-center gap-2 text-muted-foreground"><Activity className="w-3 h-3 text-blue-500" /> OI + IV Analysis <span className="text-[#4a5568] ml-2 font-medium capitalize tracking-normal">Writer Intelligence</span></span>
        <span className="text-muted-foreground flex gap-4">
          <span>SPOT <span className="text-foreground font-mono">{spot.toFixed(2)}</span></span>
          <span className="text-[#4a5568]">•</span>
          <span>PCR <span className="text-foreground font-mono">{pcr.toFixed(2)}</span></span>
          <span className="text-[#4a5568]">•</span>
          <span>Max Pain <span className="text-foreground font-mono">{maxPain}</span></span>
        </span>
      </div>

      {/* Top Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
         
         {/* Support Zone */}
         <Card className="bg-card backdrop-blur-xl border-green-500/20 shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] p-5 rounded-2xl relative overflow-hidden flex flex-col justify-between">
            <div className="absolute top-0 left-0 w-[4px] h-full bg-green-500/60 shadow-[0_0_15px_rgba(34,197,94,0.6)]"></div>
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
              <p className="text-[11px] text-[#8e909c]">Next support: <span className="text-green-500 font-mono font-medium">{nextSupport?.strikePrice} ({(nextSupport?.oi || 0).toFixed(1)}L)</span></p>
              <p className="text-[11px] text-green-500 font-mono flex flex-row items-center gap-1"><ArrowRight className="w-2.5 h-2.5"/> {Math.abs(spot - supportZone?.strikePrice).toFixed(0)} pts {spot > supportZone?.strikePrice ? 'below' : 'above'} spot</p>
            </div>
         </Card>

         {/* Resistance Zone */}
         <Card className="bg-card backdrop-blur-xl border-red-500/20 shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] p-5 rounded-2xl relative overflow-hidden flex flex-col justify-between">
            <div className="absolute top-0 left-0 w-[4px] h-full bg-red-500/60 shadow-[0_0_15px_rgba(239,68,68,0.6)]"></div>
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
              <p className="text-[11px] text-[#8e909c]">Next resistance: <span className="text-red-500 font-mono font-medium">{nextResistance?.strikePrice} ({(nextResistance?.oi || 0).toFixed(1)}L)</span></p>
              <p className="text-[11px] text-red-500 font-mono flex flex-row items-center gap-1"><ArrowRight className="w-2.5 h-2.5"/> {Math.abs(spot - resistanceZone?.strikePrice).toFixed(0)} pts {spot < resistanceZone?.strikePrice ? 'above' : 'below'} spot</p>
            </div>
         </Card>

         {/* OI Context */}
         <Card className="bg-card backdrop-blur-xl border-border shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] p-5 rounded-2xl flex flex-col">
            <div className="flex justify-between items-start mb-6">
              <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-yellow-500 rounded-sm"></span> OI CONTEXT
              </p>
            </div>
            
            <Badge variant="outline" className={cn("inline-flex w-fit text-[11px] font-bold uppercase tracking-wider mb-8 bg-transparent rounded shadow-none px-3", biasColor, biasBorder)}>
               Bias: {marketBias.replace("Mildly ", "").replace("Strongly ", "") || "Neutral"}
            </Badge>

            <div className="space-y-6 mt-auto">
              <div>
                <div className="flex justify-between text-[11px] font-bold uppercase tracking-widest text-[#8e909c] mb-1.5">
                  <span>Breakout Prob {'>'} {resistanceZone?.strikePrice}</span>
                  <span className="text-green-500 font-mono">{breakoutPct}%</span>
                </div>
                <div className="h-1 bg-[#1c1e26] rounded-full overflow-hidden">
                  <div className="h-full bg-green-500" style={{ width: `${breakoutPct}%` }}></div>
                </div>
              </div>
              
              <div>
                <div className="flex justify-between text-[11px] font-bold uppercase tracking-widest text-[#8e909c] mb-1.5">
                  <span>Breakdown Prob {'<'} {supportZone?.strikePrice}</span>
                  <span className="text-red-500 font-mono">{breakdownPct}%</span>
                </div>
                <div className="h-1 bg-[#1c1e26] rounded-full overflow-hidden">
                  <div className="h-full bg-red-500" style={{ width: `${breakdownPct}%` }}></div>
                </div>
              </div>
            </div>
         </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
         {/* IV Interpretation */}
         <Card className="bg-card backdrop-blur-xl border-border shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] p-5 rounded-2xl">
           <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5 mb-5">
              <Activity className="w-3 h-3 text-yellow-500" /> IV CONTEXT
           </p>
           <div className="flex items-center justify-between text-[11px] uppercase text-muted-foreground font-bold tracking-widest mb-2">
             <span className="text-red-500">CE IV {(resistanceZone?.iv || 0).toFixed(1)}%</span>
             <span className="text-yellow-500">Skew 0.0pts</span>
             <span className="text-green-500">PE IV {(supportZone?.iv || 0).toFixed(1)}%</span>
           </div>
           
           <div className="mb-0">
             <p className="text-[11px] font-bold text-yellow-500 mb-1 leading-relaxed">
               {(resistanceZone?.iv || 0).toFixed(1)}% vs {(supportZone?.iv || 0).toFixed(1)}% IV — balanced, no directional fear premium
             </p>
           </div>
         </Card>

         {/* OI Interpretation */}
         <Card className="bg-card backdrop-blur-xl border-border shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] p-5 rounded-2xl">
           <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5 mb-4">
              <Layers className="w-3 h-3 border border-muted-foreground p-0.5 rounded-sm" /> OI CONTEXT
           </p>
           <ul className="space-y-1.5 mt-2 text-xs font-medium leading-relaxed">
              <li className="flex gap-2 p-1.5 px-3 bg-[#13151a] hover:bg-[#1c1e26] rounded text-red-500 border border-transparent hover:border-red-500/10 transition-colors">
                <span className="text-[#8e909c]">{'>'}</span> {resistanceZone?.strikePrice} CE resistance — {(resistanceZone?.oi || 0).toFixed(1)}L OI, writers active
              </li>
              <li className="flex gap-2 p-1.5 px-3 bg-[#13151a] hover:bg-[#1c1e26] rounded text-green-500 border border-transparent hover:border-green-500/10 transition-colors">
                <span className="text-[#8e909c]">{'>'}</span> {supportZone?.strikePrice} PE support — {(supportZone?.oi || 0).toFixed(1)}L OI, writers active
              </li>
           </ul>
         </Card>
      </div>

      {/* Writers Chart (Visual Layout Mockup) */}
      <div className="grid grid-cols-2 gap-px bg-card backdrop-blur-xl border border-border shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] rounded-2xl overflow-hidden">
        
        {/* Call Writers */}
        <div className="bg-transparent p-5 pb-8 relative">
           <div className="absolute inset-0 bg-gradient-to-r from-red-500/5 to-transparent opacity-50"></div>
           <div className="flex justify-between items-center mb-6">
              <p className="text-[11px] font-bold uppercase tracking-widest text-red-500 flex gap-1.5 items-center"><Target className="w-3 h-3" /> CALL WRITERS (RESISTANCE)</p>
              <p className="text-[11px] text-[#8e909c]">5 strikes</p>
           </div>
           
           <div className="space-y-1.5 relative pr-[40px]">
              {topCeStrikes.map((s: any, idx: number) => {
                 const maxOi = topCeStrikes[0]?.oi || 1;
                 const pct = ((s?.oi || 0) / maxOi) * 100;
                 return (
                 <div key={s?.strikePrice} className="flex flex-row-reverse justify-start items-center h-[28px] relative group cursor-pointer">
                    <div className="bg-[#ef4444]/10 border border-red-500/20 h-full rounded-l-[1px] transition-all group-hover:bg-[#ef4444]/20 absolute right-0" style={{ width: `${pct}%` }}></div>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-right">
                       <p className="text-[11px] text-red-400 font-mono mb-[1px] leading-none">{(s?.oi || 0).toFixed(1)}L OI</p>
                       <p className="text-[10px] text-[#8e909c] leading-none text-right">IV —%</p>
                    </div>
                    <div className="flex items-center gap-2 absolute left-[-20px] top-1/2 -translate-y-1/2 font-mono text-[11px] font-bold text-muted-foreground z-10 w-[140px] pl-6 bg-[#13151a]">
                       <span className="text-[#8e909c] w-3">{idx + 1}.</span> 
                       <span className="text-red-400 text-[11px]">{s?.strikePrice}</span>
                       {s?.strikePrice === resistanceZone?.strikePrice && <Badge className="h-3.5 text-[10px] px-1 rounded-[2px] bg-[#1a1b23] border border-[#2d3139] text-muted-foreground shadow-none ml-1">ATM zone</Badge>}
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
              <p className="text-[11px] text-[#8e909c]">5 strikes</p>
           </div>
           
           <div className="space-y-1.5 relative pl-[40px]">
              {topPeStrikes.map((s: any, idx: number) => {
                 const maxOi = topPeStrikes[0]?.oi || 1;
                 const pct = ((s?.oi || 0) / maxOi) * 100;
                 return (
                 <div key={s?.strikePrice} className="flex justify-start items-center h-[28px] relative group cursor-pointer">
                    <div className="bg-green-500/10 border border-green-500/20 h-full rounded-r-[1px] transition-all group-hover:bg-green-500/20 absolute left-0" style={{ width: `${pct}%` }}></div>
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-left">
                       <p className="text-[11px] text-green-400 font-mono mb-[1px] leading-none">{(s?.oi || 0).toFixed(1)}L OI</p>
                       <p className="text-[10px] text-[#8e909c] leading-none">IV —%</p>
                    </div>
                    
                    <div className="flex flex-row-reverse items-center justify-end gap-2 absolute right-[-20px] top-1/2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground font-bold z-10 w-[140px] pr-6 bg-[#13151a]">
                       <span className="text-[#8e909c] w-3 text-right">.{idx + 1}</span> 
                       <span className="text-green-400 text-[11px]">{s?.strikePrice}</span>
                       {s?.strikePrice === supportZone?.strikePrice && <Badge className="h-3.5 text-[10px] px-1 rounded-[2px] bg-[#1a1b23] border border-[#2d3139] text-muted-foreground shadow-none mr-1">ATM zone</Badge>}
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
         <div className="px-2 py-0.5 rounded border border-yellow-500/30 text-yellow-500 bg-yellow-500/10 font-bold uppercase tracking-wider">Long Unwind</div>
         <div className="px-2 py-0.5 rounded border border-orange-500/30 text-orange-500 bg-orange-500/10 font-bold uppercase tracking-wider">Call Unwind</div>
         <div className="px-2 py-0.5 rounded border border-purple-500/30 text-purple-500 bg-purple-500/10 font-bold uppercase tracking-wider">Put Unwind</div>
      </div>

      {/* Option Chain Table */}
      <div className="bg-card backdrop-blur-xl border border-border shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] rounded-2xl overflow-hidden mt-6">
        <div className="overflow-x-auto scroller-hidden">
          <Table className="w-full text-xs">
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-center text-red-500 font-bold uppercase tracking-widest text-[11px]" colSpan={5}>CALLS (CE)</TableHead>
                <TableHead className="text-center font-bold uppercase tracking-widest text-[11px] bg-white/5 border-x border-border text-foreground">STRIKE</TableHead>
                <TableHead className="text-center text-green-500 font-bold uppercase tracking-widest text-[11px]" colSpan={5}>PUTS (PE)</TableHead>
              </TableRow>
              <TableRow className="border-border bg-black/20 hover:bg-black/20">
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">OI</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">Chg OI</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">Vol</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">IV%</TableHead>
                <TableHead className="text-center w-20 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1 border-r border-[#2d3139]/50">LTP</TableHead>
                
                <TableHead className="text-center bg-transparent border-x border-border w-24 h-8 p-1"></TableHead>
                
                <TableHead className="text-center w-20 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1 border-l border-[#2d3139]/50">LTP</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">IV%</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">Vol</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">Chg OI</TableHead>
                <TableHead className="text-center w-16 text-[11px] uppercase font-bold text-muted-foreground h-8 p-1">OI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono">
              {strikes.map((strike: number) => {
                const ce = ceData[strike];
                const pe = peData[strike];
                const isAtm = Math.abs(strike - spot) < 25;
                // Based on UI screenshot, calls ITM are lighter shade on calls side, puts ITM are lighter shade on puts side
                const isItmCE = strike < spot;
                const isItmPE = strike > spot;
                
                return (
                  <TableRow key={strike} className={cn("border-b border-[#2d3139] hover:bg-[#1a1b23] transition-colors group",
                    isAtm ? "bg-[#1a1b23] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]" : ""
                  )}>
                    {/* Calls */}
                    <TableCell className={cn("text-center text-xs font-bold p-2", isItmCE ? "text-foreground" : "text-muted-foreground")}>{(ce?.oi || 0).toFixed(1)}L</TableCell>
                    <TableCell className={cn("text-center text-xs p-2", ce?.chgOi > 0 ? 'text-green-500' : 'text-red-500')}>
                      <div>{(ce?.chgOi || 0).toFixed(0)}</div>
                      {isItmCE && ce?.chgOi > 0 && <div className="text-[7px] text-muted-foreground mt-0.5 whitespace-nowrap">ITM HEDGING</div>}
                    </TableCell>
                    <TableCell className={cn("text-center text-xs text-[#8e909c] p-2", isItmCE && "")}>{(ce?.volume/1000 || 0).toFixed(1)}K</TableCell>
                    <TableCell className={cn("text-center text-xs text-muted-foreground p-2", isItmCE && "")}>{(ce?.iv || 0).toFixed(1)}</TableCell>
                    <TableCell className={cn("text-center font-medium text-foreground text-[11px] p-2 border-r border-[#2d3139]/50", isItmCE && "")}>{(ce?.ltp || 0).toFixed(2)}</TableCell>
                    
                    {/* Strike */}
                    <TableCell className="text-center font-bold bg-[#1a1b23] border-x border-[#2d3139] p-2 group-hover:bg-[#252836] transition-colors relative flex flex-col items-center justify-center min-w-[120px]">
                      <span className="text-[12px]">{strike}</span>
                      <span className="text-[8px] text-muted-foreground uppercase mt-0.5 tracking-wider font-sans whitespace-nowrap">
                        {strike === supportZone?.strikePrice ? 'Nearby Support' :
                         strike === resistanceZone?.strikePrice ? 'Nearby Resistance' :
                         Math.abs(strike - spot) > 500 ? 'Far Strike / Ignore' :
                         Math.abs(strike - spot) > 300 ? 'Positional Build-up' :
                         'Intraday Relevant'}
                      </span>
                      {isAtm && <div className="absolute top-0 right-0 h-full w-[2px] bg-yellow-500"></div>}
                    </TableCell>
                    
                    {/* Puts */}
                    <TableCell className={cn("text-center font-medium text-foreground text-[11px] p-2 border-l border-[#2d3139]/50", isItmPE && "")}>{(pe?.ltp || 0).toFixed(2)}</TableCell>
                    <TableCell className={cn("text-center text-xs text-muted-foreground p-2", isItmPE && "")}>{(pe?.iv || 0).toFixed(1)}</TableCell>
                    <TableCell className={cn("text-center text-xs text-[#8e909c] p-2", isItmPE && "")}>{(pe?.volume/1000 || 0).toFixed(1)}K</TableCell>
                    <TableCell className={cn("text-center text-xs p-2", pe?.chgOi > 0 ? 'text-green-500' : 'text-red-500')}>
                      <div>{(pe?.chgOi || 0).toFixed(0)}</div>
                      {isItmPE && pe?.chgOi > 0 && <div className="text-[7px] text-muted-foreground mt-0.5 whitespace-nowrap">ITM HEDGING</div>}
                    </TableCell>
                    <TableCell className={cn("text-center text-xs font-bold p-2", isItmPE ? "text-foreground" : "text-muted-foreground")}>{(pe?.oi || 0).toFixed(1)}L</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
