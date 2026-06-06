import { useEffect, useState } from "react";
import { Activity, ShieldAlert, Cpu, HardDrive, RefreshCw, Layers } from "lucide-react";
import { performanceTracker } from "../lib/performanceTracker";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function DiagnosticsPanel() {
  const [metrics, setMetrics] = useState(performanceTracker.getMetrics());

  useEffect(() => {
    const handle = setInterval(() => {
      setMetrics(performanceTracker.getMetrics());
    }, 1000);
    return () => clearInterval(handle);
  }, []);

  return (
    <Card className="bg-[#121824]/90 border-white/5 backdrop-blur-xl shadow-2xl relative overflow-hidden">
      <CardHeader className="border-b border-white/5 pb-3">
        <CardTitle className="text-xs font-bold tracking-widest uppercase text-slate-300 flex items-center justify-between">
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
          <div className="bg-[#0f1422] p-3 rounded-lg border border-white/5 space-y-1">
            <span className="text-[10px] text-slate-400 block font-medium">Active API Requests</span>
            <span className="text-lg font-mono font-bold text-white transition-colors duration-300">
              {metrics.activeCalls}
            </span>
          </div>

          <div className="bg-[#0f1422] p-3 rounded-lg border border-white/5 space-y-1">
            <span className="text-[10px] text-slate-400 block font-medium">Avg API Latency</span>
            <span className="text-lg font-mono font-bold text-white">
              {metrics.averageResponseTime} ms
            </span>
          </div>

          <div className="bg-[#0f1422] p-3 rounded-lg border border-white/5 space-y-1 col-span-2 md:col-span-1">
            <span className="text-[10px] text-slate-400 block font-medium">Global Render Count</span>
            <span className="text-lg font-mono font-bold text-white">
              {metrics.renderCount}
            </span>
          </div>

          <div className="bg-[#0f1422] p-3 rounded-lg border border-white/5 space-y-1">
            <span className="text-[10px] text-slate-400 block font-medium">Telemetry Cache Rate</span>
            <span className="text-lg font-mono font-bold text-emerald-400">
              {metrics.cacheHitRate}%
            </span>
          </div>

          <div className="bg-[#0f1422] p-3 rounded-lg border border-white/5 space-y-1 col-span-2">
            <span className="text-[10px] text-slate-400 block font-medium">WS Subelement Subscription</span>
            <span className="text-xs font-mono font-bold text-indigo-400 truncate block mt-1" title={metrics.wsSubscriptions.join(", ")}>
              {metrics.wsSubscriptions.join(", ") || "None"}
            </span>
          </div>
        </div>

        {/* Telemetry warnings alert */}
        {metrics.warnings.length > 0 && (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 space-y-2">
            <p className="text-[11px] font-bold text-amber-400 flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5" /> THROTTLE API ADVISORY Warning
            </p>
            <div className="space-y-1">
              {metrics.warnings.map((w, idx) => (
                <div key={idx} className="flex justify-between items-center text-[10px] font-mono text-slate-300 bg-[#0f1422]/60 p-1.5 rounded">
                  <span className="truncate max-w-[200px]">{w.endpoint}</span>
                  <span className="text-amber-400 font-bold">{w.ratePer15s} hits / 15s</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Slowest components performance profiles */}
        <div className="space-y-2">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-indigo-400" /> Active Frame Speeds
          </p>
          <div className="space-y-1.5">
            {metrics.slowestComponents.length === 0 ? (
              <p className="text-[10px] text-slate-500 italic">Profiling in progress...</p>
            ) : (
              metrics.slowestComponents.map((c, idx) => (
                <div key={idx} className="flex justify-between items-center text-[11px] font-mono hover:bg-white/[0.01] p-1 rounded transition-colors">
                  <span className="text-slate-400">{c.name}</span>
                  <span className={c.avgTimeMs > 4 ? "text-amber-400" : "text-slate-300"}>{c.avgTimeMs} ms</span>
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
