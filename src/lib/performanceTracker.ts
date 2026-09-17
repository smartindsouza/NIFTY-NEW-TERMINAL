export interface ComponentSpeed {
  name: string;
  renderTimeMs: number;
}

export interface ApiCallMetric {
  endpoint: string;
  timestamp: number;
  durationMs: number;
  fromCache: boolean;
  // Milliseconds the request spent inside our server (Server-Timing header).
  // durationMs minus this is the phone <-> server network time.
  serverMs?: number;
}

let activeCalls = 0;
let wsSubscriptions = new Set<string>(["NSE:NIFTY 50"]); // Default subscription
let indicatorCacheHits = 0;
let indicatorCacheMisses = 0;
let queryCacheHits = 0;
let queryCacheMisses = 0;
let totalRenderCount = 0;
const componentSpeeds: Map<string, number[]> = new Map();
const apiMetricsList: ApiCallMetric[] = [];
const endpointCallTimestamps: Map<string, number[]> = new Map();

export const performanceTracker = {
  // Concurrent active calls
  incrementActiveCalls() {
    activeCalls++;
  },
  decrementActiveCalls() {
    activeCalls = Math.max(0, activeCalls - 1);
  },
  getActiveCalls() {
    return activeCalls;
  },

  // WebSocket active subscriptions
  subscribeToSymbol(symbol: string) {
    wsSubscriptions.clear(); // Only active symbol
    wsSubscriptions.add(symbol);
  },
  getWsSubscriptions() {
    return Array.from(wsSubscriptions);
  },

  // Indicator Cache Tracking
  logIndicatorCacheHit() {
    indicatorCacheHits++;
  },
  logIndicatorCacheMiss() {
    indicatorCacheMisses++;
  },
  getIndicatorCacheMetrics() {
    const total = indicatorCacheHits + indicatorCacheMisses;
    return {
      hits: indicatorCacheHits,
      misses: indicatorCacheMisses,
      rate: total === 0 ? 100 : Math.round((indicatorCacheHits / total) * 100),
    };
  },

  // React Query / general Query Cache Tracking
  logQueryCacheHit() {
    queryCacheHits++;
  },
  logQueryCacheMiss() {
    queryCacheMisses++;
  },
  getQueryCacheMetrics() {
    const total = queryCacheHits + queryCacheMisses;
    return {
      hits: queryCacheHits,
      misses: queryCacheMisses,
      rate: total === 0 ? 100 : Math.round((queryCacheHits / total) * 100),
    };
  },

  // Render & Mount Profiling
  incrementRenderCount() {
    totalRenderCount++;
  },
  getGlobalRenderCount() {
    return totalRenderCount;
  },
  logComponentRender(name: string, durationMs: number) {
    const current = componentSpeeds.get(name) || [];
    current.push(durationMs);
    // limit array to last 10
    if (current.length > 10) current.shift();
    componentSpeeds.set(name, current);
  },
  getSlowestComponents() {
    const list: { name: string; avgTimeMs: number }[] = [];
    componentSpeeds.forEach((durations, name) => {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      list.push({ name, avgTimeMs: parseFloat(avg.toFixed(2)) });
    });
    return list.sort((a, b) => b.avgTimeMs - a.avgTimeMs).slice(0, 5);
  },

  // API Call Logging & Response Times
  logApiCall(endpoint: string, durationMs: number, fromCache: boolean, serverMs?: number) {
    apiMetricsList.push({
      endpoint,
      timestamp: Date.now(),
      durationMs,
      fromCache,
      serverMs,
    });
    // 300, not 100: the breakdown below is only useful with a few minutes of
    // history behind it, and these are tiny objects.
    if (apiMetricsList.length > 300) {
      apiMetricsList.shift();
    }

    // Record call for frequency warning checks
    const currentTimes = endpointCallTimestamps.get(endpoint) || [];
    currentTimes.push(Date.now());
    // Only keep calls within the last 15 seconds
    const cutoff = Date.now() - 15000;
    const filtered = currentTimes.filter(t => t > cutoff);
    endpointCallTimestamps.set(endpoint, filtered);
  },

  // Check if any endpoint is called too frequently (e.g., > 5 calls in 15 seconds)
  getEndpointFrequencyWarnings(): { endpoint: string; ratePer15s: number }[] {
    const warnings: { endpoint: string; ratePer15s: number }[] = [];
    endpointCallTimestamps.forEach((times, endpoint) => {
      const matches = times.filter(t => t > Date.now() - 15000);
      if (matches.length > 5) {
        warnings.push({ endpoint, ratePer15s: matches.length });
      }
    });
    return warnings;
  },

  getAverageResponseTime() {
    const nonCachedCalls = apiMetricsList.filter(m => !m.fromCache);
    if (nonCachedCalls.length === 0) return 0;
    const sum = nonCachedCalls.reduce((a, b) => a + b.durationMs, 0);
    return Math.round(sum / nonCachedCalls.length);
  },

  // Per-endpoint latency, median rather than mean so one cold chart load does
  // not colour the whole picture. Slowest first.
  getEndpointBreakdown() {
    const byEndpoint = new Map<string, ApiCallMetric[]>();
    for (const m of apiMetricsList) {
      if (m.fromCache) continue;
      const list = byEndpoint.get(m.endpoint) || [];
      list.push(m);
      byEndpoint.set(m.endpoint, list);
    }
    const med = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return Math.round(s[Math.floor(s.length / 2)]);
    };
    const rows = Array.from(byEndpoint.entries()).map(([endpoint, list]) => {
      const total = med(list.map((m) => m.durationMs))!;
      const server = med(list.filter((m) => typeof m.serverMs === 'number').map((m) => m.serverMs as number));
      return {
        endpoint,
        calls: list.length,
        totalMs: total,
        serverMs: server,
        // What is left is time on the wire between the phone and the server.
        networkMs: server === null ? null : Math.max(0, total - server),
      };
    });
    rows.sort((a, b) => b.totalMs - a.totalMs);
    return rows.slice(0, 8);
  },

  getMetrics() {
    const indicatorCache = this.getIndicatorCacheMetrics();
    const queryCache = this.getQueryCacheMetrics();
    const totalHits = indicatorCache.hits + queryCache.hits;
    const totalMisses = indicatorCache.misses + queryCache.misses;
    const total = totalHits + totalMisses;

    return {
      activeCalls: this.getActiveCalls(),
      wsSubscriptions: this.getWsSubscriptions(),
      renderCount: this.getGlobalRenderCount(),
      cacheHitRate: total === 0 ? 100 : Math.round((totalHits / total) * 100),
      slowestComponents: this.getSlowestComponents(),
      averageResponseTime: this.getAverageResponseTime(),
      endpointBreakdown: this.getEndpointBreakdown(),
      warnings: this.getEndpointFrequencyWarnings(),
    };
  }
};
