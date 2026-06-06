import axios from 'axios';
import { performanceTracker } from './performanceTracker';
import { toast } from 'sonner';

let isAlertActive = false;

function showTooFrequentWarning(endpoint: string, rate: number) {
  if (isAlertActive) return;
  isAlertActive = true;
  
  toast.warning("⚡ HIGH FREQUENCY API WARNING", {
    description: `Endpoint ${endpoint} has been called ${rate} times in the last 15 seconds. Throttling is advised to prevent broker 429 blocks.`,
    duration: 6000,
    onAutoClose: () => { isAlertActive = false; },
    onDismiss: () => { isAlertActive = false; }
  });
}

export function initializeInterceptor() {
  // 1. Intercept standard Fetch
  try {
    const originalFetch = window.fetch;
    const interceptedFetch = async function (this: any, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request).url || '';
      
      // Only intercept local API endpoints
      const isLocalApi = url.startsWith('/api') || url.includes('/api/');
      if (!isLocalApi) {
        return originalFetch(input, init);
      }

      performanceTracker.incrementActiveCalls();
      performanceTracker.logQueryCacheMiss(); // standard network fetch counts as a query cache miss at fetch-level
      
      const start = performance.now();
      try {
        const response = await originalFetch(input, init);
        const duration = performance.now() - start;
        
        performanceTracker.logApiCall(url.split('?')[0], duration, false);
        
        // Check for high-frequency warnings
        const warnings = performanceTracker.getEndpointFrequencyWarnings();
        const warning = warnings.find(w => w.endpoint === url.split('?')[0]);
        if (warning) {
          showTooFrequentWarning(warning.endpoint, warning.ratePer15s);
        }

        return response;
      } catch (error) {
        throw error;
      } finally {
        performanceTracker.decrementActiveCalls();
      }
    };

    Object.defineProperty(window, 'fetch', {
      value: interceptedFetch,
      writable: true,
      configurable: true,
    });
  } catch (err) {
    console.warn("Failed to intercept window.fetch. Falling back to non-intercepted fetch.", err);
  }

  // 2. Intercept Axios
  axios.interceptors.request.use(
    (config) => {
      performanceTracker.incrementActiveCalls();
      performanceTracker.logQueryCacheMiss();
      (config as any)._startTime = performance.now();
      return config;
    },
    (error) => {
      performanceTracker.decrementActiveCalls();
      return Promise.reject(error);
    }
  );

  axios.interceptors.response.use(
    (response) => {
      performanceTracker.decrementActiveCalls();
      const startTime = (response.config as any)._startTime;
      if (startTime) {
        const duration = performance.now() - startTime;
        const url = response.config.url || 'axios-api';
        
        performanceTracker.logApiCall(url.split('?')[0], duration, false);

        // Check frequency
        const warnings = performanceTracker.getEndpointFrequencyWarnings();
        const warning = warnings.find(w => w.endpoint === url.split('?')[0]);
        if (warning) {
          showTooFrequentWarning(warning.endpoint, warning.ratePer15s);
        }
      }
      return response;
    },
    (error) => {
      performanceTracker.decrementActiveCalls();
      if (error.config && (error.config as any)._startTime) {
        const duration = performance.now() - (error.config as any)._startTime;
        const url = error.config.url || 'axios-api';
        performanceTracker.logApiCall(url.split('?')[0], duration, false);
      }
      return Promise.reject(error);
    }
  );
}
