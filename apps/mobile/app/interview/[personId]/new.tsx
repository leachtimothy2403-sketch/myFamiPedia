import { useState } from "react";
import { View, Text, Button, FlatList } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../../lib/apiClient";

// Pick a question set, or start from a photo (camera capture or library) —
// physical_scan source per docs/data_model.md's photo-as-conversation-starter note.
export default function InterviewQuestionPickerScreen() {
  const { personId } = useLocalSearchParams<{ personId: string }>();
  const [lifePhase] = useState<string | undefined>(undefined);
  const { data } = useQuery({
    queryKey: ["interview-questions", lifePhase],
    queryFn: () => apiClient.request<{ items: { id: string; text: string }[] }>("/interview-questions"),
  });

  async function startSession() {
    const session = await apiClient.request<{ id: string }>("/interview-sessions", {
      method: "POST",
      body: { personId },
    });
    router.push(`/interview/session/${session.id}`);
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Choose a starting point</Text>
      <Button title="Start from a photo" onPress={startSession} />
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(q) => q.id}
        renderItem={({ item }) => <Button title={item.text} onPress={startSession} />}
      />
    </View>
  );
}
