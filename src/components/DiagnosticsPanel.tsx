import { useEffect, useState } from "react";
import { Activity, ShieldAlert, Cpu, HardDrive, RefreshCw, Layers, Globe } from "lucide-react";
import { performanceTracker } from "../lib/performanceTracker";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function DiagnosticsPanel() {
  const [metrics, setMetrics] = useState(performanceTracker.getMetrics());
  const [proxyStatus, setProxyStatus] = useState<{ alive: boolean; egressIp: string | null; expectedIp: string | null } | null>(null);

  useEffect(() => {
    const handle = setInterval(() => {
      setMetrics(performanceTracker.getMetrics());
    }, 1000);
    return () => clearInterval(handle);
  }, []);

  useEffect(() => {
    const fetchProxy = async () => {
      try {
        const res = await fetch("/api/diagnostics/proxy");
        if (res.ok) {
          const data = await res.json();
          setProxyStatus(data);
        }
      } catch (e) {
        console.error("Failed to fetch proxy in panel:", e);
      }
    };
    fetchProxy();
    const interval = setInterval(fetchProxy, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Card className="bg-card border-0 backdrop-blur-xl relative overflow-hidden">
      <CardHeader className="border-b border-0 pb-3">
        <CardTitle className="text-xs font-bold tracking-widest uppercase text-foreground/80 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-emerald-400 animate-pulse" /> Live Terminal Diagnostics
          </span>
          <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono">
            SYS: OK
          </Badge>
        </CardTitle>
      </CardHeader>
      
      <CardContent className="p-4 space-y-4">
        {/* Metric Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="bg-card p-3 rounded-lg border border-0 space-y-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Active API Requests</span>
            <span className="text-lg font-mono font-bold text-foreground transition-colors duration-300">
              {metrics.activeCalls}
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Avg API Latency</span>
            <span className="text-lg font-mono font-bold text-foreground">
              {metrics.averageResponseTime} ms
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1 col-span-2 md:col-span-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Global Render Count</span>
            <span className="text-lg font-mono font-bold text-foreground">
              {metrics.renderCount}
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1">
            <span className="text-[10px] text-muted-foreground block font-medium">Telemetry Cache Rate</span>
            <span className="text-lg font-mono font-bold text-emerald-400">
              {metrics.cacheHitRate}%
            </span>
          </div>

          <div className="bg-card p-3 rounded-lg border border-0 space-y-1 col-span-2">
            <span className="text-[10px] text-muted-foreground block font-medium">WS Subelement Subscription</span>
            <span className="text-xs font-mono font-bold text-indigo-400 truncate block mt-1" title={metrics.wsSubscriptions.join(", ")}>
              {metrics.wsSubscriptions.join(", ") || "None"}
            </span>
          </div>
        </div>

        {/* Outbound Proxy Status section */}
        <div className={cn(
          "border rounded-xl p-3 flex flex-col gap-2 transition-all duration-300",
          proxyStatus?.alive 
            ? "bg-emerald-500/[0.02] border-emerald-500/10" 
            : "bg-rose-500/[0.02] border-rose-500/10 animate-pulse"
        )}>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
              <Globe className={cn("w-3.5 h-3.5", proxyStatus?.alive ? "text-emerald-400" : "text-rose-400")} /> Outbound Proxy Status
            </span>
            {proxyStatus && (
              <Badge 
                className={cn(
                  "text-[10px] font-mono py-0.5 px-1.5 border leading-none",
                  proxyStatus.alive 
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                    : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                )}
              >
                ● {proxyStatus.alive ? "LIVE" : "DOWN"}
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono mt-1">
            <div className="bg-card p-2 rounded border border-0">
              <span className="text-muted-foreground block text-[9px] uppercase">Egress/Exit IP</span>
              <span className={cn("font-bold block mt-0.5 truncate", proxyStatus?.alive ? "text-cyan-400" : "text-rose-400")}>
                {proxyStatus ? (proxyStatus.egressIp || "Unknown") : "Querying..."}
              </span>
            </div>
            <div className="bg-card p-2 rounded border border-0">
              <span className="text-muted-foreground block text-[9px] uppercase">Expected Hub</span>
              <span className="text-foreground/80 font-semibold block mt-0.5 truncate" title={proxyStatus?.expectedIp || ""}>
                {proxyStatus ? (proxyStatus.expectedIp || "None") : "Querying..."}
              </span>
            </div>
          </div>
        </div>

        {/* Telemetry warnings alert */}
        {metrics.warnings.length > 0 && (
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 space-y-2">
            <p className="text-[11px] font-bold text-primary flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5" /> THROTTLE API ADVISORY Warning
            </p>
            <div className="space-y-1">
              {metrics.warnings.map((w, idx) => (
                <div key={idx} className="flex justify-between items-center text-[10px] font-mono text-foreground/80 bg-card/60 p-1.5 rounded">
                  <span className="truncate max-w-[200px]">{w.endpoint}</span>
                  <span className="text-primary font-bold">{w.ratePer15s} hits / 15s</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Slowest components performance profiles */}
        <div className="space-y-2">
          <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-indigo-400" /> Active Frame Speeds
          </p>
          <div className="space-y-1.5">
            {metrics.slowestComponents.length === 0 ? (
              <p className="text-[10px] text-muted-foreground italic">Profiling in progress...</p>
            ) : (
              metrics.slowestComponents.map((c, idx) => (
                <div key={idx} className="flex justify-between items-center text-[11px] font-mono hover:bg-white/[0.01] p-1 rounded transition-colors">
                  <span className="text-muted-foreground">{c.name}</span>
                  <span className={c.avgTimeMs > 4 ? "text-primary" : "text-foreground/80"}>{c.avgTimeMs} ms</span>
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
