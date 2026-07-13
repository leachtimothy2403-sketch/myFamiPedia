import { QueryClient } from "@tanstack/react-query";

// Shared cache config target with mobile — see apps/mobile/lib/queryClient.ts.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
    },
  },
});
