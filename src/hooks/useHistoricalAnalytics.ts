import { useQuery } from '@tanstack/react-query';

export function useHistoricalAnalytics() {
  return useQuery({
    queryKey: ['historical-analytics'],
    queryFn: async () => {
      const res = await fetch("/api/historical-analytics");
      if (!res.ok) throw new Error("Failed to fetch historical analytics");
      return res.json();
    }
  });
}

export function useFiiData() {
  return useQuery({
    queryKey: ['fii-dii-data'],
    queryFn: async () => {
      const res = await fetch("/api/fii-dii");
      if (!res.ok) throw new Error("Failed to fetch FII data");
      return res.json();
    }
  });
}
