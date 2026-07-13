import { useState } from "react";
import { View, Text, TextInput, Button } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Ask feature: real clip match(es) first, AI synthesis fallback, gap
// acknowledgment if neither exists — see docs/api_structure.md.
export default function AskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  async function ask() {
    const res = await apiClient.request<{ answer: string }>(`/persons/${id}/ask`, {
      method: "POST",
      body: { question },
    });
    setAnswer(res.answer);
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <TextInput placeholder="Ask something…" value={question} onChangeText={setQuestion} />
      <Button title="Ask" onPress={ask} />
      {answer ? <Text>{answer}</Text> : null}
    </View>
  );
}
