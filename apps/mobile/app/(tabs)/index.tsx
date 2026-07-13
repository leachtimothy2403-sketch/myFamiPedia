import { View, Text, Button, FlatList } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

// Home: memory feed (section 9). The "manage your memories" icon in the
// header links to collection/manage.tsx; "N memories to review" notifications
// deep-link to collection/review.tsx (see mobile_app_structure.md).
export default function HomeScreen() {
  const { data: notifications } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiClient.request<{ items: unknown[] }>("/notifications"),
  });

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 20, fontWeight: "600" }}>Family feed</Text>
        <Button title="Manage" onPress={() => router.push("/collection/manage")} />
      </View>
      <Button title="Review proposed memories" onPress={() => router.push("/collection/review")} />
      <FlatList
        data={notifications?.items ?? []}
        keyExtractor={(_, i) => String(i)}
        renderItem={() => null}
        ListEmptyComponent={<Text>No memories yet — invite family or share a story to get started.</Text>}
      />
    </View>
  );
}
