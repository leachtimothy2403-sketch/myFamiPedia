import { useState } from "react";
import { View, TextInput, Button } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Self or administrator-only edit — enforced server-side via RLS
// (privacy_tier_self_write / tenant_isolation), this screen just calls PATCH.
export default function EditPersonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [name, setName] = useState("");

  async function save() {
    await apiClient.request(`/persons/${id}`, { method: "PATCH", body: { name } });
    router.back();
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <TextInput placeholder="Name" value={name} onChangeText={setName} />
      <Button title="Save" onPress={save} />
    </View>
  );
}
