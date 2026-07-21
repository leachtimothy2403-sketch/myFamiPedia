import { View, Text, Button, FlatList, ActivityIndicator, TouchableOpacity } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

interface FeedMemory {
  id: string;
  content: string | null;
  contributorName: string;
  eventDate: string | null;
  createdAt: string;
}

function FeedItem({ memory }: { memory: FeedMemory }) {
  return (
    <View style={{ borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 12, marginBottom: 8 }}>
      <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{memory.contributorName}</Text>
      <Text>{memory.content ?? "(media memory)"}</Text>
    </View>
  );
}

// Home: memory feed (section 9), pure consumption — nothing about adding
// content lives here anymore (2026-07-21 Share-tab redesign). "Manage" (view/
// organize memories you already have) stayed, since browsing your own
// archive is a "look at your stuff" action same as the feed itself; "Review
// proposed memories," "Add a photo," and "Sync camera roll" moved to the
// Share tab (the hub's conditional "Photos to review" button, and two
// secondary links added to the top of collection/review.tsx) since all three
// are ways of adding/contributing, not consuming. The "N memories to review"
// notification still deep-links straight into collection/review.tsx, unaffected.
//
// This was previously fetching /notifications and throwing every row away
// (renderItem returned null), so the feed always looked empty no matter what
// the family had added. GET /family-groups/:id/memories (new — see
// apps/api/src/routes/persons.routes.ts) is the actual family-wide "recently
// entered memories" feed; excludeVoice=true keeps raw Q&A/story recordings
// out of it, same as the person-profile Memories Feed.
export default function HomeScreen() {
  const { familyGroupId, loading: sessionLoading } = useSessionIds();

  const { data: feed, isLoading: feedLoading } = useQuery({
    queryKey: ["family-feed", familyGroupId],
    queryFn: () =>
      apiClient.request<{ items: FeedMemory[] }>(`/family-groups/${familyGroupId}/memories?excludeVoice=true`),
    enabled: Boolean(familyGroupId),
  });

  // Same GET /collection/proposed the Share hub's own conditional button
  // reads (["proposed-memories"] query key, cache-shared) — a plain labeled
  // banner instead of Home's old unconditional "Review proposed memories"
  // button, so this only ever appears when there's actually something
  // waiting, worded in plain words rather than an icon.
  const { data: proposed } = useQuery({
    queryKey: ["proposed-memories"],
    queryFn: () => apiClient.request<{ items: unknown[] }>("/collection/proposed"),
  });
  const reviewCount = proposed?.items?.length ?? 0;

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 20, fontWeight: "600" }}>Family feed</Text>
        <Button title="Manage" onPress={() => router.push("/collection/manage")} />
      </View>
      {reviewCount > 0 ? (
        <TouchableOpacity
          onPress={() => router.push("/collection/review")}
          style={{ backgroundColor: "#e8f0fe", borderRadius: 8, padding: 12 }}
        >
          <Text style={{ color: "#1a73e8", fontWeight: "600" }}>
            {reviewCount} photo{reviewCount === 1 ? "" : "s"} need a quick look
          </Text>
        </TouchableOpacity>
      ) : null}
      {sessionLoading || feedLoading ? (
        <ActivityIndicator />
      ) : (
        <FlatList
          data={feed?.items ?? []}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <FeedItem memory={item} />}
          ListEmptyComponent={<Text>No memories yet — invite family or share a story to get started.</Text>}
        />
      )}
    </View>
  );
}
