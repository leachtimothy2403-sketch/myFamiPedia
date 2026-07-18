import { View, Text, Button, FlatList, ActivityIndicator } from "react-native";
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

// Home: memory feed (section 9). The "manage your memories" icon in the
// header links to collection/manage.tsx; "N memories to review" notifications
// deep-link to collection/review.tsx (see mobile_app_structure.md).
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

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 20, fontWeight: "600" }}>Family feed</Text>
        <Button title="Manage" onPress={() => router.push("/collection/manage")} />
      </View>
      <Button title="Review proposed memories" onPress={() => router.push("/collection/review")} />
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
