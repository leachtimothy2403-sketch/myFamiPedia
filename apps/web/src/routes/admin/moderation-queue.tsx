import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

export default function ModerationQueueRoute() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["flags"],
    queryFn: () => apiClient.request<{ items: { id: string; description: string }[] }>("/flags"),
  });
  const resolve = useMutation({
    mutationFn: (vars: { id: string; status: "removed" | "dismissed" }) =>
      apiClient.request(`/flags/${vars.id}`, { method: "PATCH", body: { status: vars.status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flags"] }),
  });

  return (
    <div style={{ padding: 24 }}>
      <h1>Moderation queue</h1>
      {(data?.items ?? []).map((item) => (
        <div key={item.id} style={{ marginBottom: 12 }}>
          <p>{item.description}</p>
          <button onClick={() => resolve.mutate({ id: item.id, status: "removed" })}>Remove</button>
          <button onClick={() => resolve.mutate({ id: item.id, status: "dismissed" })}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}
