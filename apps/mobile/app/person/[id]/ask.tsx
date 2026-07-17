import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Ask feature: real clip match(es) first, AI synthesis fallback, gap
// acknowledgment if neither exists — see docs/api_structure.md. Genuinely
// not implemented server-side yet (needs embeddings + Claude, see apps/api's
// persons.routes.ts), so errors are surfaced plainly rather than left as an
// unhandled rejection — mobile's counterpart to apps/web's AskPanel.
export default function AskScreen() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function ask() {
    setError(null);
    setAsking(true);
    try {
      const res = await apiClient.request<{ answer: string }>(`/persons/${id}/ask`, {
        method: "POST",
        body: { question },
      });
      setAnswer(res.answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This feature isn't available yet.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <TextInput
        placeholder="Ask something…"
        value={question}
        onChangeText={setQuestion}
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
      />
      <TouchableOpacity
        onPress={ask}
        disabled={asking}
        style={{
          backgroundColor: "#1a73e8",
          paddingVertical: 10,
          borderRadius: 6,
          alignItems: "center",
          opacity: asking ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>{asking ? "Asking…" : "Ask"}</Text>
      </TouchableOpacity>
      {answer ? <Text>{answer}</Text> : null}
      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
