import { View, Text, Button } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiClient } from "../../lib/apiClient";

// Single memory detail + reactions.
export default function MemoryDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  async function react() {
    await apiClient.reactToMemory(id, { reactionType: "touched_me" });
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text>Memory content, provenance label, and photos render here.</Text>
      <Button title="This touched me" onPress={react} />
    </View>
  );
}
