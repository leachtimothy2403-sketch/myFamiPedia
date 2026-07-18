import { View, Text, Button, Switch } from "react-native";
import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Ongoing control: pause/revoke (self or nominated administrator), autoplay
// toggle. The consent flow itself (app/voice/[personId]/consent.tsx) is a
// separate screen that had no navigation path to it anywhere on mobile —
// web's equivalent settings page opens it via a "Manage consent" button
// (apps/web/src/routes/settings/voice.tsx); this adds the same entry point
// here.
export default function VoiceSettingsScreen() {
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const [autoplay, setAutoplay] = useState(true);

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Voice settings</Text>
      <Button title="Manage consent" onPress={() => router.push(`/voice/${personId}/consent`)} />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text>Autoplay voice clips</Text>
        <Switch value={autoplay} onValueChange={setAutoplay} />
      </View>
      <Button
        title="Pause"
        onPress={() => apiClient.request(`/persons/${personId}/voice-model/pause`, { method: "POST" })}
      />
      <Button
        title="Revoke"
        onPress={() => apiClient.request(`/persons/${personId}/voice-model/revoke`, { method: "POST" })}
      />
    </View>
  );
}
