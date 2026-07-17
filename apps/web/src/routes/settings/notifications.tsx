import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

interface NotificationSetting {
  notificationType: string;
  enabled: boolean;
}

// Checkboxes previously used defaultChecked with no onChange, so toggling
// one did nothing — this wires them to PATCH /notifications/settings
// (apps/api's notifications.routes.ts, body: { notificationType, enabled }).
// Notifications are user-scoped, not person-scoped, so there's no "me"
// placeholder bug here — this page's gap was purely the missing mutation.
export default function NotificationSettingsRoute() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["notification-settings"],
    queryFn: () => apiClient.request<{ items: NotificationSetting[] }>("/notifications/settings"),
  });
  const update = useMutation({
    mutationFn: (vars: { notificationType: string; enabled: boolean }) =>
      apiClient.request("/notifications/settings", { method: "PATCH", body: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-settings"] }),
  });

  return (
    <div style={{ padding: 24 }}>
      <h1>Notification settings</h1>
      {(data?.items ?? []).length === 0 ? (
        <p style={{ color: "#888" }}>No notification types configured yet.</p>
      ) : (
        (data?.items ?? []).map((s: NotificationSetting) => (
          <label key={s.notificationType} style={{ display: "block", marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => update.mutate({ notificationType: s.notificationType, enabled: e.target.checked })}
            />{" "}
            {s.notificationType}
          </label>
        ))
      )}
    </div>
  );
}
