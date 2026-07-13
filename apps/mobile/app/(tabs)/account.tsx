import { View, Text, Button } from "react-native";
import { router } from "expo-router";
import { apiClient } from "../../lib/apiClient";

// Own profile + settings hub. "Manage your memories" links to
// collection/manage.tsx per the mobile_app_structure.md navigation notes.
export default function AccountScreen() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Account</Text>
      <Button title="Manage your memories" onPress={() => router.push("/collection/manage")} />
      <Button title="Collection settings" onPress={() => router.push("/collection/settings")} />
      <Button title="Voice settings" onPress={() => router.push("/voice/me/settings")} />
      <Button title="Notifications" onPress={() => router.push("/notifications")} />
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
