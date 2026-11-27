/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useState, useEffect, type ComponentType } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { OptionChainHost } from './components/OptionChainSheet';
import { JodiHost } from './components/JodiCard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Header } from './components/Header';
// The live tick connection must belong to the APP, not to a piece of chrome.
import { useGlobalWebSocket } from './hooks/useWebSocket';
import { ActivePositions } from './components/ActivePositions';
import { Toaster } from '@/components/ui/sonner';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
// Today's Bias alert: polls the 09:33 note and pops up once per day, on any screen.
import { BiasAlert } from './components/BiasAlert';
import { SetupAlerts } from './components/SetupAlerts';
import { Cpu } from 'lucide-react';
import { useUserSettings, useResolvedTheme } from './hooks/useUserSettings';

// A SCREEN THAT IS ALREADY DOWNLOADED OPENS AT ONCE (27 Nov 2026). Martin: "Also
// why does it not move smoothly between screens. There is a bit of a lag when
// switching between home, chart, Journal etc. make it smoother."
// Measured on a phone-speed test copy: the FIRST visit to each screen showed
// the spinner ("Lazy-loading terminal module...") while its code was fetched —
// about 0.7 s for the chart, 0.3 s for News, 0.2 s for the Journal, on a fast
// line; longer on a phone's. Each screen is its own file, fetched when first
// opened. Later visits had no spinner.
// Two things here. (1) lazyPage: as React's lazy, but its file can be fetched
// ahead (.preload), and once it is in, the screen is drawn in the same frame as
// the tap — React's own lazy still shows the fallback for a moment even when
// the file is already there. Which of the two a screen uses is fixed when it
// mounts, so a file arriving while its screen is up never remounts it.
// (2) The bottom bar's screens are fetched in the background a little after
// the app starts (see PRELOAD below), one at a time, when the phone is idle.
type PageModule = { default: ComponentType<any> };
function lazyPage(load: () => Promise<PageModule>) {
  let Loaded: ComponentType<any> | null = null;
  let pending: Promise<PageModule> | null = null;
  const run = () => (pending ||= load().then((m) => { Loaded = m.default; return m; }, (e) => { pending = null; throw e; }));
  const Lazy = lazy(run);
  const Page = (props: any) => {
    const [Now] = useState<ComponentType<any> | null>(() => Loaded);
    return Now ? <Now {...props} /> : <Lazy {...props} />;
  };
  (Page as any).preload = () => { run().catch(() => {}); };
  return Page as ComponentType<any> & { preload: () => void };
}

