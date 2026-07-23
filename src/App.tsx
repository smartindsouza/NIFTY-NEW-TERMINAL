/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useState, useEffect } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Header } from './components/Header';
import { ActivePositions } from './components/ActivePositions';
import { Toaster } from '@/components/ui/sonner';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { Cpu, RefreshCw } from 'lucide-react';
import { useUserSettings } from './hooks/useUserSettings';

// Lazy load all terminal pages & tabs to maximize performance & reduce bundle size
const Dashboard = lazy(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const OptionChain = lazy(() => import('./pages/OptionChain').then(module => ({ default: module.OptionChain })));
const KiteLogin = lazy(() => import('./pages/KiteLogin').then(module => ({ default: module.KiteLogin })));
const FiiDii = lazy(() => import('./pages/FiiDii').then(module => ({ default: module.FiiDii })));
const News = lazy(() => import('./pages/News').then(module => ({ default: module.News })));
const AdvancedChart = lazy(() => import('./pages/AdvancedChart').then(module => ({ default: module.AdvancedChart })));

// New diagnostic lazy performance tabs / auxiliary pages
const Backtesting = lazy(() => import('./pages/Backtesting'));
const Reports = lazy(() => import('./pages/Reports'));
const AiAnalysis = lazy(() => import('./pages/AiAnalysis'));
const HistoricalAnalytics = lazy(() => import('./pages/HistoricalAnalytics'));
const TerminalControl = lazy(() => import('./pages/TerminalControl'));
const Notifications = lazy(() => import('./pages/Notifications'));
const TradeJournal = lazy(() => import('./pages/TradeJournal'));
const GapRisk = lazy(() => import('./pages/GapRisk'));
const GapScorecard = lazy(() => import('./pages/GapScorecard'));
const HLevels = lazy(() => import('./pages/HLevels'));
const RsiBacktest = lazy(() => import('./pages/RsiBacktest'));
const LiveSignal = lazy(() => import('./pages/LiveSignal'));
const SignalAlerts = lazy(() => import('./pages/SignalAlerts'));
const OptionValue = lazy(() => import('./pages/OptionValue'));
const GammaBlast = lazy(() => import('./pages/GammaBlast'));
const PremiumPulse = lazy(() => import('./pages/PremiumPulse'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30000,
      gcTime: 600000,
      retry: (failureCount, error: any) => {
        if (error?.response?.status === 429 || error?.message?.includes("429") || error?.status === 429) {
          return failureCount < 6;
        }
        return failureCount < 3;
      },
      retryDelay: (attemptIndex, error: any) => {
        if (error?.response?.status === 429 || error?.message?.includes("429") || error?.status === 429) {
          return Math.min(1000 * 2 ** attemptIndex, 60000);
        }
        return Math.min(1000 * 2 ** attemptIndex, 30000);
      },
    },
  },
});

function TerminalLoader() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4">
      <div className="relative">
        <div className="w-10 h-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin"></div>
      </div>
      <p className="text-xs text-muted-foreground font-mono">Lazy-loading terminal module...</p>
    </div>
  );
}

