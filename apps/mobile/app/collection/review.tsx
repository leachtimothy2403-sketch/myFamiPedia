import { View, Text, Button, FlatList } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

// Section 2 proposal queue — 2-tap accept/reject, under two minutes per the
// product doc. Reachable from the Home header and via the "N memories to
// review" notification deep-link.
export default function CollectionReviewScreen() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["proposed-memories"],
    queryFn: () => apiClient.request<{ items: { id: string }[] }>("/collection/proposed"),
  });

  const accept = useMutation({
    mutationFn: (id: string) => apiClient.request(`/collection/proposed/${id}/accept`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposed-memories"] }),
  });
  const reject = useMutation({
    mutationFn: (id: string) => apiClient.request(`/collection/proposed/${id}/reject`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposed-memories"] }),
  });

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 12 }}>Memories to review</Text>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
            <Button title="Accept" onPress={() => accept.mutate(item.id)} />
            <Button title="Reject" onPress={() => reject.mutate(item.id)} />
          </View>
        )}
        ListEmptyComponent={<Text>Nothing waiting for review.</Text>}
      />
    </View>
  );
}
