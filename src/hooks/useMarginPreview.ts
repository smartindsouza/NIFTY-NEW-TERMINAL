import { useState, useEffect, useRef } from 'react';

export interface KiteMarginResponse {
  type: string;
  tradingsymbol: string;
  exchange: string;
  span: number;
  exposure: number;
  option_premium: number;
  additional_margin: number;
  bo: number;
  cash: number;
  total: number;
  charges: {
    total: number;
    transaction_tax: number;
    transaction_tax_type: string;
    exchange_turnover_charge: number;
    sebi_turnover_charge: number;
    brokerage: number;
    stamp_duty: number;
    gst: {
      igst: number;
      cgst: number;
      sgst: number;
      total: number;
    };
  };
}

export interface MarginPreviewState {
  loading: boolean;
  error: string | null;
  data: KiteMarginResponse | null;
  dataQuantity?: number; // the quantity `data` was computed for — lets callers derive a stable per-lot cost
  cacheHit?: boolean;
  isKiteApiAvailable?: boolean;
}

const CACHE_DURATION = 30000; // 30 seconds
let marginCache: Record<string, { timestamp: number, data: KiteMarginResponse }> = {};

let marginCacheHits = 0;
let marginCacheMisses = 0;
let lastMarginApiTime = 0;
let lastMarginApiResponseTimestamp = 0;
let lastMarginApiResponseSize = 0;
let lastMarginApiTotalMargin = 0;
let lastMarginApiTotalCharges = 0;
let lastLocalTotalMargin = 0;
let lastLocalTotalCharges = 0;
let fallbackCountToday = 0;
let lastFallbackReason = '';
let lastApiStatus: 'Not Called' | 'Calling' | 'Success' | 'Failed' = 'Not Called';
const fallbackLogs: any[] = [];

let lastApiRequestPayload = '';
let lastApiResponseBody = '';
let lastApiEndpoint = '';
let lastApiStatusCode = 0;
let lastApiResponseParsed = false;
let lastApiAppliedToTicket = false;

export function patchMarginDiagnostics(patch: Partial<ReturnType<typeof getMarginDiagnostics>>) {
  if (patch.lastApiStatus !== undefined) lastApiStatus = patch.lastApiStatus;
  if (patch.lastApiEndpoint !== undefined) lastApiEndpoint = patch.lastApiEndpoint;
  if (patch.lastApiRequestPayload !== undefined) lastApiRequestPayload = patch.lastApiRequestPayload;
  if (patch.lastApiStatusCode !== undefined) lastApiStatusCode = patch.lastApiStatusCode;
  if (patch.lastApiResponseBody !== undefined) lastApiResponseBody = patch.lastApiResponseBody;
  if (patch.lastFallbackReason !== undefined) lastFallbackReason = patch.lastFallbackReason;
  if (patch.lastResponseTimestamp !== undefined) lastMarginApiResponseTimestamp = patch.lastResponseTimestamp;
  if (patch.totalMargin !== undefined) lastMarginApiTotalMargin = patch.totalMargin;
  if (patch.totalCharges !== undefined) lastMarginApiTotalCharges = patch.totalCharges;
  if (patch.lastApiResponseParsed !== undefined) lastApiResponseParsed = patch.lastApiResponseParsed;
  if (patch.lastApiAppliedToTicket !== undefined) lastApiAppliedToTicket = patch.lastApiAppliedToTicket;
}

export function getMarginDiagnostics() {
  return {
    hits: marginCacheHits,
    misses: marginCacheMisses,
    lastApiTime: lastMarginApiTime,
    lastResponseTimestamp: lastMarginApiResponseTimestamp,
    lastResponseSize: lastMarginApiResponseSize,
    totalMargin: lastMarginApiTotalMargin,
    totalCharges: lastMarginApiTotalCharges,
    localMargin: lastLocalTotalMargin,
    localCharges: lastLocalTotalCharges,
    fallbackCount: fallbackCountToday,
    lastFallbackReason,
    lastApiStatus,
    lastApiRequestPayload,
    lastApiResponseBody,
    lastApiEndpoint,
    lastApiStatusCode,
    fallbackLogs,
    lastApiResponseParsed,
    lastApiAppliedToTicket
  };
}

