import { QueryClient } from "@tanstack/react-query";

// Shared cache config target — kept in sync with apps/web/src/lib/queryClient.ts
// per the mobile app structure doc's "shared cache config with mobile where feasible".
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
    },
  },
});
