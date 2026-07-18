import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";
import { getFamilyGroupId } from "../../lib/session";

// Was hardcoded to /family-groups/me/subscription — "me" isn't a real
// family group id, so this always 403'd (apps/api's subscription.routes.ts
// checks req.params.id === req.auth.familyGroupId). Fixed the same way the
// tree tab was fixed last session. Also added the missing cache
// invalidation after takeover — previously the status shown wouldn't
// refresh after a successful takeover without a manual page reload.
export default function SubscriptionSettingsRoute() {
  const familyGroupId = getFamilyGroupId() ?? "";
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["subscription", familyGroupId],
    queryFn: () =>
      apiClient.request<{ status: string; gracePeriodEnd: string | null }>(
        `/family-groups/${familyGroupId}/subscription`
      ),
    enabled: Boolean(familyGroupId),
  });

  const takeover = useMutation({
    mutationFn: () =>
      apiClient.request(`/family-groups/${familyGroupId}/subscription/takeover`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscription", familyGroupId] }),
  });

  return (
    <div style={{ padding: 24 }}>
      <h1>Subscription</h1>
      <p>Status: {data?.status ?? "—"}</p>
      {data?.gracePeriodEnd ? <p>Grace period ends: {data.gracePeriodEnd}</p> : null}
      <button onClick={() => takeover.mutate()} disabled={takeover.isPending}>
        {takeover.isPending ? "Working…" : "Become the paying member"}
      </button>
    </div>
  );
}
