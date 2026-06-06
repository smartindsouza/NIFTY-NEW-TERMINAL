import { useState, useMemo } from "react";
import { useNotifications } from "../hooks/useNotifications";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Bell, 
  Trash2, 
  CheckCheck, 
  TrendingUp, 
  Activity, 
  Inbox, 
  Terminal, 
  Layers, 
  ArrowRight,
  TrendingDown,
  Clock,
  ExternalLink
} from "lucide-react";
import { cn } from "@/lib/utils";

type FilterType = "all" | "oi_alert" | "divergence" | "order" | "system";

export default function Notifications() {
  const { notifications, markAsRead, markAllAsRead, clearAll, unreadCount } = useNotifications();
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  const filteredNotifications = useMemo(() => {
    if (activeFilter === "all") return notifications;
    return notifications.filter((n) => n.type === activeFilter);
  }, [notifications, activeFilter]);

  const stats = useMemo(() => {
    return {
      all: notifications.length,
      oi_alert: notifications.filter((n) => n.type === "oi_alert").length,
      divergence: notifications.filter((n) => n.type === "divergence").length,
      order: notifications.filter((n) => n.type === "order").length,
      system: notifications.filter((n) => n.type === "system").length,
    };
  }, [notifications]);

  const formatDistanceToNow = (timestamp: string) => {
    try {
      const diffMs = Date.now() - new Date(timestamp).getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return "Just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      return new Date(timestamp).toLocaleDateString();
    } catch {
      return "Recently";
    }
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "oi_alert":
        return <Layers className="w-5 h-5 text-amber-400 animate-pulse" />;
      case "divergence":
        return <TrendingUp className="w-5 h-5 text-purple-400" />;
      case "order":
        return <Activity className="w-5 h-5 text-emerald-400" />;
      default:
        return <Terminal className="w-5 h-5 text-blue-400" />;
    }
  };

  const getNotificationBadgeColor = (type: string) => {
    switch (type) {
      case "oi_alert":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      case "divergence":
        return "bg-purple-500/10 text-purple-400 border-purple-500/20";
      case "order":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      default:
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    }
  };

  const getNotificationLabel = (type: string) => {
    switch (type) {
      case "oi_alert":
        return "OI TRACE";
      case "divergence":
        return "TA SIG";
      case "order":
        return "ORDER EXEC";
      default:
        return "SYSTEM";
    }
  };

  return (
    <div className="p-4 md:p-8 pb-32 max-w-[1200px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500 font-sans">
      
      {/* Absolute aura decorative glow */}
      <div className="absolute top-10 left-12 w-96 h-96 bg-purple-500/5 blur-[120px] pointer-events-none -z-10 rounded-full" />
      <div className="absolute top-40 right-10 w-96 h-96 bg-indigo-500/5 blur-[120px] pointer-events-none -z-10 rounded-full" />

      {/* Header section */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end pb-6 border-b border-white/10 border-dashed gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-1.5 bg-purple-500/10 border border-purple-500/20 rounded-xl">
              <Bell className="w-5 h-5 text-purple-400" />
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight flex items-center gap-2">
              Quant Notifications Terminal
            </h1>
            {unreadCount > 0 && (
              <Badge className="bg-rose-500/20 border border-rose-500/30 text-rose-400 font-mono font-medium tracking-wider">
                {unreadCount} UNREAD
              </Badge>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Real-time trace logs capturing high-frequency open interest swings, Bollinger volatility breakouts, and order confirmations.
          </p>
        </div>

        {/* Quick Utilities */}
        <div className="flex items-center gap-2.5 self-stretch md:self-auto justify-end w-full md:w-auto">
          {notifications.length > 0 && (
            <>
              <button
                onClick={markAllAsRead}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-800/80 hover:bg-slate-700/80 border border-white/5 rounded-lg text-slate-300 transition-all font-mono"
              >
                <CheckCheck className="w-3.5 h-3.5" /> Mark all read
              </button>
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-rose-950/30 hover:bg-rose-900/40 border border-rose-900/40 rounded-lg text-rose-400 transition-all font-mono"
              >
                <Trash2 className="w-3.5 h-3.5" /> Purge history
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Grid View */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        
        {/* Sidebar Controls */}
        <div className="flex flex-row lg:flex-col overflow-x-auto lg:overflow-visible gap-1 pb-2 lg:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-[#0d1117]/60 p-1.5 rounded-xl border border-white/5">
          {[
            { id: "all", label: "All Logs", count: stats.all },
            { id: "oi_alert", label: "OI Scanners", count: stats.oi_alert },
            { id: "divergence", label: "TA Divergences", count: stats.divergence },
            { id: "order", label: "Executions", count: stats.order },
            { id: "system", label: "System Diagnostic", count: stats.system }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveFilter(tab.id as FilterType)}
              className={cn(
                "flex items-center justify-between gap-3 px-3 py-2 text-xs rounded-lg transition-all font-mono text-left whitespace-nowrap min-w-max lg:min-w-0 w-full",
                activeFilter === tab.id
                  ? "bg-purple-500/10 text-purple-400 border border-purple-500/20 shadow-[0_0_15px_rgba(168,85,247,0.08)] font-bold"
                  : "text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent"
              )}
            >
              <span>{tab.label}</span>
              <span className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-bold font-mono transition-colors",
                activeFilter === tab.id
                  ? "bg-purple-500/20 text-purple-300"
                  : "bg-slate-800 text-slate-500"
              )}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* Content Panel */}
        <div className="lg:col-span-3 space-y-4">
          {filteredNotifications.length === 0 ? (
            <Card className="flex flex-col items-center justify-center p-12 text-center border-slate-800 bg-[#0d121d]/40 rounded-2xl">
              <div className="w-12 h-12 rounded-full bg-slate-800/40 flex items-center justify-center mb-4 text-slate-500">
                <Inbox className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-semibold text-slate-200 mb-1">No matching logs found</h3>
              <p className="text-xs text-slate-400 max-w-sm">
                {activeFilter === "all" 
                  ? "When real-time alerts or signals are computed, they will pop up and be archived here."
                  : `There are currently no saved notices under the "${activeFilter.replace('_', ' ')}" category.`
                }
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredNotifications.map((notif) => (
                <div
                  key={notif.id}
                  onClick={() => !notif.read && markAsRead(notif.id)}
                  className={cn(
                    "relative group p-4 border rounded-xl transition-all duration-300 cursor-pointer text-left",
                    notif.read
                      ? "bg-[#0b0e14]/40 border-slate-900/45 hover:border-slate-800/60"
                      : "bg-[#0d1321]/80 border-purple-500/20 hover:border-purple-500/40 shadow-[0_0_15px_rgba(168,85,247,0.05)]"
                  )}
                >
                  {/* Left priority line indicator for unread items */}
                  {!notif.read && (
                    <div className="absolute top-0 bottom-0 left-0 w-1 bg-purple-500 rounded-l-xl" />
                  )}

                  <div className="flex items-start gap-3.5">
                    {/* Visual Badge Icon */}
                    <div className={cn(
                      "p-2 rounded-xl border flex items-center justify-center shrink-0",
                      getNotificationBadgeColor(notif.type)
                    )}>
                      {getNotificationIcon(notif.type)}
                    </div>

                    {/* Meta and Body content */}
                    <div className="flex-1 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider font-mono border",
                            getNotificationBadgeColor(notif.type)
                          )}>
                            {getNotificationLabel(notif.type)}
                          </span>
                          <h4 className="font-semibold text-sm text-foreground">
                            {notif.title}
                          </h4>
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span>{formatDistanceToNow(notif.timestamp)}</span>
                        </div>
                      </div>

                      <p className="text-xs text-slate-300 leading-relaxed font-mono">
                        {notif.body}
                      </p>

                      {/* Display structured metadata if it exists (for maximum professional layout granularity) */}
                      {notif.metadata && (
                        <div className="mt-3 p-2.5 rounded-lg bg-black/40 border border-white/5 font-mono text-[11px] text-slate-400 space-y-1 w-full max-w-full overflow-x-auto">
                          {notif.type === "oi_alert" && (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-left">
                              <div><span className="text-slate-500">Strike:</span> <span className="font-bold text-slate-300">{notif.metadata.strike}</span></div>
                              <div><span className="text-slate-500">Option:</span> <span className="font-bold text-slate-200">{notif.metadata.type}</span></div>
                              <div><span className="text-slate-500">Distance:</span> <span className="text-slate-300">{notif.metadata.distance} pts</span></div>
                              <div><span className="text-slate-500">Action:</span> <span className="font-bold text-amber-400">{notif.metadata.actionLabel}</span></div>
                            </div>
                          )}
                          {notif.type === "divergence" && (
                            <div className="flex items-center gap-4 text-left">
                              <div><span className="text-slate-500">Timeframe:</span> <span className="text-purple-400 font-bold">{notif.metadata.timeframe}m</span></div>
                              <div><span className="text-slate-500">Divergence:</span> <span className="text-slate-200 capitalize font-bold">{notif.metadata.divType}</span></div>
                            </div>
                          )}
                          {notif.type === "order" && (
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-left">
                              <div><span className="text-slate-500">Contract:</span> <span className="text-slate-200">{notif.metadata.symbol}</span></div>
                              <div><span className="text-slate-500">Side:</span> <span className={cn("font-bold", notif.metadata.side === "BUY" ? "text-emerald-400" : "text-rose-400")}>{notif.metadata.side}</span></div>
                              <div><span className="text-slate-500">Qty:</span> <span className="text-slate-300">{notif.metadata.qty}</span></div>
                              <div><span className="text-slate-500">Status:</span> <span className="text-emerald-400">Filled ✅</span></div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
