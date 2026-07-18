import { View, Text, Button, FlatList, Alert, ActivityIndicator } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

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
//
// Was GET /persons/me/memories — "me" isn't a real person id, and this
// route (apps/api's persons.routes.ts) queries Postgres with
// req.params.id directly (`.where("memories.contributor_id", req.params.id)`
// against a UUID column), so this screen would 500 rather than load,
// unlike the self-only routes elsewhere that at least 403 cleanly. Fixed
// the same way as today's other "me" bugs.
export default function CollectionManageScreen() {
  const qc = useQueryClient();
  const { personId, loading: sessionLoading } = useSessionIds();
  // asContributor=true: this screen manages what YOU contributed
  // (retract/delete rights are a contributor thing, per data_model.md's
  // deletion policy), regardless of who the memory is tagged to — not
  // "memories about you", which is what this endpoint returns by default.
  // See the route's comment in apps/api/src/routes/persons.routes.ts.
  const { data, isLoading } = useQuery({
    queryKey: ["my-memories", personId],
    queryFn: () => apiClient.request<{ items: ManagedMemory[] }>(`/persons/${personId}/memories?asContributor=true`),
    enabled: Boolean(personId),
  });

  const del = useMutation({
    mutationFn: (id: string) => apiClient.deleteMemory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-memories", personId] }),
  });
  const retract = useMutation({
    mutationFn: (id: string) => apiClient.retractMemory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-memories", personId] }),
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

  if (sessionLoading || isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
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
