import { View, Text, Button, FlatList } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

// Administrator review queue for flagged content.
export default function ModerationQueueScreen() {
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
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 12 }}>Moderation queue</Text>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(f) => f.id}
        renderItem={({ item }) => (
          <View style={{ marginBottom: 12 }}>
            <Text>{item.description}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="Remove" onPress={() => resolve.mutate({ id: item.id, status: "removed" })} />
              <Button title="Dismiss" onPress={() => resolve.mutate({ id: item.id, status: "dismissed" })} />
            </View>
          </View>
        )}
        ListEmptyComponent={<Text>Queue is empty.</Text>}
      />
    </View>
  );
}