export default function App() {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [location] = useLocation();
  const [reloading, setReloading] = useState(false);
  // Reload button shows only on the chart page; it tells the chart (via a window
  // event the chart already listens for) to refetch history and snap to the latest candle.
  const onChart = location.startsWith('/advanced-chart');
  // The chart page's mobile toolbar has a diagnostics icon that dispatches this
  // event (the Cpu state lives here in the shell).
  useEffect(() => {
    const f = () => setShowDiagnostics(v => !v);
    window.addEventListener('toggle_diagnostics', f);
    return () => window.removeEventListener('toggle_diagnostics', f);
  }, []);
  const reloadChart = () => {
    setReloading(true);
    try { window.dispatchEvent(new CustomEvent('chart_reload')); } catch (e) {}
    // Also hard-refresh the whole app so the reload button reloads the page,
    // not just the chart data. Small delay lets the snap-to-latest fire first.
    setTimeout(() => { try { window.location.reload(); } catch (e) {} }, 150);
  };
  const { settings } = useUserSettings();

  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(settings.appTheme);
  }, [settings.appTheme]);

  useEffect(() => {
    if (settings.customFontUrl) {
      const style = document.createElement('style');
      style.id = 'custom-user-font';
      style.innerHTML = `
        @font-face {
          font-family: 'UserCustomFont';
          src: url('${settings.customFontUrl}');
          font-display: swap;
        }
        body, html, * {
          font-family: 'UserCustomFont', sans-serif !important;
        }
      `;
      document.head.appendChild(style);
      return () => {
        if (style.parentNode) style.parentNode.removeChild(style);
      };
    }
  }, [settings.customFontUrl]);

  return (
    <QueryClientProvider client={queryClient}>
      <div className={`flex flex-col bg-background text-foreground min-h-screen selection:bg-primary/30 font-sans custom-scrollbar relative ${settings.appTheme}`}>
        <style>{`
          .dark {
            --primary: ${settings.accentColor};
            --chart-1: ${settings.accentColor};
            --sidebar-primary: ${settings.accentColor};
            --ring: ${settings.accentColor}80;
          }
          :root {
            --primary: ${settings.accentColor};
            --chart-1: ${settings.accentColor};
            --sidebar-primary: ${settings.accentColor};
            --ring: ${settings.accentColor}80;
          }
          ${settings.customFontUrl ? `
          @font-face {
            font-family: 'AppCustomFont';
            src: url('${settings.customFontUrl}');
            font-display: swap;
          }
          html, body, .font-sans, .mdx-prose * {
            font-family: 'AppCustomFont', sans-serif !important;
          }
          ` : ''}
        `}</style>
        <Header />
        <main className={`flex-1 overflow-y-auto w-full relative bg-transparent pl-0 md:pl-[80px] pt-[max(env(safe-area-inset-top),12px)] md:pt-8 md:pb-12 pr-0 md:pr-6 lg:pr-8 ${onChart ? 'max-md:overflow-hidden max-md:overscroll-none pb-24 max-md:pb-0' : 'pb-24'}`}>
          <ActivePositions />
          <Suspense fallback={<TerminalLoader />}>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/option-chain" component={OptionChain} />
              <Route path="/kite-login" component={KiteLogin} />
              <Route path="/fii-dii" component={FiiDii} />
              <Route path="/news" component={News} />
              <Route path="/advanced-chart" component={AdvancedChart} />
              <Route path="/backtesting" component={Backtesting} />
              <Route path="/reports" component={Reports} />
              <Route path="/ai-analysis" component={AiAnalysis} />
              <Route path="/historical-analytics" component={HistoricalAnalytics} />
              <Route path="/terminal-control" component={TerminalControl} />
              <Route path="/notifications" component={Notifications} />
              <Route path="/journal" component={TradeJournal} />
              <Route path="/gap-risk" component={GapRisk} />
              <Route path="/gap-scorecard" component={GapScorecard} />
              <Route path="/h-levels" component={HLevels} />
              <Route path="/rsi-backtest" component={RsiBacktest} />
              <Route path="/live-signal" component={LiveSignal} />
              <Route path="/signal-alerts" component={SignalAlerts} />
              <Route path="/option-value" component={OptionValue} />
              <Route path="/gamma-blast" component={GammaBlast} />
              <Route path="/premium-pulse" component={PremiumPulse} />
              <Route>
                 <div className="p-8 text-center text-muted-foreground animate-pulse">404 - Not Found</div>
              </Route>
            </Switch>
          </Suspense>
        </main>

        {/* Global floating telemetry toggle button */}
        <button
          onClick={() => setShowDiagnostics(!showDiagnostics)}
          className={`fixed max-md:hidden ${onChart ? 'bottom-36' : 'bottom-20'} right-4 md:bottom-6 md:right-6 z-50 p-3.5 rounded-full border transition-all duration-300 flex items-center justify-center cursor-pointer ${
            showDiagnostics 
              ? 'bg-emerald-500 text-black border-emerald-400 hover:bg-emerald-400' 
              : 'bg-card text-foreground/80 border-0 hover:text-foreground hover:bg-accent hover:text-accent-foreground'
          }`}
          title="Toggle Terminal Diagnostics"
        >
          <Cpu className={`w-5 h-5 ${showDiagnostics ? 'animate-pulse' : ''}`} />
        </button>

        {/* Reload chart → refetch history and snap to the latest candle (chart page only) */}
        {onChart && (
          <button
            onClick={reloadChart}
            className="fixed bottom-36 max-md:hidden right-20 md:bottom-6 md:right-24 z-50 p-3.5 rounded-full border border-0 bg-card text-foreground/80 hover:text-foreground hover:bg-accent hover:text-accent-foreground transition-all duration-300 flex items-center justify-center cursor-pointer"
            title="Reload chart to the latest candle"
          >
            <RefreshCw className={`w-5 h-5 ${reloading ? 'animate-spin' : ''}`} />
          </button>
        )}

        {/* Floating live diagnostics view */}
        {showDiagnostics && (
          <div className={`fixed ${onChart ? 'bottom-52' : 'bottom-36'} right-3 md:bottom-20 md:right-6 z-50 w-80 md:w-96 max-h-[70vh] overflow-y-auto animate-in slide-in-from-bottom-5 duration-300 rounded-2xl `}>
            <DiagnosticsPanel />
          </div>
        )}
      </div>
      <Toaster
        theme="dark"
        position="top-center"
        visibleToasts={1}
        duration={2500}
        gap={4}
        offset="72px"
        mobileOffset="72px"
        toastOptions={{
          classNames: { toast: "cn-toast" },
          style: { fontSize: '12px', padding: '7px 12px', minHeight: '0', width: 'fit-content', maxWidth: '92vw', margin: '0 auto', borderRadius: '9999px' },
        }}
      />
    </QueryClientProvider>
  );
}
