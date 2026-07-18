import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { View, Text, Switch, ActivityIndicator } from "react-native";
import { notificationTypeLabel } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";

interface NotificationSetting {
  notificationType: string;
  enabled: boolean;
}

// Was missing entirely on mobile — only the notifications inbox
// (app/notifications/index.tsx, a feed of past notifications) existed, no
// preferences screen to control what gets sent. Mobile's counterpart to
// apps/web's routes/settings/notifications.tsx, same PATCH
// /notifications/settings contract (apps/api's notifications.routes.ts,
// body: { notificationType, enabled }, user-scoped off the JWT so there's
// no id-param bug to worry about here).
export default function NotificationSettingsScreen() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["notification-settings"],
    queryFn: () => apiClient.request<{ items: NotificationSetting[] }>("/notifications/settings"),
  });
  const update = useMutation({
    mutationFn: (vars: { notificationType: string; enabled: boolean }) =>
      apiClient.request("/notifications/settings", { method: "PATCH", body: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-settings"] }),
  });

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  const items = data?.items ?? [];

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 12 }}>Notification settings</Text>
      {items.length === 0 ? (
        <Text style={{ color: "#888" }}>No notification types configured yet.</Text>
      ) : (
        items.map((s) => (
          <View
            key={s.notificationType}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: "#eee",
            }}
          >
            <Text>{notificationTypeLabel(s.notificationType)}</Text>
            <Switch
              value={s.enabled}
              onValueChange={(enabled) => update.mutate({ notificationType: s.notificationType, enabled })}
            />
          </View>
        ))
      )}
    </View>
  );
}
