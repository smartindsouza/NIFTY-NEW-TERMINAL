import { Badge } from "@/components/ui/badge";
import { Activity, Database, Cpu, Brain, AlertCircle } from "lucide-react";

export type MetricSourceType = "LIVE" | "CALCULATED" | "STORED SNAPSHOT" | "UNAVAILABLE" | "GEMINI EXPLANATION" | "LOCAL RULES";

interface MetricSourceBadgeProps {
  type: MetricSourceType;
  lastUpdated?: string;
  source?: string;
  formula?: string;
}

export function MetricSourceBadge({ type, lastUpdated, source, formula }: MetricSourceBadgeProps) {
  let color = "";
  let icon = null;

  switch (type) {
    case "LIVE":
      color = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      icon = <Activity className="w-3 h-3 mr-1" />;
      break;
    case "CALCULATED":
      color = "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
      icon = <Cpu className="w-3 h-3 mr-1" />;
      break;
    case "STORED SNAPSHOT":
      color = "bg-sky-500/10 text-sky-400 border-sky-500/20";
      icon = <Database className="w-3 h-3 mr-1" />;
      break;
    case "GEMINI EXPLANATION":
      color = "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20";
      icon = <Brain className="w-3 h-3 mr-1" />;
      break;
    case "LOCAL RULES":
      color = "bg-amber-500/10 text-amber-500 border-amber-500/20";
      icon = <Activity className="w-3 h-3 mr-1" />;
      break;
    case "UNAVAILABLE":
    default:
      color = "bg-red-500/10 text-red-400 border-red-500/20";
      icon = <AlertCircle className="w-3 h-3 mr-1" />;
      break;
  }

  return (
    <div className="group relative inline-flex items-center">
      <Badge className={`text-[9px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded border ${color} font-bold flex items-center`}>
        {icon}
        [{type}]
      </Badge>
      
      {/* Tooltip for Data Lineage */}
      {(lastUpdated || source || formula) && (
        <div className="absolute top-full left-0 mt-2 z-50 hidden group-hover:block w-64 bg-[#0f1422] border border-white/10 rounded-lg p-3 shadow-xl pointer-events-none">
          <p className="text-[10px] uppercase text-slate-400 font-bold mb-2">Data Lineage</p>
          {source && (
            <div className="mb-1 text-slate-300">
              <span className="text-slate-500 text-[10px]">Source: </span>
              <span className="text-[11px] font-mono">{source}</span>
            </div>
          )}
          {formula && (
            <div className="mb-1 text-slate-300">
              <span className="text-slate-500 text-[10px]">Formula: </span>
              <span className="text-[11px] font-mono">{formula}</span>
            </div>
          )}
          {lastUpdated && (
            <div className="text-slate-300">
              <span className="text-slate-500 text-[10px]">Last Updated: </span>
              <span className="text-[11px] font-mono">{lastUpdated}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
