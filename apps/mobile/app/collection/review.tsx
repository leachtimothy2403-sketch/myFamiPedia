import { View, Text, Image, Button, FlatList } from "react-native";
import { router } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

// GET /collection/proposed resolves each proposal's source (a single
// classified photo or a time/location cluster, design doc section 9) into a
// presigned R2 URL + caption server-side — this screen just renders what it's
// given, no source-specific branching needed here.
interface ProposedMemory {
  id: string;
  source: "photo" | "cluster";
  photoUrl: string | null;
  caption: string | null;
  photoCount: number;
}

// Section 2 proposal queue — 2-tap accept/reject, under two minutes per the
// product doc. Reachable from the Share tab's conditional "Photos to review"
// button (only shown when something's actually waiting — (tabs)/share-story.tsx)
// and via the "N memories to review" notification deep-link.
//
// "Add a photo" and "Sync camera roll" (2026-07-21) moved here from Home's
// header, alongside this — all three are ways of getting photos into the
// pipeline, so they now live together on the photo-review screen rather than
// competing with the feed for space on Home.
export default function CollectionReviewScreen() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["proposed-memories"],
    queryFn: () => apiClient.request<{ items: ProposedMemory[] }>("/collection/proposed"),
  });

  // Accepting used to just make the card disappear — the endpoint returned a
  // bare 204, so there was nowhere to go even though the resulting memory
  // has no content yet. It now returns { memoryId, photoId }; navigate
  // straight into compose.tsx (with memoryId set) so the user finishes
  // tagging faces and describing the memory instead of leaving an empty one
  // behind. See docs/media_pipeline.md's 2026-07-19 update for why this was
  // a real gap, not a stub.
  const accept = useMutation({
    mutationFn: (id: string) =>
      apiClient.request<{ memoryId: string; photoId: string }>(`/collection/proposed/${id}/accept`, { method: "POST" }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["proposed-memories"] });
      router.push(`/collection/compose?photoId=${result.photoId}&memoryId=${result.memoryId}`);
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => apiClient.request(`/collection/proposed/${id}/reject`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposed-memories"] }),
  });

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 12 }}>Memories to review</Text>
      <View style={{ flexDirection: "row", gap: 12, marginBottom: 16 }}>
        <Button title="Add a photo" onPress={() => router.push("/collection/add-photo")} />
        <Button title="Sync camera roll" onPress={() => router.push("/collection/camera-roll-sync")} />
      </View>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ marginBottom: 24 }}>
            {item.photoUrl ? (
              <Image
                source={{ uri: item.photoUrl }}
                style={{ width: "100%", height: 260, borderRadius: 12, backgroundColor: "#e5e5e5" }}
                resizeMode="cover"
              />
            ) : (
              <View
                style={{
                  width: "100%",
                  height: 260,
                  borderRadius: 12,
                  backgroundColor: "#e5e5e5",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: "#666" }}>No preview available</Text>
              </View>
            )}
            {item.source === "cluster" && item.photoCount > 1 ? (
              <Text style={{ marginTop: 8, color: "#666" }}>{item.photoCount} photos from this outing</Text>
            ) : null}
            {item.caption ? <Text style={{ marginTop: 4, fontSize: 15 }}>{item.caption}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Button title="Accept" onPress={() => accept.mutate(item.id)} />
              <Button title="Reject" onPress={() => reject.mutate(item.id)} />
            </View>
          </View>
        )}
        ListEmptyComponent={<Text>Nothing waiting for review.</Text>}
      />
    </View>
  );
}
