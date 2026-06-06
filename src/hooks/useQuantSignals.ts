import { useQuery } from '@tanstack/react-query';

export function useQuantSignals() {
  return useQuery({
    queryKey: ['quant-engine'],
    queryFn: async () => {
      const res = await fetch("/api/quant-engine");
      if (!res.ok) throw new Error("Failed to fetch quant engine data");
      return res.json();
    },
    refetchInterval: 30000, // 30 sec polling
  });
}
