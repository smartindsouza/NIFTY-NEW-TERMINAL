import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowRight, ArrowDownRight, TrendingUp, TrendingDown, Building, Briefcase, Activity, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { MetricSourceBadge } from '../components/MetricSourceBadge';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';

export function FiiDii() {
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
      <div className="p-8 space-y-6">
        <Skeleton className="h-12 w-64 bg-card/50 backdrop-blur-md rounded-2xl" />
        <Skeleton className="h-[200px] w-full bg-card/50 backdrop-blur-md rounded-2xl" />
      </div>
    );
  }

  const isUnavailable = fiiDiiData.status === "UNAVAILABLE";
  const { fiiLongRatio, trend, longContracts, shortContracts, lastUpdated } = fiiDiiData.data || {};

  return (
    <div className="p-6 md:p-8 space-y-6 animate-in fade-in duration-700 max-w-[1200px] mx-auto font-sans pb-20">
      
      {/* Header */}
      <div className="flex justify-between items-end pb-3 border-b border-border">
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
            <p className="text-sm text-slate-400 max-w-lg mx-auto leading-relaxed">
              {fiiDiiData.message || "Institutional flow data requires a premium real-time or end-of-day data subscription to plot institutional positions. No simulated data is being displayed."}
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
           <Card className="bg-card backdrop-blur-xl border-border shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] p-6 rounded-2xl flex flex-col md:col-span-2">
              <div className="flex justify-between items-center mb-6">
                <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 bg-sky-500 rounded-sm"></span> NET FII POSITIONING (LATEST DAY)
                </p>
              </div>
              
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-8 bg-black/20 p-6 rounded-xl border border-white/5">
                  <div className="flex items-center gap-4">
                     <Activity className="w-10 h-10 text-sky-400" />
                     <div>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-1">Long Ratio</p>
                        <h2 className="text-4xl font-black uppercase tracking-wide text-sky-400">{fiiLongRatio}%</h2>
                     </div>
                  </div>
                  <div className="md:border-l md:border-border md:pl-8">
                     <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold mb-1">Net Trend Bias</p>
                     <p className="text-lg font-mono text-[#e2e8f0] font-bold">{trend}</p>
                  </div>
                  <div className="md:border-l md:border-border md:pl-8 hidden lg:block">
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
             <Card className="bg-card backdrop-blur-xl border-border shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_32px_rgba(0,0,0,0.4)] p-6 rounded-2xl flex flex-col md:col-span-2">
               <div className="flex justify-between items-center mb-6 border-b border-border pb-3">
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
                     <Bar dataKey="fiiNetFutures" name="FII Net Futures" radius={[4, 4, 4, 4]}>
                       {fiiDiiData.data.history.map((entry: any, index: number) => (
                         <Cell key={`cell-fii-${index}`} fill={entry.fiiNetFutures > 0 ? '#10b981' : '#ef4444'} />
                       ))}
                     </Bar>
                     <Bar dataKey="diiNetFutures" name="DII Net Futures" radius={[4, 4, 4, 4]}>
                       {fiiDiiData.data.history.map((entry: any, index: number) => (
                         <Cell key={`cell-dii-${index}`} fill={entry.diiNetFutures > 0 ? '#3b82f6' : '#f59e0b'} />
                       ))}
                     </Bar>
                   </BarChart>
                 </ResponsiveContainer>
               </div>
               
               <div className="overflow-x-auto">
                 <table className="w-full text-left border-collapse">
                   <thead>
                     <tr className="border-b border-white/5 text-[10px] uppercase tracking-widest text-[#64748b]">
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
                         <tr key={idx} className={cn("border-b border-white/5 hover:bg-white/5 transition-colors", isLatest ? "bg-white/[0.02]" : "")}>
                           <td className="py-3 px-4 text-sm font-mono text-[#e2e8f0]">
                              {day.date} {isLatest && <span className="ml-2 text-[9px] uppercase bg-white/10 px-1.5 py-0.5 rounded text-muted-foreground">Latest</span>}
                           </td>
                           <td className={cn("py-3 px-4 text-sm font-mono text-right", day.fiiLongRatio > 50 ? "text-emerald-500" : "text-rose-500")}>
                             {day.fiiLongRatio}%
                           </td>
                           <td className={cn("py-3 px-4 text-sm font-mono text-right", day.fiiNetFutures > 0 ? "text-emerald-500" : "text-rose-500")}>
                             {day.fiiNetFutures > 0 ? '+' : ''}{day.fiiNetFutures}
                           </td>
                           <td className={cn("py-3 px-4 text-sm font-mono text-right font-bold", day.diiNetFutures > 0 ? "text-blue-500" : "text-amber-500")}>
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
