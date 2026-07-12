import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowRight, ArrowDownRight, TrendingUp, TrendingDown, Building, Briefcase, Activity, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { MetricSourceBadge } from '../components/MetricSourceBadge';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';
import { useUserSettings } from '../hooks/useUserSettings';

function getLighterColor(hexColor: string, percent = 40) {
  const hex = (hexColor || "#a855f7").replace(/^\s*#|\s*$/g, '');
  let r = 168, g = 85, b = 247;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  }
  
  // Blend with white (255, 255, 255) based on the percentage
  r = Math.min(255, Math.floor(r + (255 - r) * (percent / 100)));
  g = Math.min(255, Math.floor(g + (255 - g) * (percent / 100)));
  b = Math.min(255, Math.floor(b + (255 - b) * (percent / 100)));
  
  return `rgb(${r}, ${g}, ${b})`;
}

export function FiiDii() {
  const { settings } = useUserSettings();
  const { data: fiiDiiData, isLoading } = useQuery({
    queryKey: ['fii-dii'],
    queryFn: async () => {
      const res = await axios.get('/api/fii-dii');
      return res.data;
    },
    refetchInterval: 5000
  });

  if (isLoading || !fiiDiiData) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <Skeleton className="h-12 w-64 bg-card/50 backdrop-blur-md rounded-xl" />
        <Skeleton className="h-[200px] w-full bg-card/50 backdrop-blur-md rounded-xl" />
      </div>
    );
  }

  const isUnavailable = fiiDiiData.status === "UNAVAILABLE";
  const { fiiLongRatio, trend, longContracts, shortContracts, lastUpdated } = fiiDiiData.data || {};

  return (
    <div className="p-6 md:p-8 space-y-6 animate-in fade-in duration-700 max-w-[1600px] mx-auto font-sans pb-20">
      
      {/* Header */}
      <div className="flex justify-between items-end pb-3 border-b border-0">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-foreground flex items-center gap-3">
            Institutional Flow
            <MetricSourceBadge 
              type={isUnavailable ? "UNAVAILABLE" : "STORED SNAPSHOT"} 
              source="NSE Participant OI Data"
              lastUpdated={lastUpdated}
            />
          </h1>
          <p className="text-sm font-medium text-muted-foreground mt-2">
            Real participant data from NSE EOD reports.
          </p>
        </div>
      </div>

      {isUnavailable ? (
        <Card className="bg-red-500/5 backdrop-blur-xl border-red-500/20 p-8 rounded-2xl flex flex-col items-center justify-center text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-red-400" />
          <div>
            <h3 className="text-lg font-bold text-red-400 mb-1">Data Feed Unavailable</h3>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed">
              {fiiDiiData.message || "Institutional flow data requires a premium real-time or end-of-day data subscription to plot institutional positions. No simulated data is being displayed."}
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
           <Card className="bg-card backdrop-blur-xl border-0 p-6 rounded-xl flex flex-col md:col-span-2">
              <div className="flex justify-between items-center mb-6">
                <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 bg-primary rounded-sm"></span> NET FII POSITIONING (LATEST DAY)
                </p>
              </div>
              
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-8 bg-muted/40 dark:bg-black/20 p-6 rounded-xl border border-0">
                  <div className="flex items-center gap-4">
                     <Activity className="w-10 h-10 text-primary" />
                     <div>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-1">Long Ratio</p>
                        <h2 className="text-4xl font-black uppercase tracking-wide text-primary">{fiiLongRatio}%</h2>
                     </div>
                  </div>
                  <div className="md:border-l md:border-0 md:pl-8">
                     <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-1">Net Trend Bias</p>
                     <p className={cn("text-lg font-mono font-bold uppercase", (trend || "").toUpperCase() === "BULLISH" ? "text-green-500" : (trend || "").toUpperCase() === "BEARISH" ? "text-red-500" : "text-primary")}>{trend}</p>
                  </div>
                  <div className="md:border-l md:border-0 md:pl-8 hidden lg:block">
                     <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-1">Long / Short Contracts</p>
                     <p className="text-sm font-mono text-[#e2e8f0] mt-1 space-x-3">
                         <span className="text-emerald-400">{longContracts?.toLocaleString()} L</span>
                         <span className="text-rose-400">{shortContracts?.toLocaleString()} S</span>
                     </p>
                  </div>
              </div>
           </Card>

           {/* Historical Data */}
           {fiiDiiData.data?.history && fiiDiiData.data.history.length > 0 && (
             <Card className="bg-card backdrop-blur-xl border-0 p-6 rounded-xl flex flex-col md:col-span-2">
               <div className="flex justify-between items-center mb-6 border-b border-0 pb-3">
                 <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-2">
                   <Building className="w-4 h-4" /> NET INDEX FUTURES CONTINUITY (PAST 5 DAYS)
                 </p>
               </div>

               <div className="h-72 mb-6">
                 <ResponsiveContainer width="100%" height="100%">
                   <BarChart data={fiiDiiData.data.history} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                     <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} />
                     <YAxis tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} />
                     <Tooltip 
                       contentStyle={{ backgroundColor: '#0f1422', borderColor: 'rgba(255,255,255,0.1)', borderRadius: '8px' }}
                       itemStyle={{ fontSize: '12px', fontWeight: 'bold' }}
                       cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                     />
                     <Legend wrapperStyle={{ fontSize: '12px' }} />
                     <ReferenceLine y={0} stroke="#334155" />
                     <Bar dataKey="diiNetFutures" name="DII Net Futures" radius={[4, 4, 4, 4]} fill={getLighterColor(settings.accentColor, 40)} />
                     <Bar dataKey="fiiNetFutures" name="FII Net Futures" radius={[4, 4, 4, 4]} fill={settings.accentColor} />
                   </BarChart>
                 </ResponsiveContainer>
               </div>
               
               <div className="overflow-x-auto">
                 <table className="w-full text-left border-collapse">
                   <thead>
                     <tr className="border-b border-0 text-[10px] uppercase tracking-widest text-muted-foreground">
                       <th className="py-3 px-4 font-bold">Date</th>
                       <th className="py-3 px-4 font-bold text-right">FII Long Ratio</th>
                       <th className="py-3 px-4 font-bold text-right">FII Net Futures</th>
                       <th className="py-3 px-4 font-bold text-right">DII Net Futures</th>
                     </tr>
                   </thead>
                   <tbody>
                     {fiiDiiData.data.history.map((day: any, idx: number) => {
                       const isLatest = idx === fiiDiiData.data.history.length - 1;
                       return (
                         <tr key={idx} className={cn("border-b border-0 hover:bg-accent hover:text-accent-foreground transition-colors", isLatest ? "bg-white/[0.02]" : "")}>
                           <td className="py-3 px-4 text-sm font-mono text-[#e2e8f0]">
                              {day.date} {isLatest && <span className="ml-2 text-[9px] uppercase bg-white/10 px-1.5 py-0.5 rounded text-muted-foreground">Latest</span>}
                           </td>
                           <td className={cn("py-3 px-4 text-sm font-mono text-right", day.fiiLongRatio > 50 ? "text-emerald-500" : "text-rose-500")}>
                             {day.fiiLongRatio}%
                           </td>
                           <td className={cn("py-3 px-4 text-sm font-mono text-right", day.fiiNetFutures > 0 ? "text-emerald-500" : "text-rose-500")}>
                             {day.fiiNetFutures > 0 ? '+' : ''}{day.fiiNetFutures}
                           </td>
                           <td className={cn("py-3 px-4 text-sm font-mono text-right font-bold", day.diiNetFutures > 0 ? "text-primary" : "text-primary")}>
                             {day.diiNetFutures > 0 ? '+' : ''}{day.diiNetFutures}
                           </td>
                         </tr>
                       );
                     })}
                   </tbody>
                 </table>
               </div>
             </Card>
           )}
        </div>
      )}
    </div>
  );
}