// Lazy load all terminal pages & tabs to maximize performance & reduce bundle size
const Dashboard = lazyPage(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const KiteLogin = lazyPage(() => import('./pages/KiteLogin').then(module => ({ default: module.KiteLogin })));
// Separate from /fii-dii, which is the F&O participant OI page. This one is the
// CASH-market rupee flow — different dataset, different question.
const InstitutionalFlow = lazyPage(() => import('./pages/InstitutionalFlow').then(module => ({ default: module.InstitutionalFlow })));
const News = lazyPage(() => import('./pages/News').then(module => ({ default: module.News })));
// The chart route now mounts the workspace, which decides between the desktop
// split (spot left / options right) and — below md — the original single chart,
// rendered with no props and therefore on its exact previous code path.
const AdvancedChart = lazyPage(() => import('./pages/ChartWorkspace').then(module => ({ default: module.ChartWorkspace })));

// New diagnostic lazy performance tabs / auxiliary pages
const Backtesting = lazyPage(() => import('./pages/Backtesting'));
const TerminalControl = lazyPage(() => import('./pages/TerminalControl'));
const Notifications = lazyPage(() => import('./pages/Notifications'));
const TradeJournal = lazyPage(() => import('./pages/TradeJournal'));
const GapRisk = lazyPage(() => import('./pages/GapRisk'));
const GapScorecard = lazyPage(() => import('./pages/GapScorecard'));
const HLevels = lazyPage(() => import('./pages/HLevels'));
const RsiBacktest = lazyPage(() => import('./pages/RsiBacktest'));
const GammaBlast = lazyPage(() => import('./pages/GammaBlast'));
const PremiumPulse = lazyPage(() => import('./pages/PremiumPulse'));
const Research = lazyPage(() => import('./pages/Research'));
// Telegram channel calls → automatic entries with the message's SL (23 Oct 2026).
const TelegramSignals = lazyPage(() => import('./pages/TelegramSignals'));
// Martin's own option-chain indicator, Practice only (14 Nov 2026) — server/expiry_skew.ts.
const ExpirySkew = lazyPage(() => import('./pages/ExpirySkew'));

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
  // Open the live tick connection here, unconditionally. It used to be opened as
  // a side effect of rendering <Header/>, so hiding the left rail in a Strike Click
  // tab silently took the WEBSOCKET with it: that tab received no ticks at all and
  // its option chart sat on the 15s poll. A data connection must never depend on
  // whether a piece of UI happens to be on screen.
  useGlobalWebSocket();

  // True when this tab was opened as a dedicated option chart (Strike Click).
  // Must live in App itself — it is App that renders the left rail. Two earlier
  // attempts put it in TerminalLoader, which compiles cleanly and then crashes at
  // runtime, so the check below asserts the declaration and every use share a scope.
  const isFocusedChart = (() => {
    try { return new URLSearchParams(window.location.search).has('optToken'); }
    catch (e) { return false; }
  })();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  // PRELOAD (27 Nov 2026; see A SCREEN THAT IS ALREADY DOWNLOADED OPENS AT ONCE).
  // The five screens of the phone's bottom bar, fetched one after another once
  // the app has had 2.5 s to draw what was asked for, each when the phone is
  // idle — so the first tap on Chart or Journal finds its screen already in.
  // Not on a line that asks for data to be saved. Screens off the bar (More)
  // are still fetched when first opened, as before.
  useEffect(() => {
    try { if ((navigator as any).connection?.saveData) return; } catch (e) {}
    const pages = [AdvancedChart, TradeJournal, Dashboard, News, InstitutionalFlow];
    let dead = false, i = 0, timer: any = 0;
    const idle = (fn: () => void) => { const ric = (window as any).requestIdleCallback; if (ric) ric(fn, { timeout: 1500 }); else timer = setTimeout(fn, 200); };
    const next = () => { if (dead || i >= pages.length) return; pages[i++].preload(); timer = setTimeout(() => idle(next), 400); };
    timer = setTimeout(() => idle(next), 2500);
    return () => { dead = true; clearTimeout(timer); };
  }, []);
  // Tell the chart page it is covered, so the jump-to-latest bubble gets out of
  // the way instead of floating on top of this panel.
  useEffect(() => {
    try { window.dispatchEvent(new CustomEvent('chart_overlay', { detail: { id: 'app-diagnostics', open: showDiagnostics } })); } catch (e) {}
  }, [showDiagnostics]);
  const [location] = useLocation();
  // Reload button shows only on the chart page; it tells the chart (via a window
  // event the chart already listens for) to refetch history and snap to the latest candle.
  const onChart = location.startsWith('/advanced-chart');
  // The chart page's mobile toolbar has a diagnostics icon that dispatches this
  // event (the Cpu state lives here in the shell).
  useEffect(() => {
    const f = () => setShowDiagnostics(v => !v);
    // Any other button of the phone's bottom bar puts it away (Header.tsx).
    const close = () => setShowDiagnostics(false);
    window.addEventListener('toggle_diagnostics', f);
    window.addEventListener('close_diagnostics', close);
    return () => { window.removeEventListener('toggle_diagnostics', f); window.removeEventListener('close_diagnostics', close); };
  }, []);
  const { settings } = useUserSettings();

  // The class on <html> is the RESOLVED theme, so 'auto' becomes whichever the
  // OS is using — and follows it when the OS changes.
  const resolvedTheme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(resolvedTheme);
  }, [resolvedTheme]);

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
        {/* A tab opened from Strike Click is a single-contract window: no left rail
            and no page padding for it. Deliberately keyed on the URL rather than on
            "is an option showing", because the MAIN tab must keep its navigation —
            it shows the traded option after every trade, and hiding the rail there
            would strand the user with no way back. */}
        {!isFocusedChart && <Header />}
        {/* On the chart route the page fills the viewport exactly (see the chart's
            root), so the shell's desktop bottom padding would only ever be blank
            space under it. Other routes keep their padding. */}
        {/* On the chart route this is a fixed-height flex COLUMN: the positions
            banner takes its natural height and the chart page fills exactly what
            is left. Previously the chart page sized itself to the whole viewport
            while sitting BELOW the banner, so the banner's height overflowed the
            screen — that is the vertical scroll. md:pt-4 (was pt-8) buys the
            banner most of its space back. */}
        {/* ON A PHONE THE CHART ROUTE SCROLLS (17 Nov 2026). It used to be clipped
            here (overflow hidden) because the chart page was the whole screen and
            anything taller was a mistake. Martin asked for "a vertical scrolling
            screen in the charts section": the chart page is the first screen and
            its cards follow it, so the document scrolls, as it does on every
            other route. The page sizes its own first screen (see THE PHONE'S PAGE
            ENDS WHERE THE FIXED BUTTONS BEGIN in AdvancedChart). The desktop is as
            it was: a fixed-height column that does not scroll. */}
        <main className={`flex-1 w-full relative bg-transparent pl-0 ${isFocusedChart ? '' : 'md:pl-[80px]'} pt-[max(env(safe-area-inset-top),12px)] ${onChart ? 'md:pt-0 md:pb-0 md:h-screen md:min-h-0 md:flex-none md:flex md:flex-col md:overflow-hidden' : 'md:pt-8 md:pb-12 overflow-y-auto'} pr-0 ${onChart ? '' : 'md:pr-6 lg:pr-8'} ${onChart ? 'pb-24 max-md:pb-0' : 'pb-24'}`}>
          <ActivePositions />
          <Suspense fallback={<TerminalLoader />}>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/kite-login" component={KiteLogin} />
              {/* /fii-dii kept as a redirect target only: the old F&O positioning
                  page is retired, so any saved link or stale bundle lands on its
                  replacement rather than a dead route. */}
              <Route path="/fii-dii" component={InstitutionalFlow} />
              <Route path="/institutional-flow" component={InstitutionalFlow} />
              <Route path="/news" component={News} />
              <Route path="/advanced-chart" component={AdvancedChart} />
              <Route path="/backtesting" component={Backtesting} />
              <Route path="/terminal-control" component={TerminalControl} />
              <Route path="/notifications" component={Notifications} />
              {/* /journal and /journal/analysis are ONE route on purpose: the
                  analysis page is the journal's second screen, and as a route of
                  its own it would be a second mount — the journal loaded again,
                  the period chosen forgotten. A path, so the phone's back goes
                  back to the journal. */}
              <Route path="/journal/:view?" component={TradeJournal} />
              <Route path="/gap-risk" component={GapRisk} />
              <Route path="/gap-scorecard" component={GapScorecard} />
              <Route path="/h-levels" component={HLevels} />
              <Route path="/rsi-backtest" component={RsiBacktest} />
              <Route path="/gamma-blast" component={GammaBlast} />
              <Route path="/premium-pulse" component={PremiumPulse} />
              <Route path="/research" component={Research} />
              <Route path="/telegram-signals" component={TelegramSignals} />
              <Route path="/expiry-skew" component={ExpirySkew} />
              {/* Retired screens (17 Nov 2026, see RETIRED SCREENS in Header.tsx):
                  a saved link or a stale bundle lands on the home page rather
                  than on "404". */}
              <Route path="/option-chain"><Redirect to="/" /></Route>
              <Route path="/reports"><Redirect to="/" /></Route>
              <Route path="/ai-analysis"><Redirect to="/" /></Route>
              <Route path="/historical-analytics"><Redirect to="/" /></Route>
              <Route path="/live-signal"><Redirect to="/" /></Route>
              <Route path="/signal-alerts"><Redirect to="/" /></Route>
              <Route path="/option-value"><Redirect to="/" /></Route>
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
          title="Toggle App Diagnostics"
        >
          <Cpu className={`w-5 h-5 ${showDiagnostics ? 'animate-pulse' : ''}`} />
        </button>

        {/* The floating reload button is gone: every chart already carries its own
            refresh in its toolbar, and unlike this one that refreshes the chart
            you are looking at rather than hard-reloading the whole app. Two
            controls a few pixels apart, one of which silently reloaded the page,
            was the wrong pair to leave next to the diagnostics toggle. */}

        {/* Floating live diagnostics view.
            PHONE: IT IS A SCREEN OF ITS OWN, OVER EVERYTHING BUT THE APP'S BOTTOM
            BAR (17 Nov 2026). It runs from under the app header to 8px above
            the bottom bar on every page, the chart page included, and it is
            drawn over the chart's own tool bar (the row of five and Option
            Chain | ScalpPro). Until now it stopped at that tool bar on the
            chart page, so its readout was cut off where the chart's buttons
            began and looked as though it carried on beneath them. Martin said
            so twice — of v309: "appears below the option chain/Scalp pro
            buttons as well as the other bottom icons. Make it show above it
            without affecting their touch"; and after v310 had only moved its
            foot 8px clear of them: "still appears below the bottom bar". The
            bottom bar is never covered, so Diag still closes it and every tab
            still works; the chart's buttons are simply under it while it is
            open and are what they were when it closes. It has its own frame
            (border, corners) so that its foot is seen to end above the bar
            whatever part of the readout is scrolled into it. Desktop keeps the
            floating card. */}
        {/* The page it stands on is put away while it is open (phone): a plain
            sheet of the app's background from the top of the screen to the
            bottom bar, under the panel. Without it the page showed round the
            panel's rounded corners — on the chart page, the white ScalpPro
            button, as a bright sliver at its foot. */}
        {showDiagnostics && <div data-diagnostics-back="" className="md:hidden fixed inset-x-0 top-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-[49] bg-background" aria-hidden="true" />}
        {showDiagnostics && (
          <div data-diagnostics="" className="fixed inset-x-2 top-[60px] bottom-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)] md:inset-x-auto md:top-auto md:bottom-20 md:right-6 z-50 md:w-96 max-h-none md:max-h-[70vh] overflow-y-auto overflow-x-hidden animate-in slide-in-from-bottom-5 duration-300 rounded-2xl max-md:bg-card max-md:border max-md:border-foreground/15">
            <DiagnosticsPanel />
          </div>
        )}
      </div>
      <BiasAlert />
      <SetupAlerts />
      <OptionChainHost />
      <JodiHost />
      {/* The toast follows the app's theme (18 Nov 2026). It was always told
          "dark" while its box takes the theme's colour — so in the light theme
          its second line was the dark theme's pale grey on white (Martin's
          picture of "Settings Saved Locally" with the line under it unreadable). */}
      <Toaster
        theme={resolvedTheme}
        position="top-center"
        visibleToasts={1}
        duration={2500}
        gap={4}
        offset={{ top: '72px' }}
        mobileOffset={{ top: '72px', left: '12px', right: '12px' }}
        toastOptions={{
          classNames: { toast: "cn-toast" },
          style: { fontSize: '12px', padding: '7px 12px', minHeight: '0', width: 'fit-content', maxWidth: 'calc(100vw - 24px)', margin: '0 auto', borderRadius: '9999px' },
        }}
      />
    </QueryClientProvider>
  );
}
