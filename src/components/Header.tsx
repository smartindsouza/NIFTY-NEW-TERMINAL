import { Link, useLocation } from 'wouter';
import { Home, List, TrendingUp, Newspaper, Activity, LogIn, CheckCircle2, BarChart2, PlayCircle, FileText, Sparkles, LineChart, Settings2, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useGlobalWebSocket } from '../hooks/useWebSocket';
import { useNotifications } from '../hooks/useNotifications';

export function Header() {
  const [location] = useLocation();
  const { status: wsStatus } = useGlobalWebSocket();
  const { unreadCount } = useNotifications();

  const { data: authStatus } = useQuery({
    queryKey: ['auth-status'],
    queryFn: async () => {
      const res = await axios.get('/api/auth/status');
      return res.data;
    },
    refetchInterval: 60000
  });

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
  ];

  return (
    <header className="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-auto max-w-[95vw] h-16 bg-[#070b13]/90 backdrop-blur-2xl border border-purple-500/30 rounded-full px-6 shadow-[0_0_35px_rgba(168,85,247,0.25)] flex items-center justify-between gap-5 shrink-0 transition-all duration-300 select-none">
      {/* Absolute background glowing aura mirroring the user image */}
      <div className="absolute inset-x-4 inset-y-1 -z-10 rounded-full bg-purple-500/20 blur-[18px] opacity-100 pointer-events-none" />

      {/* Brand Logo */}
      <Link href="/" className="flex items-center gap-2 cursor-pointer group pr-4 border-r border-white/10 shrink-0">
        <div className="w-9 h-9 flex items-center justify-center rounded-full bg-primary/20 text-primary shadow-[0_0_15px_rgba(59,130,246,0.25)] transition-transform duration-300 group-hover:scale-105">
          <Activity className="w-4 h-4 animate-pulse" />
        </div>
        <div className="hidden sm:flex flex-col">
          <span className="font-mono text-[10px] tracking-widest font-black text-slate-100">NSE</span>
        </div>
      </Link>

      {/* Navigation tabs with horizontal scrollability & exact-fitting contents */}
      <div className="overflow-x-auto md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden py-1">
        <nav className="flex items-center gap-1.5 bg-black/35 border border-white/5 p-1 rounded-full min-w-max">
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
                  "flex items-center justify-center w-10 h-10 rounded-full transition-all duration-500 ease-in-out relative group shrink-0 cursor-pointer select-none border border-transparent",
                  active 
                    ? "text-primary bg-primary/10 border-primary/20 shadow-[inset_0_0_12px_rgba(59,130,246,0.2)]" 
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                )}
              >
                {showBlink && !active && (
                  <div className="absolute top-1 right-1 w-1.5 rounded-full bg-red-500 animate-ping shadow-[0_0_10px_rgba(239,68,68,1)] z-20" />
                )}
                <Icon className={cn("w-4 h-4 relative z-10 transition-all duration-500 ease-in-out", active && "scale-110 drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]", showBlink && !active && "text-red-400 animate-pulse")} />
                {showBlink && !active && (
                  <span className="absolute top-1 right-1 w-1 h-1 bg-red-500 rounded-full border border-[#0c1421] z-20"></span>
                )}
                
                {/* Clean, high-fidelity hover tooltip showing the tab's label */}
                <span className="absolute top-full mt-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-[#0a0f1d] border border-white/10 rounded-lg text-[10px] font-bold tracking-wider uppercase font-mono whitespace-nowrap opacity-0 -translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 pointer-events-none z-50 text-slate-200 shadow-[0_10px_25px_rgba(0,0,0,0.8)] border-purple-500/25">
                  {link.label}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Connection metrics on the right */}
      <div className="flex items-center gap-2 pl-4 border-l border-white/10 shrink-0">
        {/* Kite Connect Status */}
        <Link href="/kite-login" className={cn(
          "flex items-center justify-center w-10 h-10 rounded-full transition-all duration-300 relative group border border-transparent hover:border-white/5",
          authStatus?.status === 'connected' ? 'text-green-500 bg-green-500/5 hover:bg-green-500/10' : 'text-muted-foreground hover:text-foreground hover:bg-white/5',
          location === '/kite-login' && 'bg-white/5 text-foreground'
        )}>
          <span className="absolute top-full mt-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-[#0a0f1d] border border-white/10 rounded-lg text-[10px] font-bold tracking-wider uppercase font-mono whitespace-nowrap opacity-0 -translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 pointer-events-none z-50 text-slate-200 shadow-[0_10px_25px_rgba(0,0,0,0.8)] border-purple-500/25">
            Kite Connect: {authStatus?.status === 'connected' ? 'CONNECTED' : 'EXPIRED'}
          </span>
          {authStatus?.status === 'connected' ? <CheckCircle2 className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
        </Link>

        {/* Live signals ping indicator */}
        <div className="flex items-center justify-center w-10 h-10 rounded-full border border-white/5 bg-black/25 relative group cursor-pointer">
          <span className="absolute top-full mt-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-[#0a0f1d] border border-white/10 rounded-lg text-[10px] font-bold tracking-wider uppercase font-mono whitespace-nowrap opacity-0 -translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 pointer-events-none z-50 text-slate-200 shadow-[0_10px_25px_rgba(0,0,0,0.8)] border-purple-500/25">
            {wsStatus === 'Connected' ? 'Live Feeds: ACTIVE' : 'Live Feeds: DISCONNECTED'}
          </span>
          <span className={cn("relative inline-flex rounded-full h-2 w-2 transition-colors duration-500", wsStatus === 'Connected' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]')}></span>
        </div>
      </div>
    </header>
  );
}
