import { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, TextInput, SectionList, FlatList, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { Person } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";
import { groupByGeneration, groupByDecade } from "../../lib/treeGrouping";

type TreeMode = "structure" | "by-person" | "by-decade";

function lifespan(person: Person): string | null {
  const birthYear = person.birthDate?.slice(0, 4);
  const deathYear = person.deathDate?.slice(0, 4);
  if (!birthYear && !deathYear) return null;
  if (person.status === "deceased") return `${birthYear ?? "?"}–${deathYear ?? "?"}`;
  return birthYear ? `b. ${birthYear}` : null;
}

function PersonRow({ person, isSelf }: { person: Person; isSelf: boolean }) {
  const years = lifespan(person);
  return (
    <TouchableOpacity
      onPress={() => router.push(`/person/${person.id}`)}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 4,
        flexDirection: "row",
        justifyContent: "space-between",
        borderBottomWidth: 1,
        borderBottomColor: "#eee",
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: isSelf ? "700" : "400" }}>
        {person.name}
        {isSelf ? " (you)" : ""}
      </Text>
      {years ? <Text style={{ color: "#888" }}>{years}</Text> : null}
    </TouchableOpacity>
  );
}

// Explore is folded into this tab: a segmented control switches between a
// generation-grouped list (Structure), a searchable flat list (By person),
// and a decade-grouped list (By decade). Mobile is intentionally the
// simplified read-mostly view of the same family-tree data web's full
// pan/zoom canvas renders — see docs/web_app_structure.md's intro and
// "Tree tab" notes in mobile_app_structure.md.
export default function TreeScreen() {
  const [mode, setMode] = useState<TreeMode>("structure");
  const [search, setSearch] = useState("");
  const { personId, familyGroupId, loading: sessionLoading } = useSessionIds();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });

  const persons = data?.persons ?? [];
  const relationships = data?.relationships ?? [];

  const generationGroups = useMemo(
    () => groupByGeneration(persons, relationships, personId),
    [persons, relationships, personId]
  );
  const decadeGroups = useMemo(() => groupByDecade(persons), [persons]);
  const filteredPersons = useMemo(
    () =>
      persons
        .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [persons, search]
  );

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
      <View style={{ flexDirection: "row", justifyContent: "space-around", padding: 12 }}>
        {(["structure", "by-person", "by-decade"] as TreeMode[]).map((m) => (
          <TouchableOpacity key={m} onPress={() => setMode(m)}>
            <Text style={{ fontWeight: mode === m ? "700" : "400" }}>
              {m === "structure" ? "Structure" : m === "by-person" ? "By person" : "By decade"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {persons.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Text style={{ color: "#888" }}>No one in the tree yet.</Text>
        </View>
      ) : mode === "structure" ? (
        <SectionList
          sections={generationGroups.map((g) => ({ title: g.label, data: g.persons }))}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <PersonRow person={item} isSelf={item.id === personId} />}
          renderSectionHeader={({ section }) => (
            <Text style={{ fontWeight: "600", paddingVertical: 8, paddingHorizontal: 4, backgroundColor: "#fafafa" }}>
              {section.title}
            </Text>
          )}
          contentContainerStyle={{ paddingHorizontal: 16 }}
        />
      ) : mode === "by-person" ? (
        <View style={{ flex: 1, paddingHorizontal: 16 }}>
          <TextInput
            placeholder="Search family members…"
            value={search}
            onChangeText={setSearch}
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 8, marginBottom: 8 }}
          />
          <FlatList
            data={filteredPersons}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <PersonRow person={item} isSelf={item.id === personId} />}
            ListEmptyComponent={<Text style={{ color: "#888", paddingVertical: 12 }}>No matches.</Text>}
          />
        </View>
      ) : (
        <SectionList
          sections={decadeGroups.map((g) => ({ title: g.decade, data: g.persons }))}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <PersonRow person={item} isSelf={item.id === personId} />}
          renderSectionHeader={({ section }) => (
            <Text style={{ fontWeight: "600", paddingVertical: 8, paddingHorizontal: 4, backgroundColor: "#fafafa" }}>
              {section.title}
            </Text>
          )}
          contentContainerStyle={{ paddingHorizontal: 16 }}
        />
      )}
    </View>
  );
}
