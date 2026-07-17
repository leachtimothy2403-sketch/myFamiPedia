import { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { Person } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

// Replaces the old three-screen hop (share-story "Get started" ->
// interview/new "whose story is this" -> interview/[personId]/new "pick a
// starting point"). Per product feedback, all of that collapses into one
// screen with a progressive reveal: pick who this is for, then the three
// starting-point choices appear in place. interview/new.tsx and
// interview/[personId]/new.tsx are removed — nothing links to them anymore.
type Subject = "self" | "other" | null;

function chooserButtonStyle(selected: boolean) {
  return {
    backgroundColor: selected ? "#1a73e8" : "#f0f0f0",
    padding: 14,
    borderRadius: 8,
    flex: 1,
  } as const;
}

function activityButtonStyle(disabled: boolean) {
  return {
    backgroundColor: "#f0f0f0",
    padding: 14,
    borderRadius: 8,
    opacity: disabled ? 0.6 : 1,
  } as const;
}

export default function ShareStoryScreen() {
  const { personId: selfPersonId, familyGroupId } = useSessionIds();
  const [subject, setSubject] = useState<Subject>(null);
  const [otherPerson, setOtherPerson] = useState<Person | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: tree, isLoading: treeLoading } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: subject === "other" && Boolean(familyGroupId),
  });
  const otherCandidates = (tree?.persons ?? []).filter((p) => p.id !== selfPersonId);

  const subjectPersonId = subject === "self" ? selfPersonId : subject === "other" ? otherPerson?.id ?? null : null;
  const subjectLabel = subject === "self" ? "you" : otherPerson?.name ?? null;

  function chooseSubject(next: Subject) {
    setError(null);
    setSubject(next);
    if (next === "self") setOtherPerson(null);
  }

  async function startSession(questionId?: string, questionText?: string) {
    if (!subjectPersonId) return;
    setError(null);
    setStarting(true);
    try {
      const session = await apiClient.request<{ id: string }>("/interview-sessions", {
        method: "POST",
        body: { personId: subjectPersonId },
      });
      const params = new URLSearchParams();
      params.set("personId", subjectPersonId);
      if (questionId) params.set("questionId", questionId);
      if (questionText) params.set("questionText", questionText);
      router.push(`/interview/session/${session.id}?${params.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start this session — try again.");
    } finally {
      setStarting(false);
    }
  }

  // Adaptive Q&A: ask the API for the next question rather than always
  // taking questions[0] — it works through the curated bank first, then
  // (once that's exhausted) a Claude-generated follow-up based on what this
  // person has actually talked about (GET /interview-questions/next, added
  // alongside this screen). A 204 means there's nothing curated left AND
  // nothing yet to build a follow-up from — falls back to the open-ended
  // starting point instead of a dead end.
  async function startQA() {
    if (!subjectPersonId) return;
    setError(null);
    setStarting(true);
    try {
      const next = await apiClient.request<{ id: string; text: string } | undefined>(
        `/interview-questions/next?personId=${subjectPersonId}`
      );
      if (!next) {
        setError("Nothing personalized to ask yet — try “Share a memory” first, then come back to Q & A.");
        return;
      }
      await startSession(next.id, next.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the next question — try again.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Share your story</Text>

      <View>
        <Text style={{ fontWeight: "600", marginBottom: 8 }}>Whose story is this?</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity style={chooserButtonStyle(subject === "self")} onPress={() => chooseSubject("self")}>
            <Text style={{ color: subject === "self" ? "white" : "#1a1a1a", fontWeight: "600", textAlign: "center" }}>
              My own story
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={chooserButtonStyle(subject === "other")} onPress={() => chooseSubject("other")}>
            <Text style={{ color: subject === "other" ? "white" : "#1a1a1a", fontWeight: "600", textAlign: "center" }}>
              Record someone else
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {subject === "other" && !otherPerson ? (
        <View style={{ gap: 4 }}>
          {treeLoading ? (
            <ActivityIndicator />
          ) : otherCandidates.length === 0 ? (
            <Text style={{ color: "#888" }}>No one else in the tree yet.</Text>
          ) : (
            otherCandidates.map((p) => (
              <TouchableOpacity
                key={p.id}
                onPress={() => setOtherPerson(p)}
                style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#eee" }}
              >
                <Text style={{ fontSize: 16 }}>{p.name}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      ) : null}

      {subjectPersonId ? (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: "#666" }}>Recording for {subjectLabel}</Text>
            <TouchableOpacity onPress={() => chooseSubject(null)}>
              <Text style={{ color: "#1a73e8" }}>Change</Text>
            </TouchableOpacity>
          </View>

          {/* All three used to render with different styles ("Share a
              memory" hardcoded blue, the other two grey) — that read as a
              persistent selection highlight on "Share a memory" that never
              moved even after tapping Q & A. These are three equal peer
              choices, not one primary + two secondary, so all three now
              share the same neutral style; none of them are a toggled/
              selected state to begin with. */}
          <TouchableOpacity onPress={() => startSession()} disabled={starting} style={activityButtonStyle(starting)}>
            <Text style={{ fontWeight: "600", textAlign: "center" }}>Share a memory / talk about your life</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={startQA} disabled={starting} style={activityButtonStyle(starting)}>
            <Text style={{ fontWeight: "600", textAlign: "center" }}>Q &amp; A</Text>
          </TouchableOpacity>

          {/* Photo capture itself isn't wired here yet — same note as before:
              needs expo-image-picker + apiClient.presignUpload({context: "photo"})
              + attaching via POST /interview-sessions/:id/answers' photoIds. */}
          <TouchableOpacity onPress={() => startSession()} disabled={starting} style={activityButtonStyle(starting)}>
            <Text style={{ fontWeight: "600", textAlign: "center" }}>Start with a picture and talk about it</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
