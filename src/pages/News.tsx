import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Loader2, 
  Clock, 
  ExternalLink, 
  TrendingUp, 
  TrendingDown,
  Minus,
  Newspaper, 
  SlidersHorizontal,
  RefreshCw,
  AlertTriangle,
  Flame,
  Info
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';

type NewsCategory = 'All' | 'India Market' | 'Global Macro' | 'Geopolitical' | 'Sector' | 'NIFTY Companies';

interface NewsItem {
  id: string;
  headline: string;
  source: string;
  time: string;
  timeIST: string;
  category: 'India Market' | 'Global Macro' | 'Geopolitical' | 'Sector' | 'NIFTY Companies';
  sentiment: 'bullish' | 'bearish' | 'neutral';
  impactScore: number;
  whyItMatters: string;
  link: string;
}

export function News() {
  const [activeFilter, setActiveFilter] = useState<NewsCategory>('All');

  const { data: newsQueryData, isLoading, error, refetch, isRefetching } = useQuery<{
    news: NewsItem[];
    aiStatus: {
      success: boolean;
      lastSuccessTime: string | null;
      fallbackReason: string | null;
      geminiCount: number;
      localCount: number;
    }
  }>({
    queryKey: ['live-news-frequent'],
    queryFn: async () => {
      const res = await fetch('/api/news/live');
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error('Too many requests. Please try again later.');
        }
        throw new Error('Failed to fetch high-impact news');
      }
      return res.json();
    },
    refetchInterval: 60000 // Refetch once every minute to stay updated while respecting cache
  });

  const news = newsQueryData?.news;
  const aiStatus = newsQueryData?.aiStatus;

  const filterTabs: NewsCategory[] = [
    'All',
    'India Market',
    'Global Macro',
    'Geopolitical',
    'Sector',
    'NIFTY Companies'
  ];

  const filteredNews = news
    ? news.filter((item) => {
        if (activeFilter === 'All') return true;
        return item.category === activeFilter;
      })
    : [];

  return (
    <div className="p-4 md:p-8 pb-32 max-w-[1200px] w-full mx-auto animate-in fade-in zoom-in-95 duration-500">
      {/* Header and Controls */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end pb-6 border-b border-white/10 border-dashed mb-8 gap-4">
        <div className="w-full">
          <div className="flex items-center gap-2 mb-1">
            <div className="p-1.5 bg-rose-500/10 rounded">
              <Newspaper className="w-5 h-5 text-rose-500" />
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
              High-Impact Market Intel
            </h1>
          </div>
          <p className="text-xs text-slate-400">
            Deduplicated, professional feeds filtered strictly of yesterday & today’s events. Only items with Impact &gt;= 60 are displayed.
          </p>

          {aiStatus && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-400 mt-4 pt-3 border-t border-white/5">
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  "inline-block w-2 h-2 rounded-full",
                  aiStatus.success ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"
                )} />
                <span className="font-semibold text-slate-200">
                  {aiStatus.success ? "AI Analysis: Gemini" : "AI Analysis: Local Fallback"}
                </span>
              </div>
              <span className="text-slate-600 hidden sm:inline">|</span>
              <span className="text-slate-400">
                Gemini Articles: <span className="font-mono text-slate-200 font-bold">{aiStatus.geminiCount}</span> &nbsp;•&nbsp; Local: <span className="font-mono text-slate-200 font-bold">{aiStatus.localCount}</span>
              </span>
              {aiStatus.lastSuccessTime && (
                <>
                  <span className="text-slate-600 hidden sm:inline">|</span>
                  <span className="text-slate-400">
                    Last Success: <span className="text-emerald-400 font-mono">{new Date(aiStatus.lastSuccessTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  </span>
                </>
              )}
              {aiStatus.fallbackReason && (
                <>
                  <span className="text-slate-600 hidden lg:inline">|</span>
                  <span className="text-amber-400/80 italic font-mono text-[11px] max-w-md truncate" title={aiStatus.fallbackReason}>
                    Fallback: {aiStatus.fallbackReason}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => refetch()}
          disabled={isLoading || isRefetching}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-white/10 hover:border-white/20 rounded bg-white/[0.02] hover:bg-white/[0.05] text-slate-300 hover:text-white transition-all disabled:opacity-50 cursor-pointer text-nowrap"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", (isLoading || isRefetching) && "animate-spin")} />
          {isRefetching ? 'Refreshing...' : 'Sync Feeds'}
        </button>
      </div>

      {/* Category Navigation Ribbon */}
      <div className="flex flex-wrap items-center gap-1.5 pb-6 border-b border-white/5 mb-8">
        <div className="flex items-center gap-1.5 text-slate-400 mr-2 text-xs">
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>Filters:</span>
        </div>
        {filterTabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveFilter(tab)}
            className={cn(
              "px-3 py-1.5 text-xs rounded font-medium border cursor-pointer transition-all duration-200",
              activeFilter === tab
                ? "bg-white text-black border-white shadow-sm"
                : "bg-[#16171d] text-slate-400 border-white/5 hover:border-white/10 hover:text-slate-200"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Main Content Area */}
      <div className="space-y-4">
        {isLoading && (
          <div className="flex flex-col items-center justify-center p-20 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-rose-500" />
            <p className="text-sm text-slate-400 animate-pulse">Aggregating and deduplicating financial feeds...</p>
          </div>
        )}

        {error && (
          <div className="text-center p-8 border border-red-500/20 rounded-xl bg-red-500/5 max-w-md mx-auto">
            <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <p className="text-sm font-medium text-white">Error fetching intel</p>
            <p className="text-xs text-slate-400 mt-1">{(error as any).message || 'Server returned an error.'}</p>
          </div>
        )}

        {/* Empty States */}
        {!isLoading && !error && (!news || news.length === 0) && (
          <div className="text-center p-16 border border-dashed border-white/10 rounded-xl bg-white/[0.01]">
            <Newspaper className="w-10 h-10 text-slate-500 mx-auto mb-3 opacity-40" />
            <p className="text-slate-200 font-medium text-sm">
              No high-impact NIFTY-relevant news from today/yesterday.
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
              Checking moneycontrol, ET, mint, and reuters feeds continually. No events rated above 60 impact score are logged today yet.
            </p>
          </div>
        )}

        {!isLoading && !error && news && news.length > 0 && filteredNews.length === 0 && (
          <div className="text-center p-16 border border-dashed border-white/10 rounded-xl bg-white/[0.01]">
            <SlidersHorizontal className="w-8 h-8 text-slate-500 mx-auto mb-3 opacity-40" />
            <p className="text-slate-300 font-medium text-sm">
              No news items fell under the &apos;{activeFilter}&apos; category today.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Refine your filter selection or click &quot;Sync Feeds&quot; to fetch recently published events.
            </p>
          </div>
        )}

        {/* Display High-Impact Articles */}
        {!isLoading && !error && filteredNews.length > 0 && filteredNews.map((item, index) => {
          const isExtremeImpact = item.impactScore >= 85;

          return (
            <Card
              key={item.id}
              onClick={() => window.open(item.link || '#', '_blank')}
              className={cn(
                "p-5 md:p-6 border-white/5 rounded-xl transition-all duration-300 cursor-pointer hover:bg-white/[0.03] group flex flex-col gap-4 bg-[#111217]",
                isExtremeImpact 
                  ? "border-rose-500/20 bg-rose-500/[0.01] shadow-[0_4px_24px_-4px_rgba(244,63,94,0.04)]" 
                  : "hover:border-white/10"
              )}
            >
              {/* Card Meta Row */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex items-center gap-2.5 text-xs text-slate-400">
                  <span className="font-semibold text-slate-300 uppercase text-[10px] tracking-wide px-2 py-0.5 rounded bg-white/5">
                    {item.source}
                  </span>
                  
                  <div className="flex items-center gap-1 text-[11px]">
                    <Clock className="w-3.5 h-3.5 text-slate-500" />
                    <span>{item.timeIST}</span>
                  </div>

                  <span className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider",
                    item.category === 'Geopolitical' && "bg-amber-500/10 text-amber-500 border border-amber-500/10",
                    item.category === 'Global Macro' && "bg-cyan-500/10 text-cyan-500 border border-cyan-500/10",
                    item.category === 'NIFTY Companies' && "bg-teal-500/10 text-teal-400 border border-teal-500/10",
                    item.category === 'Sector' && "bg-emerald-500/10 text-emerald-500 border border-emerald-500/10",
                    item.category === 'India Market' && "bg-rose-500/10 text-rose-500 border border-rose-500/10"
                  )}>
                    {item.category}
                  </span>
                </div>

                {/* Sentiment and Score Tags */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {isExtremeImpact && (
                    <span className="flex items-center gap-0.5 text-[9px] font-extrabold text-rose-500 tracking-wider uppercase animate-pulse">
                      <Flame className="w-3.5 h-3.5 fill-current" />
                      Critical
                    </span>
                  )}

                  {item.sentiment === 'bullish' && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-500/5">
                      <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                      <span>BULLISH</span>
                    </span>
                  )}

                  {item.sentiment === 'bearish' && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 shadow-sm shadow-rose-500/5">
                      <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
                      <span>BEARISH</span>
                    </span>
                  )}

                  {item.sentiment === 'neutral' && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold rounded bg-slate-500/10 text-slate-400 border border-slate-500/10">
                      <Minus className="w-3.5 h-3.5 text-slate-400" />
                      <span>NEUTRAL</span>
                    </span>
                  )}

                  <Badge 
                    variant="outline" 
                    className={cn(
                      "font-mono text-xs font-semibold px-2.5 py-0.5 border flex items-center gap-1",
                      isExtremeImpact
                        ? "bg-rose-950/20 text-rose-400 border-rose-500/30"
                        : "bg-slate-950/40 text-slate-300 border-white/10"
                    )}
                  >
                    <span>Impact:</span>
                    <span className="font-bold text-white">{item.impactScore}</span>
                  </Badge>
                </div>
              </div>

              {/* Headline */}
              <div className="space-y-2">
                <h3 className="text-base md:text-lg font-medium text-white leading-snug group-hover:text-rose-400/90 transition-colors">
                  {item.headline}
                </h3>
              </div>

              {/* Rationale Divider Box (WHY THIS MATTERS FOR NIFTY) */}
              <div className="p-3.5 bg-white/[0.02] border border-white/5 rounded-lg flex items-start gap-2.5 text-xs">
                <div className="p-1 rounded bg-slate-400/10 text-slate-300 shrink-0 mt-0.5">
                  <Info className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                    Why this matters for NIFTY
                  </div>
                  <p className="text-slate-300 font-normal leading-relaxed">
                    {item.whyItMatters}
                  </p>
                </div>
              </div>

              {/* Bottom footer bar containing outbound links */}
              <div className="flex items-center justify-end text-xs text-slate-500 mt-2">
                <div className="flex items-center gap-1 text-[11px] group-hover:text-white transition-colors">
                  <span>Explore full coverage</span>
                  <ExternalLink className="w-3.2 h-3.2 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
