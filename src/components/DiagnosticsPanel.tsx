import { useEffect, useState } from "react";
import { Activity, ShieldAlert, Cpu, HardDrive, RefreshCw, Layers } from "lucide-react";
import { performanceTracker } from "../lib/performanceTracker";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Injected by the `define` block in vite.config.ts at build time.
declare const __BUILD_TIME__: string;

export function DiagnosticsPanel() {
  const [metrics, setMetrics] = useState(performanceTracker.getMetrics());

  useEffect(() => {
    const handle = setInterval(() => {
      setMetrics(performanceTracker.getMetrics());
    }, 1000);
    return () => clearInterval(handle);
  }, []);

  return (
    <Card className="bg-card border-0 backdrop-blur-xl relative overflow-hidden">
      <CardHeader className="border-b border-0 pb-3">
        <CardTitle className="text-xs font-bold tracking-widest uppercase text-foreground/80 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-emerald-400 animate-pulse" /> Live Terminal Diagnostics
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[9px] font-mono normal-case tracking-normal text-muted-foreground" title="When this UI bundle was built (IST). If this is older than the latest deploy, the phone is still on a cached bundle — hard-refresh.">
              UI {new Date(__BUILD_TIME__).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST
            </span>
            <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono">
              SYS: OK
            </Badge>
          </span>
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
