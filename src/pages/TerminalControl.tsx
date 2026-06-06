import { useState, useEffect } from "react";
import { 
  Settings2, Cpu, Bell, Laptop, CloudOff, Info, 
  HelpCircle, Volume2, HardDrive, RefreshCw, Layers, ShieldCheck, Zap
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useUserSettings } from "../hooks/useUserSettings";
import { notificationService } from "../lib/notificationService";
import { performanceTracker } from "../lib/performanceTracker";
import { toast } from "sonner";
import { useProfiler } from "../hooks/useProfiler";

export default function TerminalControl() {
  useProfiler("TerminalControl");
  
  const { settings, updateSetting, resetSettings } = useUserSettings();
  const [onlineStatus, setOnlineStatus] = useState<boolean>(true);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isInstallable, setIsInstallable] = useState<boolean>(false);
  const [swRegistered, setSwRegistered] = useState<boolean>(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");

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
    <div className="p-4 md:p-8 pb-32 max-w-[1200px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500">
      
      {/* Visual Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end pb-6 border-b border-white/10 border-dashed gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <Settings2 className="w-8 h-8 text-emerald-500" />
            Terminals & Control Center
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Configure PWA setups, custom local databases, notification parameters, and view institutional architectural designs.
          </p>
        </div>
        
        {/* Connection status pills */}
        <div className="flex items-center gap-2">
          {onlineStatus ? (
            <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-mono py-1 px-2.5">
              ● ONLINE TERMINAL NODE
            </Badge>
          ) : (
            <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs font-mono py-1 px-2.5 flex items-center gap-1">
              <CloudOff className="w-3 h-3" /> OFFLINE MODE ACTIVE
            </Badge>
          )}

          {swRegistered && (
            <Badge className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs font-mono py-1 px-2.5">
              Service Worker: ACTIVE
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* left column: Progressive Web App installation & Alerts */}
        <div className="space-y-6">
          
          {/* PWA Installer card */}
          <Card className="bg-[#121824]/60 border-white/5 backdrop-blur-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold tracking-wide text-slate-200 flex items-center gap-1.5">
                <Laptop className="w-4 h-4 text-emerald-400" /> Install Standalone PWA
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-1">
              <p className="text-xs text-slate-400 leading-relaxed">
                Unlock native frame modes, background notifications, custom launch screens, and smooth offline loading by compiling directly to your desktop or home screen.
              </p>

              {isInstallable ? (
                <button
                  onClick={triggerPwaInstall}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Zap className="w-4 h-4 text-yellow-300 fill-current animate-pulse" />
                  Install Quant Terminal App
                </button>
              ) : (
                <div className="bg-[#0f1422] p-3.5 rounded-lg border border-white/5 space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400">PWA Manifest</span>
                    <span className="text-emerald-400 font-mono flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5" /> Registered
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400">Installs</span>
                    <span className="text-slate-400 font-mono">Via browser URL bar</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Desktop Push Alerts card */}
          <Card className="bg-[#121824]/60 border-white/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold tracking-wide text-slate-200 flex items-center gap-1.5">
                <Bell className="w-4 h-4 text-indigo-400" /> Desktop Alerts Dispatcher
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-1">
              <p className="text-xs text-slate-400 leading-relaxed">
                Pushes rapid visual updates during option chain triggers, trade activations, or connection drops, without needing the trading tab open.
              </p>

              <div className="flex justify-between items-center bg-[#0f1422] p-2.5 rounded border border-white/5 text-xs font-mono">
                <span className="text-slate-400">Permissions:</span>
                <span className={notifPermission === 'granted' ? 'text-emerald-400' : 'text-amber-400'}>
                  {notifPermission.toUpperCase()}
                </span>
              </div>

              <button
                onClick={testAlert}
                className="w-full bg-[#121824] hover:bg-white/5 border border-white/10 text-xs font-semibold py-2.5 px-4 rounded-lg text-slate-200 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Volume2 className="w-4 h-4 text-indigo-400" />
                Trigger Sample Strike Alert
              </button>
            </CardContent>
          </Card>
        </div>

        {/* Middle column: Persistent settings panel */}
        <div className="space-y-6 md:col-span-2">
          
          {/* User parameters configuration */}
          <Card className="bg-[#121824]/60 border-white/5">
            <CardHeader>
              <CardTitle className="text-sm font-semibold tracking-wide text-slate-200">Terminal Parameter Sync</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                
                {/* Polling Interval */}
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-medium">Auto-Refetch Core Frequency</label>
                  <select
                    value={settings.refreshInterval}
                    onChange={(e) => updateSetting("refreshInterval", Number(e.target.value))}
                    className="w-full bg-[#0d131f] border border-white/10 rounded-lg py-2 px-3 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value={5000}>Extremely Fast (5 Seconds)</option>
                    <option value={10000}>Balanced Option Default (10 Seconds)</option>
                    <option value={30000}>Economic Poll Limit (30 Seconds)</option>
                    <option value={60000}>Relaxed Polling Range (1 Minute)</option>
                  </select>
                </div>

                {/* Strike Buffer size */}
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-medium">Volatile Strikes Chain Offset</label>
                  <select
                    value={settings.strikeBuffer}
                    onChange={(e) => updateSetting("strikeBuffer", Number(e.target.value))}
                    className="w-full bg-[#0d131f] border border-white/10 rounded-lg py-2 px-3 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value={3}>Super Dense (± 3 Strikes)</option>
                    <option value={5}>Ideal View Range (± 5 Strikes)</option>
                    <option value={10}>Standard Spread (± 10 Strikes)</option>
                    <option value={15}>Full Volatility Scan (± 15 Strikes)</option>
                  </select>
                </div>

                {/* Theme override */}
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-medium">Analytical Active Paint Style</label>
                  <select
                    value={settings.chartTheme}
                    onChange={(e) => updateSetting("chartTheme", e.target.value as any)}
                    className="w-full bg-[#0d131f] border border-white/10 rounded-lg py-2 px-3 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value="cosmic">Cosmic Slate Dark Theme (Deep Navy)</option>
                    <option value="neon">Neon High Contrast Tactical (Pitch Black)</option>
                    <option value="monochrome">Monochrome Slate (Charcoal & Gray)</option>
                  </select>
                </div>

                {/* Transition toggle */}
                <div className="flex items-center justify-between bg-[#0f1422] p-3 rounded-lg border border-white/5">
                  <div className="space-y-0.5">
                    <p className="text-xs text-slate-200 font-medium">Smooth GPU Animations</p>
                    <p className="text-[10px] text-slate-500">Staggers list entries</p>
                  </div>
                  <input 
                    type="checkbox"
                    checked={settings.highFpsMode}
                    onChange={(e) => updateSetting("highFpsMode", e.target.checked)}
                    className="w-4 h-4 accent-emerald-500 cursor-pointer rounded bg-[#0d131f] border-white/10"
                  />
                </div>

              </div>

              {/* Action commands */}
              <div className="flex gap-2 justify-end pt-2 border-t border-white/5">
                <button
                  onClick={resetSettings}
                  className="bg-transparent hover:bg-white/5 border border-white/5 text-slate-400 hover:text-white text-xs px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer"
                >
                  Restore Defaults
                </button>
                <button
                  onClick={() => {
                    toast.success("Settings Saved Locally", {
                      description: "Your trading terminal options have been synchronized with localStorage.",
                    });
                  }}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors cursor-pointer"
                >
                  Save Settings
                </button>
              </div>

            </CardContent>
          </Card>

        </div>
      </div>

      {/* Separation of Concerns: Architectural blueprint diagram panel */}
      <Card className="bg-[#121824]/60 border-white/5">
        <CardHeader>
          <CardTitle className="text-sm font-semibold tracking-wide text-slate-200 flex items-center gap-1.5">
            <Cpu className="w-4 h-4 text-amber-500" /> Personal Trading Terminal Architecture
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-xs text-slate-400 leading-relaxed">
            This workstation is engineered around a modular, non-blocking pipeline ensuring structural isolation between heavy calculation routines and real-time frontend charts.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            
            {/* Box 1 */}
            <div className="bg-[#0f1422] p-4 rounded-xl border border-white/5 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 text-xs font-bold font-mono">01</div>
              <p className="text-xs font-semibold text-white">Client Interface</p>
              <p className="text-[11px] text-slate-400">PWA offline shell built on Vite React + Lightweight Trading Charts (WUI).</p>
            </div>

            {/* Box 2 */}
            <div className="bg-[#0f1422] p-4 rounded-xl border border-white/5 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400 text-xs font-bold font-mono">02</div>
              <p className="text-xs font-semibold text-white">Websocket Stream</p>
              <p className="text-[11px] text-slate-400">Isolated 3s Client-Safe multi-socket feeding option ticks directly to active curves.</p>
            </div>

            {/* Box 3 */}
            <div className="bg-[#0f1422] p-4 rounded-xl border border-white/5 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-pink-500/10 flex items-center justify-center text-pink-400 text-xs font-bold font-mono">03</div>
              <p className="text-xs font-semibold text-white">Express API Backend</p>
              <p className="text-[11px] text-slate-400">Proxy layer protecting secret broker parameters & conducting Black-Scholes risk models.</p>
            </div>

            {/* Box 4 */}
            <div className="bg-[#0f1422] p-4 rounded-xl border border-white/5 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 text-xs font-bold font-mono">04</div>
              <p className="text-xs font-semibold text-white">Kite Integration</p>
              <p className="text-[11px] text-slate-400">Automated SQLITE session management & authenticated broker socket handshakes.</p>
            </div>

            {/* Box 5 */}
            <div className="bg-[#0f1422] p-4 rounded-xl border border-white/5 space-y-2">
              <div className="w-8 h-8 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400 text-xs font-bold font-mono">05</div>
              <p className="text-xs font-semibold text-white">AI Volatility Pilot</p>
              <p className="text-[11px] text-slate-400">Gemini model processing sentiment feeds into systemic volatility limits.</p>
            </div>

          </div>
        </CardContent>
      </Card>

    </div>
  );
}
