import { useQuery, useMutation } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

// Family plan management, takeover flow — any member becomes paying member +
// administrator, one tap (see docs/api_structure.md, Subscription & family group).
export default function SubscriptionSettingsRoute() {
  const { data } = useQuery({
    queryKey: ["subscription"],
    queryFn: () => apiClient.request<{ status: string; gracePeriodEnd: string | null }>(
      "/family-groups/me/subscription"
    ),
  });
  const takeover = useMutation({
    mutationFn: () => apiClient.request("/family-groups/me/subscription/takeover", { method: "POST" }),
  });

  return (
    <div style={{ padding: 24 }}>
      <h1>Subscription</h1>
      <p>Status: {data?.status ?? "—"}</p>
      {data?.gracePeriodEnd ? <p>Grace period ends: {data.gracePeriodEnd}</p> : null}
      <button onClick={() => takeover.mutate()}>Become the paying member</button>
    </div>
  );
}
