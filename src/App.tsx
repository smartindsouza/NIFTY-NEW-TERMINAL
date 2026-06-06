/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useState } from 'react';
import { Route, Switch } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Header } from './components/Header';
import { Toaster } from '@/components/ui/sonner';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { Cpu } from 'lucide-react';

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30000,
      gcTime: 600000,
      retry: (failureCount, error: any) => {
        // Stop retrying if wait too long, but allow up to 6 retries for 429
        if (error?.response?.status === 429 || error?.message?.includes("429") || error?.status === 429) {
          return failureCount < 6;
        }
        return failureCount < 3;
      },
      retryDelay: (attemptIndex, error: any) => {
        if (error?.response?.status === 429 || error?.message?.includes("429") || error?.status === 429) {
          // Exponential backoff
          return Math.min(1000 * 2 ** attemptIndex, 60000); // Max 60 seconds
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

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex flex-col bg-background text-foreground min-h-screen selection:bg-primary/30 font-sans dark custom-scrollbar p-4 md:p-6 lg:p-8 gap-4 relative">
        <Header />
        <main className="flex-1 overflow-y-auto w-full relative bg-transparent pt-24 md:pt-28 pb-12">
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
              <Route>
                 <div className="p-8 text-center text-muted-foreground animate-pulse">404 - Not Found</div>
              </Route>
            </Switch>
          </Suspense>
        </main>

        {/* Global floating telemetry toggle button */}
        <button
          onClick={() => setShowDiagnostics(!showDiagnostics)}
          className={`fixed bottom-6 right-6 z-50 p-3.5 rounded-full shadow-2xl border transition-all duration-300 flex items-center justify-center cursor-pointer ${
            showDiagnostics 
              ? 'bg-emerald-500 text-black border-emerald-400 hover:bg-emerald-400' 
              : 'bg-[#121824] text-slate-300 border-white/10 hover:text-white hover:bg-white/5'
          }`}
          title="Toggle Terminal Diagnostics"
        >
          <Cpu className={`w-5 h-5 ${showDiagnostics ? 'animate-pulse' : ''}`} />
        </button>

        {/* Floating live diagnostics view */}
        {showDiagnostics && (
          <div className="fixed bottom-20 right-6 z-50 w-80 md:w-96 max-h-[70vh] overflow-y-auto animate-in slide-in-from-bottom-5 duration-300 rounded-2xl shadow-2xl">
            <DiagnosticsPanel />
          </div>
        )}
      </div>
      {/* <Toaster theme="dark" closeButton /> */}
    </QueryClientProvider>
  );
}

