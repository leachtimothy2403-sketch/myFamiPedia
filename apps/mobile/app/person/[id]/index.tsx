import { View, Text, Button } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../../lib/apiClient";

// Profile: header stats, tags, life timeline, memories feed, connections.
export default function PersonProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: person } = useQuery({
    queryKey: ["person", id],
    queryFn: () => apiClient.getPerson(id),
  });

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>{(person as any)?.name ?? "Loading…"}</Text>
      <Text>Life timeline, memories, and family connections render here.</Text>
      <Button title="Ask" onPress={() => router.push(`/person/${id}/ask`)} />
      <Button title="Edit" onPress={() => router.push(`/person/${id}/edit`)} />
    </View>
  );
}
