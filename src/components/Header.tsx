import { Link, useLocation } from 'wouter';
import { Home, List, TrendingUp, Newspaper, Activity, LogIn, CheckCircle2, BarChart2, PlayCircle, FileText, Sparkles, LineChart, Settings2, Bell, Menu, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useGlobalWebSocket } from '../hooks/useWebSocket';
import { useNotifications } from '../hooks/useNotifications';

export function Header() {
  const [location] = useLocation();
  const { status: wsStatus } = useGlobalWebSocket();
  const { unreadCount } = useNotifications();
  const [moreOpen, setMoreOpen] = useState(false);

  const { data: authStatus } = useQuery({
    queryKey: ['auth-status'],
    queryFn: async () => {
      const res = await axios.get('/api/auth/status');
      return res.data;
    },
    refetchInterval: 60000
  });

  const { data: proxyStatus } = useQuery({
    queryKey: ['proxy-status-sidebar'],
    queryFn: async () => {
      const res = await axios.get('/api/diagnostics/proxy');
      return res.data;
    },
    refetchInterval: 30000
  });

  const isProxyAlive = proxyStatus?.alive ?? false;

  const { data: newsData } = useQuery({
    queryKey: ['live-news-sidebar'],
    queryFn: async () => {
      const res = await axios.get('/api/news/live');
      return res.data;
    },
    refetchInterval: 15000
  });

  const news = newsData?.news || [];

  const hasUnseenNiftyNews = useMemo(() => {
    if (!news || news.length === 0) return false;
    const latestNews = news[0];
    const headline = latestNews?.headline;
    if (!headline) return false;
    const isNifty = headline.toLowerCase().includes('nifty');
    if (!isNifty) return false;
    
    try {
      const lastSeenId = localStorage.getItem('lastSeenNewsId');
      if (lastSeenId === latestNews.id) return false;
    } catch(e) {}
    
    return true;
  }, [news]);

  useEffect(() => {
    if (location === '/news' && news && news.length > 0) {
       try {
         localStorage.setItem('lastSeenNewsId', news[0].id);
       } catch(e) {}
    }
  }, [location, news]);

  const links = [
    { href: '/', label: 'Dashboard', icon: Home },
    { href: '/advanced-chart', label: 'Advanced Chart', icon: LineChart },
    { href: '/option-chain', label: 'Option Chain', icon: List },
    { href: '/fii-dii', label: 'FII / DII', icon: BarChart2 },
    { href: '/news', label: 'News & Alerts', icon: Newspaper },
    { href: '/backtesting', label: 'Backtesting', icon: PlayCircle },
    { href: '/reports', label: 'Reports', icon: FileText },
    { href: '/ai-analysis', label: 'AI Pilot', icon: Sparkles },
    { href: '/historical-analytics', label: 'Index History', icon: TrendingUp },
    { href: '/terminal-control', label: 'Control', icon: Settings2 },
    { href: '/notifications', label: 'Notifications', icon: Bell },
    { href: '/journal', label: 'Trade Journal', icon: BookOpen },
  ];

  // Mobile bottom-bar groupings: 4 primary tabs + a "More" sheet for the rest
  const primaryHrefs = ['/', '/advanced-chart', '/option-chain', '/notifications'];
  const shortLabels: Record<string, string> = {
    '/': 'Home', '/advanced-chart': 'Chart', '/option-chain': 'Chain', '/notifications': 'Alerts',
  };
  const primaryLinks = primaryHrefs
    .map((h) => links.find((l) => l.href === h))
    .filter(Boolean) as typeof links;
  const moreLinks = links.filter((l) => !primaryHrefs.includes(l.href));

  return (
    <>
    <header className="fixed top-0 left-0 z-50 w-16 h-screen py-6 bg-sidebar border-r border-sidebar-border hidden md:flex flex-col items-center gap-5 shrink-0 transition-all duration-300 select-none">
      {/* Brand Logo */}
      <Link href="/" className="flex flex-col items-center gap-2 cursor-pointer group pb-4 border-b border-sidebar-border shrink-0 w-full">
        <div className="w-9 h-9 flex items-center justify-center rounded-lg bg-primary/20 text-primary transition-transform duration-300 group-hover:scale-105">
          <Activity className="w-5 h-5" />
        </div>
        <div className="hidden sm:flex flex-col">
          <span className="font-mono text-[10px] tracking-widest font-black text-slate-100">NSE</span>
        </div>
      </Link>

      {/* Navigation tabs with vertical scrollability & exact-fitting contents */}
      <div className="overflow-visible px-1 flex-1 flex justify-center w-full">
        <nav className="flex flex-col items-center gap-1.5 w-full">
          {links.map((link) => {
            const active = location === link.href;
            const Icon = link.icon;
            const isNewsTab = link.href === '/news';
            const isNotifTab = link.href === '/notifications';
            const showBlink = (isNewsTab && hasUnseenNiftyNews) || (isNotifTab && unreadCount > 0);
            return (
              <Link 
                key={link.href} 
                href={link.href} 
                className={cn(
                  "flex items-center justify-center w-10 h-10 rounded-lg transition-all duration-500 ease-in-out relative group shrink-0 cursor-pointer select-none border border-transparent",
                  active 
                    ? "text-primary bg-primary/10 border-primary/20" 
                    : "text-muted-foreground hover:text-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {showBlink && !active && (
                  <div className="absolute top-1 right-1 w-1.5 rounded-full bg-red-500 animate-ping z-20" />
                )}
                <Icon className={cn("w-5 h-5 relative z-10 transition-all duration-500 ease-in-out", active && "scale-110", showBlink && !active && "text-red-400 animate-pulse")} />
                {showBlink && !active && (
                  <span className="absolute top-1 right-1 w-1 h-1 bg-red-500 rounded-full border border-sidebar z-20"></span>
                )}
                
                {/* Clean, high-fidelity hover tooltip showing the tab's label - changed from top to right */}
                <span className="absolute left-full ml-4 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-popover border border-0 rounded-lg text-[10px] font-bold tracking-wider uppercase font-mono whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 pointer-events-none z-[100] text-popover-foreground ">
                  {link.label}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Connection metrics on the bottom */}
      <div className="flex flex-col items-center gap-2 pt-4 border-t border-sidebar-border shrink-0 w-full">
        {/* Kite Connect Status */}
        <Link href="/kite-login" className={cn(
          "flex items-center justify-center w-10 h-10 rounded-full transition-all duration-300 relative group border border-transparent hover:border-0",
          authStatus?.status === 'connected' ? 'text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20' : 'text-rose-500 bg-rose-500/10 hover:bg-rose-500/20',
          location === '/kite-login' && 'bg-white/5 text-foreground'
        )}>
          <span className="absolute left-full ml-4 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-popover border border-0 rounded-lg text-[10px] font-bold tracking-wider uppercase font-mono whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 pointer-events-none z-[100] text-popover-foreground ">
            Kite Connect: {authStatus?.status === 'connected' ? 'CONNECTED' : 'EXPIRED'}
          </span>
          {authStatus?.status === 'connected' ? <CheckCircle2 className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
        </Link>

        {/* Proxy Status Indicator */}
        <Link href="/terminal-control" className={cn(
          "flex items-center justify-center w-10 h-10 rounded-full transition-all duration-300 relative group border border-transparent hover:border-0",
          isProxyAlive ? 'text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20' : 'text-rose-500 bg-rose-500/10 hover:bg-rose-500/20',
          location === '/terminal-control' && 'bg-white/5 text-foreground'
        )}>
          <span className="absolute left-full ml-4 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-popover border border-0 rounded-lg text-[10px] font-bold tracking-wider uppercase font-mono whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 pointer-events-none z-[100] text-popover-foreground flex flex-col items-start gap-0.5">
            <span>Proxy: {isProxyAlive ? "Live" : "Down"}</span>
            {proxyStatus?.egressIp && <span className="text-[9px] opacity-75 lowercase font-normal">Egress: {proxyStatus.egressIp}</span>}
          </span>
          <div className="flex flex-col items-center justify-center gap-0.5">
            <span className={cn("relative inline-flex rounded-full h-2 w-2 transition-colors duration-500", isProxyAlive ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500')} />
            <span className="text-[8px] font-bold tracking-wider uppercase font-mono">Proxy</span>
          </div>
        </Link>

        {/* Live signals ping indicator */}
        <div className={cn(
          "flex items-center justify-center w-10 h-10 rounded-full border border-transparent transition-all duration-300 relative group cursor-pointer",
          wsStatus === 'Connected' ? 'text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20' : 'text-rose-500 bg-rose-500/10 hover:bg-rose-500/20'
        )}>
          <span className="absolute left-full ml-4 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-popover border border-0 rounded-lg text-[10px] font-bold tracking-wider uppercase font-mono whitespace-nowrap opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 pointer-events-none z-[100] text-popover-foreground ">
            {wsStatus === 'Connected' ? 'Live Feeds: ACTIVE' : 'Live Feeds: DISCONNECTED'}
          </span>
          <div className="flex flex-col items-center justify-center gap-0.5">
            <span className={cn("relative inline-flex rounded-full h-2 w-2 transition-colors duration-500", wsStatus === 'Connected' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500')} />
            <span className="text-[8px] font-bold tracking-wider uppercase font-mono">Feed</span>
          </div>
        </div>
      </div>
    </header>

    {/* ===== Mobile bottom navigation (TradingView-style) — small screens only ===== */}
    {moreOpen && (
      <div className="md:hidden fixed inset-0 z-[60]" onClick={() => setMoreOpen(false)}>
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150" />
        <div
          className="absolute bottom-16 left-0 right-0 bg-sidebar border-t border-sidebar-border rounded-t-2xl p-4 pb-5 animate-in slide-in-from-bottom duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30 mx-auto mb-4" />
          <div className="grid grid-cols-4 gap-3">
            {moreLinks.map((link) => {
              const Icon = link.icon;
              const active = location === link.href;
              const showBlink = (link.href === '/news' && hasUnseenNiftyNews);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 p-2.5 rounded-xl border border-transparent relative',
                    active ? 'text-primary bg-primary/10 border-primary/20' : 'text-muted-foreground'
                  )}
                >
                  {showBlink && <span className="absolute top-1.5 right-3 w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />}
                  <Icon className="w-5 h-5" />
                  <span className="text-[9px] font-medium text-center leading-tight">{link.label}</span>
                </Link>
              );
            })}
            <Link
              href="/kite-login"
              onClick={() => setMoreOpen(false)}
              className={cn(
                'flex flex-col items-center gap-1.5 p-2.5 rounded-xl border border-transparent',
                authStatus?.status === 'connected' ? 'text-emerald-500' : 'text-rose-500'
              )}
            >
              {authStatus?.status === 'connected' ? <CheckCircle2 className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
              <span className="text-[9px] font-medium">Kite</span>
            </Link>
          </div>
          {/* Live status row */}
          <div className="flex items-center justify-center gap-5 mt-4 pt-3 border-t border-sidebar-border text-[10px] font-mono uppercase tracking-wider">
            <span className={cn('flex items-center gap-1.5', isProxyAlive ? 'text-emerald-500' : 'text-rose-500')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', isProxyAlive ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500')} /> Proxy
            </span>
            <span className={cn('flex items-center gap-1.5', wsStatus === 'Connected' ? 'text-emerald-500' : 'text-rose-500')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', wsStatus === 'Connected' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500')} /> Feed
            </span>
          </div>
        </div>
      </div>
    )}

    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 h-16 bg-sidebar border-t border-sidebar-border flex items-stretch justify-around px-1"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {primaryLinks.map((link) => {
        const Icon = link.icon;
        const active = location === link.href;
        const showBlink = (link.href === '/notifications' && unreadCount > 0);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-1 relative transition-colors',
              active ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {showBlink && <span className="absolute top-2.5 left-1/2 translate-x-2.5 w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse z-10" />}
            <Icon className={cn('w-5 h-5 transition-transform', active && 'scale-110')} />
            <span className="text-[9px] font-medium">{shortLabels[link.href] || link.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => setMoreOpen((v) => !v)}
        className={cn(
          'flex-1 flex flex-col items-center justify-center gap-1 transition-colors',
          moreOpen ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        <Menu className="w-5 h-5" />
        <span className="text-[9px] font-medium">More</span>
      </button>
    </nav>
    </>
  );
}
