import { View, Text, FlatList } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

export default function NotificationsScreen() {
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiClient.request<{ items: { id: string; type: string }[] }>("/notifications"),
  });

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(n) => n.id}
        renderItem={({ item }) => <Text style={{ marginBottom: 8 }}>{item.type}</Text>}
        ListEmptyComponent={<Text>Nothing new.</Text>}
      />
    </View>
  );
}
