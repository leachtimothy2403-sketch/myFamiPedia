import { View, Text, Button } from "react-native";
import { router } from "expo-router";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

// "Voice settings" previously linked to /voice/me/settings — "me" isn't a
// real person id, so the screen it lands on would call endpoints that 403
// (voice-model/consent explicitly checks req.params.id === req.auth.personId
// in apps/api's voice.routes.ts). Resolves the real id via useSessionIds()
// first, same fix pattern as the tree tab and web's settings pages.
export default function AccountScreen() {
  const { personId } = useSessionIds();

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Account</Text>
      <Button title="Manage your memories" onPress={() => router.push("/collection/manage")} />
      <Button title="Family administrator" onPress={() => router.push("/family/administrator")} />
      <Button title="Collection settings" onPress={() => router.push("/collection/settings")} />
      <Button
        title="Voice settings"
        onPress={() => {
          if (personId) router.push(`/voice/${personId}/settings`);
        }}
      />
      <Button title="Notifications" onPress={() => router.push("/notifications")} />
      <Button
        title="Notification preferences"
        onPress={() => router.push("/notifications/settings")}
      />
      <Button
        title="Log out"
        onPress={async () => {
          await apiClient.logout();
          router.replace("/login");
        }}
      />
    </View>
  );
}