export function useMarginPreview(params: {
  exchange?: string;
  tradingsymbol?: string;
  quantity?: number;
  transaction_type?: string;
  product?: string;
  order_type?: string;
  price?: number;
  variety?: string;
  localTotalMargin?: number;
  localTotalCharges?: number;
}) {
  const [state, setState] = useState<MarginPreviewState>({
    loading: false,
    error: null,
    data: null,
  });

  const lastFetchRef = useRef<number>(0);
  
  // A stringified key to identify unique requests
  const cacheKey = params.tradingsymbol ? `${params.tradingsymbol}_${params.quantity}_${params.transaction_type}_${params.product}_${params.order_type}_${params.price}` : null;

  useEffect(() => {
    if (!cacheKey || !params.tradingsymbol || !params.quantity || !params.transaction_type) {
      return;
    }

    console.log(`[Margin API Frontend] Step 1: User opens order ticket / Triggering margin fetch for ${params.tradingsymbol}`);

    // Keep diagnostics up to date with the latest local estimates
    if (params.localTotalMargin !== undefined) lastLocalTotalMargin = params.localTotalMargin;
    if (params.localTotalCharges !== undefined) lastLocalTotalCharges = params.localTotalCharges;

    // Check cache
    const cached = marginCache[cacheKey];
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
      marginCacheHits++;
      setState({
        loading: false,
        error: null,
        data: cached.data,
        dataQuantity: params.quantity,
        cacheHit: true,
        isKiteApiAvailable: true
      });
      return;
    }

    marginCacheMisses++;

    const fetchMargin = async () => {
      setState(prev => ({ ...prev, loading: true, error: null, cacheHit: false }));
      const startTime = Date.now();
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6 sec timeout for fallback
      
      try {
        lastApiStatus = 'Calling';
        lastApiResponseParsed = false;
        lastApiAppliedToTicket = false;
        const payload = {
          exchange: params.exchange || 'NFO',
          tradingsymbol: params.tradingsymbol,
          quantity: params.quantity,
          transaction_type: params.transaction_type,
          product: params.product || 'NRML',
          order_type: params.order_type || 'MARKET',
          price: params.price || 0,
          variety: params.variety || 'regular'
        };

        lastApiEndpoint = '/api/orders/margins';
        lastApiRequestPayload = JSON.stringify(payload, null, 2);

        console.log("[Margin API Frontend] Step 2: Sending request to /api/orders/margins", JSON.stringify(payload));

        const response = await fetch('/api/orders/margins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        const textResponse = await response.text();
        lastApiStatusCode = response.status;
        lastApiResponseBody = textResponse;
        
        console.log("[Margin API Frontend] Step 6: Frontend receives response", textResponse);
        
        const resData = JSON.parse(textResponse);
        lastApiResponseParsed = true;
        
        if (!response.ok || !resData.success) {
          const errReason = resData.error || `HTTP ${response.status}`;
          throw new Error(errReason);
        }

        const data: KiteMarginResponse = resData.responseBody;
        
        if (data && data.charges) {
          marginCache[cacheKey] = {
            timestamp: Date.now(),
            data
          };
          const took = Date.now() - startTime;
          lastFetchRef.current = took;
          lastMarginApiTime = took;
          lastMarginApiResponseTimestamp = Date.now();
          lastMarginApiResponseSize = new Blob([textResponse]).size;
          lastMarginApiTotalMargin = data.total;
          lastMarginApiTotalCharges = data.charges.total;
          lastApiStatus = 'Success';
          lastApiAppliedToTicket = true;
          
          setState({
            loading: false,
            error: null,
            data,
            dataQuantity: params.quantity,
            cacheHit: false,
            isKiteApiAvailable: true
          });
        } else {
            throw new Error('Invalid margin data received.');
        }

      } catch (err: any) {
        clearTimeout(timeoutId);
        lastApiStatus = 'Failed';
        fallbackCountToday++;
        
        // Determine failure reason
        let reason = err.message || 'Unknown network error';
        if (err.name === 'AbortError') reason = 'Timeout (6s)';
        else if (reason.includes("401")) reason = '401 Unauthorized';
        else if (reason.includes("403")) reason = '403 Forbidden';
        else if (reason.includes("429")) reason = '429 Rate Limited';
        
        lastFallbackReason = reason;
        
        fallbackLogs.push({
          timestamp: new Date().toISOString(),
          reason: lastFallbackReason,
          parameters: params
        });
        if (fallbackLogs.length > 50) fallbackLogs.shift();

        console.error("[Margin API Frontend] Fallback active:", lastFallbackReason, err);
        setState({
          loading: false,
          error: lastFallbackReason,
          data: null,
          isKiteApiAvailable: false
        });
      }
    };

    fetchMargin();
  }, [cacheKey]);

  return { ...state, fetchDuration: lastFetchRef.current, cacheKey };
}
