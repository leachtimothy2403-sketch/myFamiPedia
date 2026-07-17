import { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Self or administrator-only edit — enforced server-side via RLS. Pre-fills
// from the existing profile (PATCH /persons/:id already accepts birthDate/
// deathDate/profileData). Mobile's counterpart to
// apps/web/src/routes/person/[id]/edit.tsx; dates are plain YYYY-MM-DD
// TextInputs rather than a native date picker, matching mobile's existing
// minimal-dependency approach.
export default function PersonEditScreen() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getPerson(id)
      .then((person) => {
        if (cancelled) return;
        setName(person.name);
        setBirthDate(person.birthDate ?? "");
        setDeathDate(person.deathDate ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load this profile"))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiClient.request(`/persons/${id}`, {
        method: "PATCH",
        body: { name, birthDate: birthDate.trim() || null, deathDate: deathDate.trim() || null },
      });
      router.replace(`/person/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes");
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "700" }}>Edit profile</Text>
      <View>
        <Text style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
        />
      </View>
      <View>
        <Text style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Date of birth (YYYY-MM-DD)</Text>
        <TextInput
          value={birthDate}
          onChangeText={setBirthDate}
          placeholder="YYYY-MM-DD"
          style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
        />
      </View>
      <View>
        <Text style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Date of death (leave blank if living)</Text>
        <TextInput
          value={deathDate}
          onChangeText={setDeathDate}
          placeholder="YYYY-MM-DD"
          style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
        />
      </View>
      <TouchableOpacity
        onPress={save}
        disabled={saving}
        style={{
          backgroundColor: "#1a73e8",
          paddingVertical: 10,
          borderRadius: 6,
          alignItems: "center",
          opacity: saving ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>{saving ? "Saving…" : "Save"}</Text>
      </TouchableOpacity>
      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
