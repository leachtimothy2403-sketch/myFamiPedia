import { View, Text, Button, FlatList, Alert } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

interface ManagedMemory {
  id: string;
  content: string | null;
  provenanceType: "voice" | "photo" | "text" | "ai_generated";
  retracted: boolean;
  isPosthumousContribution: boolean;
  eligibleForHardDelete: boolean; // computed server-side: unlinked, unreacted, non-voice, non-posthumous
}

// Browse/manage already-added memories. Per the resolved deletion policy
// (data_model.md): unlinked+unreacted+non-voice+non-posthumous memories get a
// plain "Delete"; anything linked/reacted gets "Retract" instead; posthumous
// contributions get neither (they route to flags/moderation); voice memories
// only ever show "Retract".
export default function CollectionManageScreen() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["my-memories"],
    queryFn: () => apiClient.request<{ items: ManagedMemory[] }>("/persons/me/memories"),
  });

  const del = useMutation({
    mutationFn: (id: string) => apiClient.deleteMemory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-memories"] }),
  });
  const retract = useMutation({
    mutationFn: (id: string) => apiClient.retractMemory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-memories"] }),
  });

  function actionFor(m: ManagedMemory) {
    if (m.isPosthumousContribution) return null; // moderation path only
    if (m.provenanceType === "voice") {
      return <Button title="Retract" onPress={() => retract.mutate(m.id)} />;
    }
    if (m.eligibleForHardDelete) {
      return (
        <Button
          title="Delete"
          onPress={() =>
            Alert.alert("Delete this memory?", "This can't be undone.", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => del.mutate(m.id) },
            ])
          }
        />
      );
    }
    return <Button title="Retract" onPress={() => retract.mutate(m.id)} />;
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 12 }}>Your memories</Text>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={{ flex: 1 }}>{item.content ?? "(media memory)"}</Text>
            {item.retracted ? <Text>Retracted</Text> : actionFor(item)}
          </View>
        )}
        ListEmptyComponent={<Text>Nothing here yet.</Text>}
      />
    </View>
  );
}
