import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

// 2026-07-21 — Share tab redesign. Used to BE the interview-only flow
// (whose story + open-ended/Q&A/photo-prompted); that content moved
// unchanged to ../share/tell-your-story.tsx. This is now a flat hub: three
// big, plainly-labeled buttons, each going to its own full screen — no
// sub-tabs, no segmented control to discover first. Deliberately flat rather
// than nested: a key user group here is older adults, and a control you
// have to notice and tap to reveal more options is a worse pattern for that
// audience than just showing the options.
//
// Consolidates what used to be three separate, half-overlapping ways to add
// content (this screen's interview flow, a person profile's always-open
// text box, Home's "Review proposed memories" button) into one place. See
// docs/handover_2026-07-21-share-tab-redesign.md for the full writeup.
function HubButton({ label, sublabel, onPress }: { label: string; sublabel: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        backgroundColor: "#f0f0f0",
        borderRadius: 12,
        padding: 20,
        gap: 4,
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: "700" }}>{label}</Text>
      <Text style={{ fontSize: 14, color: "#666" }}>{sublabel}</Text>
    </TouchableOpacity>
  );
}

// 2026-07-22 — the question-stream nudge (docs/section2_pipeline.md section
// 4) finally gets a screen: GET /persons/:id/question-prompt and POST
// /question-prompt/:id/answer existed API-only until now. A compact banner
// above the three hub buttons, not a 4th equally-weighted button — this is a
// lightweight "answer one quick question" aside, not a whole activity on the
// same footing as "Share a memory" or "Tell your story", so it gets the same
// treatment as the "Photos to review" button: present only when there's
// something real to show, plain text, no icon to interpret.
function QuestionPromptBanner({ personId }: { personId: string }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["question-prompt", personId],
    queryFn: () => apiClient.getQuestionPrompt(personId),
  });
  const question = data?.question ?? null;

  async function submit() {
    if (!question || !answer.trim()) {
      setError("Write something first, or leave it for another time.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.answerQuestionPrompt(question.id, { content: answer.trim() });
      setAnswer("");
      await queryClient.invalidateQueries({ queryKey: ["question-prompt", personId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!question) return null;

  return (
    <View style={{ backgroundColor: "#fafafa", borderRadius: 12, padding: 16, gap: 10 }}>
      <Text style={{ fontSize: 13, color: "#666", fontWeight: "600" }}>TODAY'S QUESTION</Text>
      <Text style={{ fontSize: 16, fontWeight: "600" }}>{question.text}</Text>
      <TextInput
        placeholder="Type your answer…"
        value={answer}
        onChangeText={setAnswer}
        multiline
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, fontSize: 15, backgroundColor: "white", minHeight: 44 }}
      />
      <TouchableOpacity
        onPress={submit}
        disabled={submitting}
        style={{ alignSelf: "flex-end", backgroundColor: "#1a73e8", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, opacity: submitting ? 0.6 : 1 }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>{submitting ? "Saving…" : "Answer"}</Text>
      </TouchableOpacity>
      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

export default function ShareHubScreen() {
  const { personId } = useSessionIds();

  // Only shown at all when there's actually something waiting — an empty
  // "Photos to review" button every time you open this tab is clutter, not
  // a helpful constant option. Same GET /collection/proposed review.tsx
  // itself reads from; a cache hit if that screen was already visited.
  const { data: proposed } = useQuery({
    queryKey: ["proposed-memories"],
    queryFn: () => apiClient.request<{ items: unknown[] }>("/collection/proposed"),
  });
  const reviewCount = proposed?.items?.length ?? 0;

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>Share</Text>

      {personId ? <QuestionPromptBanner personId={personId} /> : null}

      <HubButton
        label="Share a memory"
        sublabel="Write about something that happened, and say who it's about"
        onPress={() => router.push("/share/compose")}
      />

      <HubButton
        label="Tell your story"
        sublabel="A guided conversation about your life, or someone else's"
        onPress={() => router.push("/share/tell-your-story")}
      />

      {reviewCount > 0 ? (
        <HubButton
          label="Photos to review"
          sublabel={`${reviewCount} photo${reviewCount === 1 ? "" : "s"} waiting for a quick look`}
          onPress={() => router.push("/collection/review")}
        />
      ) : null}
    </View>
  );
}
