import { useEffect, useRef } from 'react';
import { performanceTracker } from '../lib/performanceTracker';

/**
 * Custom React hook to measure render duration and increment render counts.
 */
export function useProfiler(componentName: string) {
  const startTime = useRef(performance.now());
  
  // Reset start time on every render pass
  startTime.current = performance.now();

  useEffect(() => {
    const duration = performance.now() - startTime.current;
    performanceTracker.logComponentRender(componentName, duration);
    performanceTracker.incrementRenderCount();
  });
}
