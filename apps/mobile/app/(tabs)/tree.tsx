import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";
import { TreeCanvas } from "../../components/tree/TreeCanvas";

// 2026-07-20 — by-person and by-decade browsing (a searchable flat list and
// a decade-grouped list, both just client-side reshapes of the same tree
// fetch below) were removed at Tim's request: this tab is the family-tree
// structure now, full stop. Person lookup lives in Search; nothing else in
// the app depended on either view (grep confirmed no other screen imported
// groupByDecade/groupByGeneration from ../../lib/treeGrouping, so that file
// was left in place rather than deleted, in case it's reused later — but
// nothing calls into it from here anymore).
export default function TreeScreen() {
  const { personId, familyGroupId, loading: sessionLoading } = useSessionIds();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });

  const persons = data?.persons ?? [];
  const relationships = data?.relationships ?? [];

  if (sessionLoading || isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
        <Text>Couldn't load your family tree.</Text>
        <TouchableOpacity onPress={() => refetch()}>
          <Text style={{ color: "#1a73e8" }}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Was entirely missing on mobile — web's tree page has an "+ Add
          family member" button, mobile never did. Links to the new
          app/family-member/new.tsx screen (this session). */}
      <TouchableOpacity
        onPress={() => router.push("/family-member/new")}
        style={{
          marginHorizontal: 16,
          marginTop: 12,
          marginBottom: 12,
          paddingVertical: 10,
          borderRadius: 8,
          alignItems: "center",
          backgroundColor: "#1a73e8",
        }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>+ Add family member</Text>
      </TouchableOpacity>

      {persons.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Text style={{ color: "#888" }}>No one in the tree yet.</Text>
        </View>
      ) : (
        <TreeCanvas
          persons={persons}
          relationships={relationships}
          rootPersonId={personId}
          onSelectPerson={(id) => router.push(`/person/${id}`)}
        />
      )}
    </View>
  );
}
