import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Switch, ScrollView } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RelationshipType } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

const RELATION_OPTIONS: { label: string; value: RelationshipType }[] = [
  { label: "child", value: "parent_of" },
  { label: "parent", value: "child_of" },
  { label: "spouse", value: "spouse_of" },
  { label: "sibling", value: "sibling_of" },
  { label: "other relative", value: "other" },
];

// Was entirely missing on mobile — no screen, no navigation entry point at
// all. Mobile's counterpart to apps/web's AddFamilyMemberPanel: same two
// branches, living (creates an invitation, optionally with a shareable
// link — apiClient.inviteFamilyMember) vs deceased (Section 4, no
// invitation — apiClient.addDeceasedProfile), same relationship phrased
// from the anchor person's point of view ("New person is my ___") rather
// than the raw relationship_type direction. Reuses the same
// ["family-tree", familyGroupId] query the tree tab populates so the new
// person shows up immediately on return, and defaults "relative to" to
// yourself once the session resolves.
export default function AddFamilyMemberScreen() {
  const { personId, familyGroupId } = useSessionIds();
  const queryClient = useQueryClient();

  const { data: tree } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });
  const persons = tree?.persons ?? [];

  const [name, setName] = useState("");
  const [relatedToPersonId, setRelatedToPersonId] = useState<string | null>(null);
  const [relationshipType, setRelationshipType] = useState<RelationshipType>("parent_of");
  const [isDeceased, setIsDeceased] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveRelatedToId = relatedToPersonId ?? personId ?? persons[0]?.id ?? "";

  async function onSubmit() {
    setError(null);
    setResult(null);
    if (!name.trim() || !effectiveRelatedToId) {
      setError("Name and relation are required.");
      return;
    }
    if (isDeceased && !deathDate) {
      setError("Date of death is required for a deceased profile.");
      return;
    }

    setSubmitting(true);
    try {
      if (isDeceased) {
        await apiClient.addDeceasedProfile({
          name: name.trim(),
          relationshipType,
          relatedToPersonId: effectiveRelatedToId,
          birthDate: birthDate || null,
          deathDate,
        });
        setResult(`${name.trim()} was added to the tree.`);
      } else {
        const res = await apiClient.inviteFamilyMember({
          name: name.trim(),
          relationshipType,
          relatedToPersonId: effectiveRelatedToId,
          inviteeEmail: email || null,
          inviteePhone: phone || null,
        });
        setResult(
          res.shareableLink
            ? `${name.trim()} was added. Share this invite link with them: ${res.shareableLink}`
            : `${name.trim()} was added and invited.`
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["family-tree", familyGroupId] });
      setName("");
      setEmail("");
      setPhone("");
      setBirthDate("");
      setDeathDate("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add family member");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "700" }}>Add family member</Text>

      <TextInput
        placeholder="Name"
        value={name}
        onChangeText={setName}
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
      />

      <View>
        <Text style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>New person is my…</Text>
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
                {p.id === personId ? " (you)" : ""}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Switch value={isDeceased} onValueChange={setIsDeceased} />
        <Text style={{ fontSize: 13 }}>This person has passed away</Text>
      </View>

      {isDeceased ? (
        <>
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
        </>
      ) : (
        <>
          <TextInput
            placeholder="Email (optional)"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
          />
          <TextInput
            placeholder="Phone (optional)"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
          />
        </>
      )}

      <TouchableOpacity
        onPress={onSubmit}
        disabled={submitting}
        style={{
          backgroundColor: "#1a73e8",
          paddingVertical: 12,
          borderRadius: 6,
          alignItems: "center",
          opacity: submitting ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>{submitting ? "Adding…" : "Add to tree"}</Text>
      </TouchableOpacity>

      {result ? <Text style={{ fontSize: 13, color: "#1a7a3c" }}>{result}</Text> : null}
      {error ? <Text style={{ fontSize: 13, color: "#b3261e" }}>{error}</Text> : null}

      <TouchableOpacity onPress={() => router.back()}>
        <Text style={{ color: "#1a73e8", textAlign: "center", marginTop: 8 }}>Done</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
