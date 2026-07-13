import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../lib/apiClient";

// Self-only, never admin-writable — see docs/privacy_enforcement.md.
export function usePrivacyTier(personId: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["privacy-tier", personId],
    queryFn: () => apiClient.request<{ privacyTier: 1 | 2 | 3 | null }>(`/persons/${personId}/privacy-tier`),
  });
  const mutation = useMutation({
    mutationFn: (tier: 1 | 2 | 3) =>
      apiClient.request(`/persons/${personId}/privacy-tier`, { method: "PATCH", body: { privacyTier: tier } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["privacy-tier", personId] }),
  });
  return { ...query, setTier: mutation.mutate };
}
