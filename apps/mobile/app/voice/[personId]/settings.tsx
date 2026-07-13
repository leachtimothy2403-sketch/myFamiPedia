import { View, Text, Button, Switch } from "react-native";
import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Ongoing control: pause/revoke (self or nominated administrator), autoplay toggle.
export default function VoiceSettingsScreen() {
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const [autoplay, setAutoplay] = useState(true);

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Voice settings</Text>
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
