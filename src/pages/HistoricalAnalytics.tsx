import { TrendingUp, BarChart2, Calendar, LineChart, RefreshCw } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { MetricSourceBadge, MetricSourceType } from "../components/MetricSourceBadge";
import { useHistoricalAnalytics, useFiiData } from "../hooks/useHistoricalAnalytics";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export default function HistoricalAnalytics() {
  const { data, isLoading: loading, refetch: refetchData } = useHistoricalAnalytics();
  const { data: fiiData, refetch: refetchFii } = useFiiData();

  const handleRefresh = () => {
    refetchData();
    refetchFii();
  };

  const getMetricType = (val: any): MetricSourceType => {
    if (data?.status === "UNAVAILABLE" || val === null || val === undefined) return "UNAVAILABLE";
    return "CALCULATED";
  };

  return (
    <div className="p-4 md:p-8 pb-32 max-w-[1600px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end pb-6 border-b border-0 border-dashed gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <LineChart className="w-8 h-8 text-primary animate-in" />
            Historical Index Analytics
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Browse calculated multi-month volatility cones and standard deviation anchors.
          </p>
        </div>
        <button 
           onClick={handleRefresh}
           disabled={loading}
           className="flex items-center gap-1.5 bg-card hover:bg-accent hover:text-accent-foreground border border-0 text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
           <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
           Sync Daily Data
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-0 relative overflow-hidden">
          <CardContent className="p-5 space-y-2 pt-4">
             <div className="flex justify-between items-start gap-2">
                <p className="text-[10px] text-muted-foreground uppercase font-semibold">30D Historical Vol.</p>
                <MetricSourceBadge 
                   type={getMetricType(data?.data?.historicalVolatility?.hv30)}
                   source="Kite Historical API (NIFTY daily)"
                   formula="stddev(log returns) × sqrt(252)"
                   lastUpdated={data?.timestamp}
                />
             </div>
             <p className="text-2xl font-mono font-bold text-foreground">
                {data?.data?.historicalVolatility?.hv30 ? `${data.data.historicalVolatility.hv30}%` : "—"}
             </p>
             <p className="text-[9px] text-muted-foreground">Requires minimum 30 daily candles</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-0 relative overflow-hidden">
          <CardContent className="p-5 space-y-2 pt-4">
             <div className="flex justify-between items-start gap-2">
                <p className="text-[10px] text-muted-foreground uppercase font-semibold">30D Avg Swing</p>
                <MetricSourceBadge 
                   type={getMetricType(data?.data?.intradaySwing?.swing30)}
                   source="Kite Historical API (NIFTY OHLC)"
                   formula="avg(high - low)"
                   lastUpdated={data?.timestamp}
                />
             </div>
             <p className="text-2xl font-mono font-bold text-foreground">
                {data?.data?.intradaySwing?.swing30 ? `${data.data.intradaySwing.swing30} pts` : "—"}
             </p>
             <p className="text-[9px] text-muted-foreground">Rolling mean intraday volatility</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-0 relative overflow-hidden">
          <CardContent className="p-5 space-y-2 pt-4">
             <div className="flex justify-between items-start gap-2">
                <p className="text-[10px] text-muted-foreground uppercase font-semibold">IV Percentile (IVP)</p>
                <MetricSourceBadge 
                   type="UNAVAILABLE"
                   source="Local Option Chain Snapshots"
                   formula="Rank of current ATM IV vs 252D history"
                />
             </div>
             <p className="text-2xl font-mono font-bold text-slate-600">—</p>
             <p className="text-[9px] text-muted-foreground italic">Insufficient real history</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-0 relative overflow-hidden">
          <CardContent className="p-5 space-y-2 pt-4">
             <div className="flex justify-between items-start gap-2">
                <p className="text-[10px] text-muted-foreground uppercase font-semibold">FII Long Ratio</p>
                <MetricSourceBadge 
                   type={fiiData?.status === "UNAVAILABLE" ? "UNAVAILABLE" : "STORED SNAPSHOT"}
                   source={fiiData?.message}
                />
             </div>
             <p className={`text-2xl font-mono font-bold ${fiiData?.status === 'UNAVAILABLE' ? 'text-slate-600' : 'text-foreground'}`}>
                {fiiData?.data?.fiiLongRatio ?? "—"}
             </p>
             <p className="text-[9px] text-muted-foreground italic text-nowrap truncate">{fiiData?.message || 'Daily exchange upload'}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card border-0 md:col-span-2">
          <CardHeader className="flex flex-row justify-between items-center pb-2">
            <CardTitle className="text-sm font-semibold tracking-wide text-foreground/80 flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-primary" /> Historical PCR Cones
            </CardTitle>
            <MetricSourceBadge 
              type={data?.data?.pcrHistory ? "CALCULATED" : "UNAVAILABLE"} 
              source="Rolling Kite Option Chain PCR Dumps" 
              formula="Put Oi / Call Oi (30-day historical range)"
            />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-card p-4 rounded-xl border border-0 space-y-3">
               {data?.data?.pcrHistory ? (
                  <div className="h-[210px] w-full">
                     <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data.data.pcrHistory} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                           <defs>
                              <linearGradient id="pcrConeColor" x1="0" y1="0" x2="0" y2="1">
                                 <stop offset="5%" stopColor="#2563eb" stopOpacity={0.15}/>
                                 <stop offset="95%" stopColor="#2563eb" stopOpacity={0.0}/>
                              </linearGradient>
                           </defs>
                           <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.05} />
                           <XAxis dataKey="date" tick={{ fontSize: 9 }} strokeOpacity={0.2} stroke="#94a3b8" />
                           <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9 }} strokeOpacity={0.2} stroke="#94a3b8" />
                           <Tooltip 
                              contentStyle={{ backgroundColor: "#0f172a", borderRadius: "8px", border: "1px solid #334155" }}
                              labelStyle={{ color: "#94a3b8", fontSize: "10px", fontFamily: "monospace" }}
                              itemStyle={{ fontSize: "11px" }}
                           />
                           <Area 
                              type="monotone" 
                              dataKey="upperCone" 
                              stroke="#60a5fa" 
                              strokeWidth={1}
                              strokeDasharray="4 4"
                              fillOpacity={1} 
                              fill="url(#pcrConeColor)" 
                              name="Expected Upper"
                           />
                           <Area 
                              type="monotone" 
                              dataKey="lowerCone" 
                              stroke="#f87171" 
                              strokeWidth={1}
                              strokeDasharray="4 4"
                              fill="none" 
                              name="Expected Lower"
                           />
                           <Area 
                              type="monotone" 
                              dataKey="pcr" 
                              stroke="#3b82f6" 
                              strokeWidth={2.5} 
                              fill="none"
                              name="Rolling PCR"
                           />
                        </AreaChart>
                     </ResponsiveContainer>
                  </div>
               ) : (
                  <div className="text-muted-foreground text-xs text-center py-6">
                     Insufficient real data stored to plot historical cones. No simulated values displayed.
                  </div>
               )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-0">
          <CardHeader className="flex flex-row justify-between items-center pb-2">
            <CardTitle className="text-sm font-semibold tracking-wide text-foreground/80 flex items-center gap-1.5">
              <BarChart2 className="w-4 h-4 text-primary" /> Standard Deviations
            </CardTitle>
            <MetricSourceBadge 
               type={getMetricType(data?.data?.standardDeviation?.weekly1SD)} 
               source="Spot & 30D HV"
               formula="spot ± (spot × HV × sqrt(time))"
            />
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[11px] text-muted-foreground leading-relaxed font-sans mt-0">
               Dynamically calculated based on the trailing 30-day structural Historical Volatility index.
            </p>
            {data?.data?.standardDeviation?.weekly1SD ? (
               <>
                  <div className="space-y-1 bg-card p-3 rounded-lg border border-0">
                     <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">1-SD Weekly Move</p>
                     <p className="text-xs font-bold text-emerald-400 font-mono">± {data.data.standardDeviation.weekly1SD} points</p>
                  </div>
                  <div className="space-y-1 bg-card p-3 rounded-lg border border-0">
                     <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">2-SD Monthly Move</p>
                     <p className="text-xs font-bold text-emerald-400 font-mono">± {data.data.standardDeviation.monthly2SD} points</p>
                  </div>
               </>
            ) : (
               <div className="space-y-1 bg-red-500/5 p-3 rounded-lg border border-red-500/10 text-center">
                  <p className="text-[11px] text-red-400 font-mono">HV Data Required</p>
               </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
