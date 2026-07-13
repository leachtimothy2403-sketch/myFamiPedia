import { useQuery } from "@tanstack/react-query";
import type { SearchQueryInput } from "@myfamipedia/shared";
import { apiClient } from "../lib/apiClient";

export function useSearch(query: SearchQueryInput | null) {
  return useQuery({
    queryKey: ["search", query],
    queryFn: () => apiClient.search(query as SearchQueryInput),
    enabled: query !== null && query.q.length > 0,
  });
}
