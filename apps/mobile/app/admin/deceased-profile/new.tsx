import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { RelationshipType } from "@myfamipedia/shared";
import { apiClient } from "../../../lib/apiClient";
import { useSessionIds } from "../../../lib/useSessionIds";

const RELATION_OPTIONS: { label: string; value: RelationshipType }[] = [
  { label: "child", value: "parent_of" },
  { label: "parent", value: "child_of" },
  { label: "spouse", value: "spouse_of" },
  { label: "sibling", value: "sibling_of" },
  { label: "other relative", value: "other" },
];

// Section 4 entry point — administrator-only. No email/phone fields (no one
// to invite); birth/death dates collected instead. Was missing
// relationshipType/relatedToPersonId entirely — POST /persons/deceased
// requires both (apps/api's persons.routes.ts), so every submission here
// would 400. Same fix as web's counterpart route.
export default function NewDeceasedProfileScreen() {
  const { familyGroupId } = useSessionIds();
  const { data: tree } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });
  const persons = tree?.persons ?? [];

  const [name, setName] = useState("");
  const [relatedToPersonId, setRelatedToPersonId] = useState<string | null>(null);
  const [relationshipType, setRelationshipType] = useState<RelationshipType>("parent_of");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const effectiveRelatedToId = relatedToPersonId ?? persons[0]?.id ?? "";

  async function create() {
    setError(null);
    if (!name.trim() || !deathDate || !effectiveRelatedToId) {
      setError("Name, death date, and relation are required.");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.addDeceasedProfile({
        name: name.trim(),
        relationshipType,
        relatedToPersonId: effectiveRelatedToId,
        birthDate: birthDate || null,
        deathDate,
      });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this profile");
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Create a profile in memory of…</Text>

      <TextInput
        placeholder="Name"
        value={name}
        onChangeText={setName}
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
      />

      <View>
        <Text style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>This person is my…</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {RELATION_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              onPress={() => setRelationshipType(opt.value)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: relationshipType === opt.value ? "#1a73e8" : "#ddd",
                backgroundColor: relationshipType === opt.value ? "#e8f0fe" : "white",
              }}
            >
              <Text style={{ fontSize: 13, color: relationshipType === opt.value ? "#1a73e8" : "#333" }}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View>
        <Text style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>relative to</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {persons.map((p) => (
            <TouchableOpacity
              key={p.id}
              onPress={() => setRelatedToPersonId(p.id)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: effectiveRelatedToId === p.id ? "#1a73e8" : "#ddd",
                backgroundColor: effectiveRelatedToId === p.id ? "#e8f0fe" : "white",
              }}
            >
              <Text style={{ fontSize: 13, color: effectiveRelatedToId === p.id ? "#1a73e8" : "#333" }}>
                {p.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <TextInput
        placeholder="Birth date (YYYY-MM-DD, optional)"
        value={birthDate}
        onChangeText={setBirthDate}
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
      />
      <TextInput
        placeholder="Death date (YYYY-MM-DD)"
        value={deathDate}
        onChangeText={setDeathDate}
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
      />

      <TouchableOpacity
        onPress={create}
        disabled={submitting}
        style={{
          backgroundColor: "#1a73e8",
          paddingVertical: 12,
          borderRadius: 6,
          alignItems: "center",
          opacity: submitting ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>{submitting ? "Creating…" : "Create profile"}</Text>
      </TouchableOpacity>
      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </ScrollView>
  );
}
