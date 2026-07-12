import { useState, useMemo } from "react";
import { useNotifications } from "../hooks/useNotifications";
import { notificationService } from "../lib/notificationService";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
function renderMarkdownFallback(text: string) {
  // basic fallback, replace bold and newlines
  return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');
}
import { 
  Bell, 
  BellOff, 
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
  ExternalLink,
  Bot
} from "lucide-react";
import { cn } from "@/lib/utils";

type FilterType = "all" | "oi_alert" | "divergence" | "order" | "system";

export default function Notifications() {
  const { notifications, markAsRead, markAllAsRead, clearAll, unreadCount } = useNotifications();
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  // Quant pop-up alerts master switch — DEFAULT OFF so quant desktop pop-ups
  // don't mix with the chart's level-touch alerts. History still archives here.
  const [popupsOn, setPopupsOn] = useState<boolean>(() => notificationService.popupsEnabled());
  const togglePopups = () => {
    const next = !popupsOn;
    notificationService.setPopupsEnabled(next);
    setPopupsOn(next);
  };
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [gamePlan, setGamePlan] = useState<string | null>(null);

  const generateGamePlan = async () => {
    setIsGeneratingPlan(true);
    setGamePlan(null);
    try {
      const relevantNotifs = notifications.filter(n => n.type === 'oi_alert' || n.type === 'divergence').slice(0, 20);
      const res = await fetch('/api/generate-game-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alerts: relevantNotifs })
      });
      const data = await res.json();
      if(data.gamePlan) {
        setGamePlan(data.gamePlan);
      } else {
        alert("Failed to generate Game Plan");
      }
    } catch(e) {
      console.error(e);
      alert("Error generating Game Plan");
    } finally {
      setIsGeneratingPlan(false);
    }
  };

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
        return <Layers className="w-5 h-5 text-primary animate-pulse" />;
      case "divergence":
        return <TrendingUp className="w-5 h-5 text-primary" />;
      case "order":
        return <Activity className="w-5 h-5 text-emerald-400" />;
      default:
        return <Terminal className="w-5 h-5 text-primary" />;
    }
  };

  const getNotificationBadgeColor = (type: string) => {
    switch (type) {
      case "oi_alert":
        return "bg-primary/10 text-primary border-primary/20";
      case "divergence":
        return "bg-primary/10 text-primary border-primary/20";
      case "order":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      default:
        return "bg-primary/10 text-primary border-primary/20";
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
    <div className="p-4 md:p-8 pb-32 max-w-[1600px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500 font-sans">
      
      {/* Absolute aura decorative glow */}
      <div className="absolute top-10 left-12 w-96 h-96 bg-primary/5 blur-[120px] pointer-events-none -z-10 rounded-full" />
      <div className="absolute top-40 right-10 w-96 h-96 bg-primary/5 blur-[120px] pointer-events-none -z-10 rounded-full" />

      {/* Header section */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end pb-6 border-b border-0 border-dashed gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-1.5 bg-primary/10 border border-primary/20 rounded-xl">
              <Bell className="w-5 h-5 text-primary" />
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
          <p className="text-xs text-muted-foreground">
            Real-time trace logs capturing high-frequency open interest swings, Bollinger volatility breakouts, and order confirmations.
          </p>
        </div>

        {/* Quick Utilities */}
        <div className="flex items-center gap-2.5 self-stretch md:self-auto justify-end w-full md:w-auto">
          <button
            onClick={togglePopups}
            title={popupsOn ? "Quant pop-up alerts are ON — click to disable" : "Quant pop-up alerts are OFF (default) — alerts archive here silently"}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs border border-0 rounded-lg transition-all font-mono",
              popupsOn ? "bg-primary/15 text-primary" : "bg-muted/80 text-muted-foreground hover:text-foreground"
            )}
          >
            {popupsOn ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
            {popupsOn ? "Pop-ups on" : "Pop-ups off"}
          </button>
          {notifications.length > 0 && (
            <>
              <button
                onClick={markAllAsRead}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-muted/80 hover:bg-slate-700/80 border border-0 rounded-lg text-foreground/80 transition-all font-mono"
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
        <div className="flex flex-row lg:flex-col overflow-x-auto lg:overflow-visible gap-1 pb-2 lg:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-card/60 p-1.5 rounded-xl border border-0">
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
                  ? "bg-primary/10 text-primary border border-primary/20 font-bold"
                  : "text-muted-foreground hover:text-foreground/90 hover:bg-accent hover:text-accent-foreground border border-transparent"
              )}
            >
              <span>{tab.label}</span>
              <span className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-bold font-mono transition-colors",
                activeFilter === tab.id
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
              )}>
                {tab.count}
              </span>
            </button>
          ))}

          {/* AI Game Plan Button */}
          <div className="mt-4 pt-4 border-t border-0 mx-2 hidden lg:block" />
          <button
            onClick={generateGamePlan}
            disabled={isGeneratingPlan || notifications.length === 0}
            className="flex items-center gap-2 justify-center lg:justify-start px-3 py-2 text-xs bg-primary/20 hover:bg-primary/30 text-primary font-bold border border-primary/30 rounded-lg transition-all whitespace-nowrap min-w-max w-full disabled:opacity-50"
          >
            <Bot className={cn("w-4 h-4", isGeneratingPlan && "animate-bounce")} />
            {isGeneratingPlan ? "Thinking..." : "AI Game Plan"}
          </button>
        </div>

        {/* Content Panel */}
        <div className="lg:col-span-3 space-y-4">
          
          {/* Game Plan Display */}
          {(isGeneratingPlan || gamePlan) && (
            <div className="bg-card border border-primary/30 p-5 rounded-xl mb-6 animate-in slide-in-from-top-4 fade-in duration-300">
               <div className="flex items-center gap-3 mb-4">
                 <div className="p-2 bg-primary/20 border border-primary/30 rounded-xl">
                   <Bot className="w-5 h-5 text-primary" />
                 </div>
                 <h2 className="text-xl font-bold text-foreground flex items-center gap-2">Intraday Strategy Analysis</h2>
               </div>
               {isGeneratingPlan ? (
                 <div className="space-y-3">
                   <div className="h-4 bg-primary/10 rounded w-3/4 animate-pulse"></div>
                   <div className="h-4 bg-primary/10 rounded w-full animate-pulse"></div>
                   <div className="h-4 bg-primary/10 rounded w-5/6 animate-pulse"></div>
                 </div>
               ) : (
                 <div 
                   className="markdown-body prose prose-invert prose-p:text-muted-foreground max-w-none text-sm text-foreground/80 prose-headings:text-foreground prose-h3:mt-4 prose-h3:mb-2 prose-h3:text-primary prose-strong:text-foreground"
                   dangerouslySetInnerHTML={{ __html: renderMarkdownFallback(gamePlan || '') }}
                 />
               )}
            </div>
          )}

          {filteredNotifications.length === 0 ? (
            <Card className="flex flex-col items-center justify-center p-12 text-center  bg-[#0d121d]/40 rounded-2xl">
              <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center mb-4 text-muted-foreground">
                <Inbox className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-semibold text-foreground/90 mb-1">No matching logs found</h3>
              <p className="text-xs text-muted-foreground max-w-sm">
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
                      ? "bg-[#0b0e14]/40 /45 hover:"
                      : "bg-[#0d1321]/80 border-primary/20 hover:border-primary/40"
                  )}
                >
                  {/* Left priority line indicator for unread items */}
                  {!notif.read && (
                    <div className="absolute top-0 bottom-0 left-0 w-1 bg-primary rounded-l-xl" />
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
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
                          <Clock className="w-3 h-3 text-muted-foreground" />
                          <span>{formatDistanceToNow(notif.timestamp)}</span>
                        </div>
                      </div>

                      <p className="text-xs text-foreground/80 leading-relaxed font-mono">
                        {notif.body}
                      </p>

                      {/* Display structured metadata if it exists (for maximum professional layout granularity) */}
                      {notif.metadata && (
                        <div className="mt-3 p-2.5 rounded-lg bg-muted border border-0 font-mono text-[11px] text-muted-foreground space-y-1 w-full max-w-full overflow-x-auto">
                          {notif.type === "oi_alert" && (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-left">
                              <div><span className="text-muted-foreground">Strike:</span> <span className="font-bold text-foreground/80">{notif.metadata.strike}</span></div>
                              <div><span className="text-muted-foreground">Option:</span> <span className="font-bold text-foreground/90">{notif.metadata.type}</span></div>
                              <div><span className="text-muted-foreground">Distance:</span> <span className="text-foreground/80">{notif.metadata.distance} pts</span></div>
                              <div><span className="text-muted-foreground">Action:</span> <span className="font-bold text-primary">{notif.metadata.actionLabel}</span></div>
                            </div>
                          )}
                          {notif.type === "divergence" && (
                            <div className="flex items-center gap-4 text-left">
                              <div><span className="text-muted-foreground">Timeframe:</span> <span className="text-primary font-bold">{notif.metadata.timeframe}m</span></div>
                              <div><span className="text-muted-foreground">Divergence:</span> <span className="text-foreground/90 capitalize font-bold">{notif.metadata.divType}</span></div>
                            </div>
                          )}
                          {notif.type === "order" && (
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-left">
                              <div><span className="text-muted-foreground">Contract:</span> <span className="text-foreground/90">{notif.metadata.symbol}</span></div>
                              <div><span className="text-muted-foreground">Side:</span> <span className={cn("font-bold", notif.metadata.side === "BUY" ? "text-emerald-400" : "text-rose-400")}>{notif.metadata.side}</span></div>
                              <div><span className="text-muted-foreground">Qty:</span> <span className="text-foreground/80">{notif.metadata.qty}</span></div>
                              <div><span className="text-muted-foreground">Status:</span> <span className="text-emerald-400">Filled ✅</span></div>
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
