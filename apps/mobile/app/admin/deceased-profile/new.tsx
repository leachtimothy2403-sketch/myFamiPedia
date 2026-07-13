import { useState } from "react";
import { View, Text, TextInput, Button } from "react-native";
import { router } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Section 4 entry point — administrator-only. No email/phone fields (no one
// to invite); birth/death dates collected instead. See docs/data_model.md's
// "living vs. deceased branch" note for how this differs from the manual
// add-family-member flow.
export default function NewDeceasedProfileScreen() {
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");

  async function create() {
    await apiClient.request("/persons/deceased", {
      method: "POST",
      body: { name, birthDate: birthDate || null, deathDate: deathDate || null },
    });
    router.back();
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Create a profile in memory of…</Text>
      <TextInput placeholder="Name" value={name} onChangeText={setName} />
      <TextInput placeholder="Birth date (YYYY-MM-DD)" value={birthDate} onChangeText={setBirthDate} />
      <TextInput placeholder="Death date (YYYY-MM-DD)" value={deathDate} onChangeText={setDeathDate} />
      <Button title="Create profile" onPress={create} />
    </View>
  );
}
