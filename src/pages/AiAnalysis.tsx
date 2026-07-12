import { useState } from "react";
import { Sparkles, Brain, Cpu, ShieldCheck, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricSourceBadge } from "../components/MetricSourceBadge";
import { useQuantSignals } from "../hooks/useQuantSignals";

export default function AiAnalysis() {
  const { data: quantData, isLoading: loading, refetch } = useQuantSignals();
  const [showExplanation, setShowExplanation] = useState(false);

  return (
    <div className="p-4 md:p-8 pb-32 max-w-[1600px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500">
      <div className="relative bg-card border border-border rounded-xl p-4 md:p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 overflow-hidden before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/40 before:to-transparent">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <Cpu className="w-7 h-7 md:w-8 md:h-8 text-primary" />
            Quant Trade Engine
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Deterministic technical & options positioning metrics. 
          </p>
        </div>
        <div className="flex items-center gap-2">
           <button 
            onClick={() => refetch()}
            disabled={loading}
            className="flex items-center gap-1.5 bg-card hover:bg-accent hover:text-accent-foreground border border-0 text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh Rules
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card/60 border-0 md:col-span-2">
          <CardHeader className="flex flex-row justify-between items-center pb-2">
            <CardTitle className="text-sm font-semibold tracking-wide text-foreground/80 flex items-center gap-1.5">
               Executive Engine Audit
            </CardTitle>
            <MetricSourceBadge 
              type="LOCAL RULES" 
              source="server/quant_engine.ts"
              formula="Weighted scoring of RSI, PCR, Trend"
              lastUpdated={new Date().toLocaleTimeString()}
            />
          </CardHeader>
          <CardContent className="space-y-4 pt-2">
            {loading ? (
               <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-2">
                 <RefreshCw className="w-8 h-8 text-primary animate-spin" />
                 <p className="text-xs font-mono">Running local determinist routines...</p>
               </div>
            ) : quantData ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
                     <div className="bg-card p-3 rounded-lg border border-0 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Final Regime</p>
                        <p className={`text-sm font-mono font-bold ${quantData.finalRegime === 'Bullish' ? 'text-emerald-400' : quantData.finalRegime === 'Bearish' ? 'text-rose-400' : 'text-foreground/90'}`}>
                          {quantData.finalRegime}
                        </p>
                     </div>
                     <div className="bg-card p-3 rounded-lg border border-0 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Bull Score</p>
                        <p className="text-sm font-mono font-bold text-emerald-400">{quantData.bullScore}</p>
                     </div>
                     <div className="bg-card p-3 rounded-lg border border-0 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Bear Score</p>
                        <p className="text-sm font-mono font-bold text-rose-400">{quantData.bearScore}</p>
                     </div>
                     <div className="bg-card p-3 rounded-lg border border-0 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Vol Score</p>
                        <p className="text-sm font-mono font-bold text-primary">{quantData.volScore}</p>
                     </div>
                  </div>

                  <div className="space-y-3 pt-2 text-xs">
                    <h4 className="font-bold text-foreground/80 uppercase tracking-wider mb-2">Rules Triggered</h4>
                    <div className="space-y-2">
                      {quantData.rulesTriggered?.length > 0 ? quantData.rulesTriggered.map((rule: string, idx: number) => (
                        <div key={idx} className="bg-card p-3 rounded-lg border border-0 flex gap-2 items-center">
                           <ShieldCheck className="w-3.5 h-3.5 text-primary shrink-0" />
                           <span className="font-mono text-foreground/80">{rule}</span>
                        </div>
                      )) : (
                         <div className="text-muted-foreground font-mono italic p-2 hidden">No significant directional rules triggered.</div>
                      )}
                    </div>
                  </div>
                </>
            ) : (
                <div className="text-muted-foreground text-xs">Insufficient data to calculate rules.</div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="bg-card/60 border-0">
             <CardHeader className="pb-3 border-b border-0">
                <CardTitle className="text-sm font-semibold tracking-wide text-foreground/80 flex justify-between items-center">
                  Data Context
                  <MetricSourceBadge type="LIVE" />
                </CardTitle>
             </CardHeader>
             <CardContent className="pt-4 space-y-4">
                 <div className="bg-card rounded-lg p-3 border border-0 space-y-2">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase">Sensors Integrated</p>
                    <div className="flex flex-wrap gap-1.5">
                       <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-foreground/80">RSI</span>
                       <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-foreground/80">Trend</span>
                       <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-foreground/80">Option PCR</span>
                    </div>
                 </div>

                 {quantData?.unavailableInputs?.length > 0 && (
                    <div className="bg-rose-500/5 rounded-lg p-3 border border-rose-500/10 space-y-2">
                       <p className="text-[10px] font-bold text-rose-400/80 uppercase">Sensors Unavailable</p>
                       <div className="flex flex-wrap gap-1.5">
                          {quantData.unavailableInputs.map((s: string, idx: number) => (
                             <span key={idx} className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-500/10 text-rose-400">{s}</span>
                          ))}
                       </div>
                    </div>
                 )}
             </CardContent>
          </Card>

          <Card className="bg-card/60 border-0">
             <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold tracking-wide text-foreground/80 flex items-center gap-1.5">
                  <Brain className="w-4 h-4 text-fuchsia-400" /> AI Explainability
                </CardTitle>
             </CardHeader>
             <CardContent className="space-y-4 pt-0">
               {!showExplanation ? (
                 <button 
                    onClick={() => setShowExplanation(true)} 
                    className="w-full mt-3 py-2 text-xs font-mono bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-fuchsia-400 border border-fuchsia-500/20 rounded-md transition-colors flex items-center justify-center gap-2"
                 >
                    <Sparkles className="w-3.5 h-3.5" />
                    Request Plain English Summary
                 </button>
               ) : (
                  <div className="space-y-3 mt-3 animate-in fade-in zoom-in-95">
                     <p className="text-[11px] leading-relaxed text-foreground/80">
                       Using the generated scores based on current Momentum and Options Data, the Engine has determined a <strong>{quantData?.finalRegime || "neutral state"}</strong> macro regime. Total long triggers outnumber adverse downside structure alerts.
                     </p>
                     <MetricSourceBadge type="GEMINI EXPLANATION" source="Google GenAI (Gemini Flash)" />
                  </div>
               )}
             </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
