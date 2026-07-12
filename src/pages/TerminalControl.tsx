import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { 
  Settings2, Cpu, Bell, Laptop, CloudOff, Info, 
  HelpCircle, Volume2, HardDrive, RefreshCw, Layers, ShieldCheck, Zap,
  Globe, Copy, Check
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useUserSettings } from "../hooks/useUserSettings";
import { notificationService } from "../lib/notificationService";
import { performanceTracker } from "../lib/performanceTracker";
import { toast } from "sonner";
import { useProfiler } from "../hooks/useProfiler";
import { cn } from "@/lib/utils";

function getContrastColor(hexColor: string) {
  const hex = (hexColor || "#a855f7").replace(/^\s*#|\s*$/g, '');
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? '#101828' : '#ffffff';
  } else if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? '#101828' : '#ffffff';
  }
  return '#ffffff';
}

export default function TerminalControl() {
  useProfiler("TerminalControl");
  const [, setLocation] = useLocation();
  
  const { settings, updateSetting, resetSettings } = useUserSettings();
  const [onlineStatus, setOnlineStatus] = useState<boolean>(true);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isInstallable, setIsInstallable] = useState<boolean>(false);
  const [swRegistered, setSwRegistered] = useState<boolean>(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");

  const [serverIp, setServerIp] = useState<string>("");
  const [loadingIp, setLoadingIp] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const fetchServerIp = async () => {
    setLoadingIp(true);
    try {
      const res = await fetch("/api/server-ip");
      if (res.ok) {
        const data = await res.json();
        if (data.ip) {
          setServerIp(data.ip);
        } else {
          setServerIp("Error retrieving IP");
        }
      } else {
        setServerIp("Error retrieving IP");
      }
    } catch (err) {
      console.error(err);
      setServerIp("Error retrieving IP");
    } finally {
      setLoadingIp(false);
    }
  };

  const handleCopyIp = () => {
    if (!serverIp || serverIp === "Fetching Outbound IP..." || serverIp.includes("Error") || serverIp === "unknown") {
      toast.error("No valid IP to copy");
      return;
    }
    navigator.clipboard.writeText(serverIp);
    setCopied(true);
    toast.success("IP Copied to Clipboard", {
      description: `${serverIp} is copied. Paste this into your Kite developer app settings under Whitelisted IPs.`,
    });
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    fetchServerIp();
  }, []);

  // Track online/offline status & custom installation prompts
  useEffect(() => {
    setOnlineStatus(navigator.onLine);
    setNotifPermission(notificationService.getPermission());

    const handleOnline = () => setOnlineStatus(true);
    const handleOffline = () => setOnlineStatus(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Track active service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        setSwRegistered(!!reg);
      });
    }

    // Capture PWA installation triggers
    const handleInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setIsInstallable(true);
    };

    window.addEventListener("beforeinstallprompt", handleInstallPrompt);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
    };
  }, []);

  // Request notifications and send a dry-run mock strike alert
  const testAlert = async () => {
    const permission = await notificationService.requestPermission();
    setNotifPermission(permission);

    if (permission === 'granted') {
      notificationService.send({
        title: "⚡ VOLATILITY THRESHOLD ALARM",
        body: "NIFTY 50 breached 1-SD Upper barrier at 22,185. Index premium decay accelerating.",
        tag: "nifty-sd-breach",
      });
    }

    notificationService.add(
      'system',
      "VOLATILITY THRESHOLD ALARM",
      "NIFTY 50 breached 1-SD Upper barrier at 22,185. Index premium decay accelerating."
    );
  };

  // Triggers native installation window
  const triggerPwaInstall = async () => {
    if (!deferredPrompt) {
      toast.info("PWA Ready", {
        description: "Terminal is already running or installable via your browser address bar.",
      });
      return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`[PWA User choice outcome]: ${outcome}`);
    setDeferredPrompt(null);
    setIsInstallable(false);
  };

  return (
    <div className="p-4 md:p-8 pb-32 max-w-[1600px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500">
      
      {/* Visual Header */}
      <div className="relative bg-card border border-border rounded-xl p-4 md:p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 overflow-hidden before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-primary/40 before:to-transparent">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <Settings2 className="w-7 h-7 md:w-8 md:h-8 text-primary" />
            Terminals & Control Center
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Configure PWA setups, custom local databases, notification parameters, and view institutional architectural designs.
          </p>
        </div>
        
        {/* Connection status pills */}
        <div className="flex items-center gap-2 flex-wrap">
          {onlineStatus ? (
            <Badge className="bg-primary/10 text-primary border border-primary/20 text-xs font-mono py-1 px-2.5">
              ● ONLINE TERMINAL NODE
            </Badge>
          ) : (
            <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs font-mono py-1 px-2.5 flex items-center gap-1">
              <CloudOff className="w-3 h-3" /> OFFLINE MODE ACTIVE
            </Badge>
          )}

          {swRegistered && (
            <Badge className="bg-primary/10 text-primary border border-primary/20 text-xs font-mono py-1 px-2.5">
              Service Worker: ACTIVE
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* left column: Progressive Web App installation & Alerts */}
        <div className="space-y-6">
          
          {/* Kite IP Whitelisting card */}
          <Card className="bg-card border-0 backdrop-blur-xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-cyan-400"></div>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold tracking-wide text-foreground/90 flex items-center gap-1.5">
                <Globe className="w-4 h-4 text-cyan-400" /> Kite Developer Portal Whitelist IP
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-1">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Kite Connect requires you to whitelist your server's outbound IP address. Add this dynamic IP in the Zerodha developer console to prevent credential verification failures.
              </p>
              
              <div className="bg-muted/30 p-3 rounded-lg border border-muted-foreground/10 flex flex-col gap-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Dynamic Outbound IP</span>
                  <button 
                    onClick={fetchServerIp}
                    disabled={loadingIp}
                    className="text-[10px] text-primary hover:underline font-mono flex items-center gap-1 hover:text-primary/80 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingIp ? "animate-spin" : ""}`} /> Refresh
                  </button>
                </div>
                
                <div className="flex items-center justify-between gap-2 overflow-hidden">
                  <div className="font-mono text-sm font-bold text-cyan-400 bg-background/65 px-3 py-2.5 rounded-lg border border-border/10 flex-1 truncate select-all flex items-center justify-between">
                    {loadingIp ? (
                      <span className="text-muted-foreground animate-pulse text-xs">Fetching Outbound IP...</span>
                    ) : (
                      serverIp || "Not fetched"
                    )}
                  </div>
                  
                  <button
                    onClick={handleCopyIp}
                    disabled={!serverIp || loadingIp || serverIp.includes("Error")}
                    className="p-2.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-lg transition-colors border border-primary/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    title="Copy to Clipboard"
                  >
                    {copied ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <div className="mt-2 pt-2 border-t border-muted-foreground/10 text-[11px] text-muted-foreground leading-relaxed">
                  This is the IP your trades exit from. Whitelist it in your Kite developer app under <span className="text-foreground/80 font-semibold">Profile → IP Whitelist</span>.
                </div>
                
              </div>

              <a 
                href="https://developer.kite.trade" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="w-full bg-primary/10 hover:bg-primary/15 text-primary text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer border border-primary/20"
              >
                Go to Kite Developer Console
              </a>
            </CardContent>
          </Card>

          {/* PWA Installer card */}
          <Card className="bg-card border-0 backdrop-blur-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold tracking-wide text-foreground/90 flex items-center gap-1.5">
                <Laptop className="w-4 h-4 text-primary" /> Install Standalone PWA
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-1">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Unlock native frame modes, background notifications, custom launch screens, and smooth offline loading by compiling directly to your desktop or home screen.
              </p>

              {isInstallable ? (
                <button
                  onClick={triggerPwaInstall}
                  className="w-full bg-primary hover:bg-primary/95 text-primary-foreground text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Zap className="w-4 h-4 text-white fill-current animate-pulse" />
                  Install Quant Terminal App
                </button>
              ) : (
                <div className="bg-card p-3.5 rounded-lg border border-0 space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">PWA Manifest</span>
                    <span className="text-primary font-mono flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-primary" /> Registered
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-muted-foreground">Installs</span>
                    <span className="text-muted-foreground font-mono">Via browser URL bar</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Desktop Push Alerts card */}
          <Card className="bg-card border-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold tracking-wide text-foreground/90 flex items-center gap-1.5">
                <Bell className="w-4 h-4 text-primary" /> Desktop Alerts Dispatcher
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-1">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Pushes rapid visual updates during option chain triggers, trade activations, or connection drops, without needing the trading tab open.
              </p>

              <div className="flex justify-between items-center bg-card p-2.5 rounded border border-0 text-xs font-mono">
                <span className="text-muted-foreground">Permissions:</span>
                <span className={notifPermission === 'granted' ? 'text-primary' : 'text-primary'}>
                  {notifPermission.toUpperCase()}
                </span>
              </div>

              <button
                onClick={testAlert}
                className="w-full bg-card hover:bg-accent hover:text-accent-foreground border border-0 text-xs font-semibold py-2.5 px-4 rounded-lg text-foreground/90 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Volume2 className="w-4 h-4 text-primary" />
                Trigger Sample Strike Alert
              </button>
            </CardContent>
          </Card>
        </div>

        {/* Middle column: Persistent settings panel */}
        <div className="space-y-6 md:col-span-2">
          
          {/* User parameters configuration */}
          <Card className="bg-card border-0">
            <CardHeader>
              <CardTitle className="text-sm font-semibold tracking-wide text-foreground/90">Terminal Parameter Sync</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                
                {/* Polling Interval */}
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-medium">Auto-Refetch Core Frequency</label>
                  <select
                    value={settings.refreshInterval}
                    onChange={(e) => updateSetting("refreshInterval", Number(e.target.value))}
                    className="w-full bg-card border border-0 rounded-lg py-2 px-3 text-xs text-foreground focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value={5000}>Extremely Fast (5 Seconds)</option>
                    <option value={10000}>Balanced Option Default (10 Seconds)</option>
                    <option value={30000}>Economic Poll Limit (30 Seconds)</option>
                    <option value={60000}>Relaxed Polling Range (1 Minute)</option>
                  </select>
                </div>

                {/* Strike Buffer size */}
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-medium">Volatile Strikes Chain Offset</label>
                  <select
                    value={settings.strikeBuffer}
                    onChange={(e) => updateSetting("strikeBuffer", Number(e.target.value))}
                    className="w-full bg-card border border-0 rounded-lg py-2 px-3 text-xs text-foreground focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value={3}>Super Dense (± 3 Strikes)</option>
                    <option value={5}>Ideal View Range (± 5 Strikes)</option>
                    <option value={10}>Standard Spread (± 10 Strikes)</option>
                    <option value={15}>Full Volatility Scan (± 15 Strikes)</option>
                  </select>
                </div>

                {/* UI Theme toggle */}
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-medium">App Theme</label>
                  <select
                    value={settings.appTheme}
                    onChange={(e) => updateSetting("appTheme", e.target.value as any)}
                    className="w-full bg-card border border-0 rounded-lg py-2 px-3 text-xs text-foreground focus:outline-none focus:border-primary transition-colors"
                  >
                    <option value="dark">Dark Theme (Default)</option>
                    <option value="light">Light Theme</option>
                  </select>
                </div>

                {/* Accent Color */}
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-medium">Global Accent Color</label>
                  <div className="flex items-center gap-3">
                    <div className="relative w-10 h-10 rounded-full overflow-hidden border border-muted-foreground/15 cursor-pointer shrink-0">
                      <input
                        type="color"
                        value={settings.accentColor}
                        onChange={(e) => updateSetting("accentColor", e.target.value)}
                        className="absolute inset-0 w-[200%] h-[200%] -translate-x-1/4 -translate-y-1/4 cursor-pointer p-0 border-0 outline-none bg-transparent"
                        style={{ appearance: "none", WebkitAppearance: "none" }}
                      />
                      <div 
                        className="absolute inset-0 pointer-events-none rounded-full" 
                        style={{ backgroundColor: settings.accentColor }}
                      />
                    </div>
                    <input
                      type="text"
                      value={settings.accentColor}
                      onChange={(e) => updateSetting("accentColor", e.target.value)}
                      className="w-full bg-card border border-0 rounded-lg py-2 px-3 text-xs text-foreground focus:outline-none focus:border-primary transition-colors font-mono"
                    />
                  </div>
                  <div className="pt-1">
                    <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mb-1.5 flex items-center gap-1">
                      <span>Presets (Excluded red & green)</span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { name: "Purple", hex: "#a855f7" },
                        { name: "Indigo", hex: "#6366f1" },
                        { name: "Royal Blue", hex: "#3b82f6" },
                        { name: "Cyan Breeze", hex: "#06b6d4" },
                        { name: "Sunset Gold", hex: "#f97316" },
                        { name: "Vibrant Yellow", hex: "#eab308" },
                        { name: "Orchid Pink", hex: "#ec4899" },
                        { name: "Premium Lavender", hex: "#8b5cf6" },
                        { name: "Slate Grey", hex: "#64748b" }
                      ].map((preset) => (
                        <button
                          key={preset.hex}
                          type="button"
                          onClick={() => updateSetting("accentColor", preset.hex)}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all cursor-pointer ${
                            settings.accentColor.toLowerCase() === preset.hex.toLowerCase()
                              ? "border-primary bg-primary/10 text-primary scale-105"
                              : "border-muted-foreground/10 bg-card/40 hover:border-muted-foreground/30 text-muted-foreground"
                          }`}
                        >
                          <span
                            className="w-2 h-2 rounded-full inline-block shrink-0"
                            style={{ backgroundColor: preset.hex }}
                          />
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Custom Font Upload */}
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-xs text-muted-foreground font-medium">Custom Font (.ttf / .woff2)</label>
                  <div className="flex gap-2">
                    <input
                      type="file"
                      accept=".ttf,.woff,.woff2,.otf"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            if (event.target?.result) {
                              updateSetting("customFontUrl", event.target.result as string);
                            }
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                      className="w-full bg-card border border-0 rounded-lg py-1.5 px-3 text-xs text-foreground focus:outline-none focus:border-primary transition-colors file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/20"
                    />
                    {settings.customFontUrl && (
                      <button 
                        onClick={() => updateSetting("customFontUrl", "")}
                        className="px-3 py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 text-xs rounded-lg transition-colors border border-red-500/20"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {settings.customFontUrl && <p className="text-[10px] text-green-500 mt-1">Font loaded successfully.</p>}
                </div>

                {/* Transition toggle */}
                <div className="flex items-center justify-between bg-card p-3 rounded-lg border border-0 sm:col-span-2">
                  <div className="space-y-0.5">
                    <p className="text-xs text-foreground font-medium">Smooth GPU Animations</p>
                    <p className="text-[10px] text-muted-foreground">Staggers list entries</p>
                  </div>
                  <input 
                    type="checkbox"
                    checked={settings.highFpsMode}
                    onChange={(e) => updateSetting("highFpsMode", e.target.checked)}
                    className="w-4 h-4 accent-primary cursor-pointer rounded bg-card border-0"
                  />
                </div>

              </div>

              {/* Action commands */}
              <div className="flex gap-2 justify-end pt-2 border-t border-0">
                <button
                  onClick={resetSettings}
                  className="bg-transparent hover:bg-accent hover:text-accent-foreground border border-0 text-muted-foreground hover:text-foreground text-xs px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer"
                >
                  Restore Defaults
                </button>
                <button
                  onClick={() => {
                    toast.success("Settings Saved Locally", {
                      description: "Your trading terminal options have been synchronized with localStorage.",
                    });
                    setLocation("/");
                  }}
                  style={{
                    backgroundColor: settings.accentColor,
                    color: getContrastColor(settings.accentColor)
                  }}
                  className="hover:opacity-90 text-xs font-semibold px-4 py-2 rounded-lg transition-all cursor-pointer shadow-sm active:scale-95"
                >
                  Save Settings
                </button>
              </div>

            </CardContent>
          </Card>

        </div>
      </div>

      {/* Separation of Concerns: Architectural blueprint diagram panel */}
      <Card className="bg-card border-0">
        <CardHeader>
          <CardTitle className="text-sm font-semibold tracking-wide text-foreground/90 flex items-center gap-1.5">
            <Cpu className="w-4 h-4 text-primary" /> Personal Trading Terminal Architecture
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-xs text-muted-foreground leading-relaxed">
            This workstation is engineered around a modular, non-blocking pipeline ensuring structural isolation between heavy calculation routines and real-time frontend charts.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            
            {/* Box 1 */}
            <div className="bg-card p-4 rounded-xl border border-0 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 text-xs font-bold font-mono">01</div>
              <p className="text-xs font-semibold text-foreground">Client Interface</p>
              <p className="text-[11px] text-muted-foreground">PWA offline shell built on Vite React + Lightweight Trading Charts (WUI).</p>
            </div>

            {/* Box 2 */}
            <div className="bg-card p-4 rounded-xl border border-0 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400 text-xs font-bold font-mono">02</div>
              <p className="text-xs font-semibold text-foreground">Websocket Stream</p>
              <p className="text-[11px] text-muted-foreground">Isolated 3s Client-Safe multi-socket feeding option ticks directly to active curves.</p>
            </div>

            {/* Box 3 */}
            <div className="bg-card p-4 rounded-xl border border-0 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-pink-500/10 flex items-center justify-center text-pink-400 text-xs font-bold font-mono">03</div>
              <p className="text-xs font-semibold text-foreground">Express API Backend</p>
              <p className="text-[11px] text-muted-foreground">Proxy layer protecting secret broker parameters & conducting Black-Scholes risk models.</p>
            </div>

            {/* Box 4 */}
            <div className="bg-card p-4 rounded-xl border border-0 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 text-xs font-bold font-mono">04</div>
              <p className="text-xs font-semibold text-foreground">Kite Integration</p>
              <p className="text-[11px] text-muted-foreground">Automated SQLITE session management & authenticated broker socket handshakes.</p>
            </div>

            {/* Box 5 */}
            <div className="bg-card p-4 rounded-xl border border-0 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400 text-xs font-bold font-mono">05</div>
              <p className="text-xs font-semibold text-foreground">AI Volatility Pilot</p>
              <p className="text-[11px] text-muted-foreground">Gemini model processing sentiment feeds into systemic volatility limits.</p>
            </div>

          </div>
        </CardContent>
      </Card>

    </div>
  );
}
