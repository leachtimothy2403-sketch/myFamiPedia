import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

export default function NotificationSettingsRoute() {
  const { data } = useQuery({
    queryKey: ["notification-settings"],
    queryFn: () => apiClient.request<{ items: { notificationType: string; enabled: boolean }[] }>(
      "/notifications/settings"
    ),
  });

  return (
    <div style={{ padding: 24 }}>
      <h1>Notification settings</h1>
      {(data?.items ?? []).map((s) => (
        <label key={s.notificationType} style={{ display: "block" }}>
          <input type="checkbox" defaultChecked={s.enabled} /> {s.notificationType}
        </label>
      ))}
    </div>
  );
}
