import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Switch, ScrollView, ActivityIndicator } from "react-native";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Person } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

// 2026-07-21 — the "Share a memory" button on the new flat Share hub
// ((tabs)/share-story.tsx), and the replacement for person/[id]/index.tsx's
// old always-open AddMemoryForm box (which had two real problems: no way to
// tag anyone other than the profile you happened to be on, and a text field
// whose placeholder text was easy to mistake for something you'd actually
// typed — Tim hit both live-testing). One shared screen, two doors in: the
// hub with nobody pre-tagged, or a profile's "Share a memory about {name}"
// button with `personId` pre-filled here.
//
// Text-only, same as the form this replaces and apps/web's counterpart —
// mediaUrl/photoIds are accepted by POST /memories but nothing can populate
// them without R2 credentials configured (apps/api's r2.service.ts is a
// deliberate stub).
export default function ShareComposeScreen() {
  const { personId: prefilledPersonId } = useLocalSearchParams<{ personId?: string }>();
  const { familyGroupId } = useSessionIds();
  const queryClient = useQueryClient();

  const [content, setContent] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [taggedIds, setTaggedIds] = useState<string[]>(prefilledPersonId ? [prefilledPersonId] : []);
  const [suggestedIds, setSuggestedIds] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same cache-shared ["family-tree", familyGroupId] query every other
  // person-picker in the app already uses (share-story's "record someone
  // else" picker, collection/compose.tsx's tap-to-tag panel) — a cache hit
  // if either of those was visited already this session.
  const { data: tree, isLoading: treeLoading } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });
  const candidates: Person[] = (tree?.persons ?? []).filter(
    (p) => p.status === "active" || p.status === "invited_pending"
  );

  function toggleTag(id: string) {
    setTaggedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    setSuggestedIds((ids) => ids.filter((x) => x !== id));
  }

  // "Suggest people" — reads the roster for name mentions in the text you've
  // typed (claude.service.ts's suggestMentionedPersons). Deliberately a
  // button you press, not something that fires automatically as you type:
  // predictable and unsurprising beats "magic" for this audience, and it
  // keeps this to one Claude call per attempt instead of one per keystroke
  // pause. Never auto-applies a tag — only ever adds a person to the
  // suggested list below, which you still have to tap to actually add.
  //
  // Text-only on purpose: reading typed text for a name mention is a
  // completely different, much lower-risk thing than trying to recognize
  // who's IN a photo. Real face-matching for that was deliberately retired
  // (docs/family_administrator_and_privacy_model.md section 5 — GDPR
  // Article 9 biometric-data exposure, no legal sign-off) and isn't coming
  // back here or anywhere else.
  async function suggestPeople() {
    if (!content.trim()) return;
    setSuggesting(true);
    setError(null);
    try {
      const { personIds } = await apiClient.suggestMemoryTags(content.trim());
      setSuggestedIds(personIds.filter((id) => !taggedIds.includes(id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get suggestions — you can still tag people yourself below.");
    } finally {
      setSuggesting(false);
    }
  }

  async function onSubmit() {
    if (!content.trim()) {
      setError("Write something first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.createMemory({
        content: content.trim(),
        eventDate: eventDate.trim() || null,
        provenanceType: "text",
        isPrivate,
        personIds: taggedIds,
        photoIds: [],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["family-feed", familyGroupId] }),
        ...taggedIds.flatMap((id) => [
          queryClient.invalidateQueries({ queryKey: ["person-memories", id] }),
          queryClient.invalidateQueries({ queryKey: ["person-timeline", id] }),
        ]),
      ]);
      if (prefilledPersonId) {
        router.replace(`/person/${prefilledPersonId}`);
      } else {
        router.replace("/(tabs)");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this memory");
      setSubmitting(false);
    }
  }

  const suggestedPeople = candidates.filter((p) => suggestedIds.includes(p.id));

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Stack.Screen options={{ title: "Share a memory" }} />

      <TextInput
        placeholder="What happened?"
        value={content}
        onChangeText={setContent}
        multiline
        numberOfLines={5}
        style={{
          minHeight: 120,
          textAlignVertical: "top",
          borderWidth: 1,
          borderColor: "#ddd",
          borderRadius: 8,
          padding: 12,
          fontSize: 16,
        }}
      />

      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <TextInput
          placeholder="Date (YYYY-MM-DD, optional)"
          value={eventDate}
          onChangeText={setEventDate}
          style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, fontSize: 15 }}
        />
        <Text style={{ fontSize: 15 }}>Private</Text>
        <Switch value={isPrivate} onValueChange={setIsPrivate} />
      </View>

      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontWeight: "600", fontSize: 16 }}>Who is this about?</Text>
          <TouchableOpacity onPress={suggestPeople} disabled={suggesting || !content.trim()}>
            <Text style={{ color: content.trim() ? "#1a73e8" : "#aaa", fontSize: 14 }}>
              {suggesting ? "Checking…" : "Suggest people"}
            </Text>
          </TouchableOpacity>
        </View>

        {suggestedPeople.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {suggestedPeople.map((p) => (
              <TouchableOpacity
                key={p.id}
                onPress={() => toggleTag(p.id)}
                style={{
                  backgroundColor: "#e8f0fe",
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <Text style={{ color: "#1a73e8", fontSize: 14 }}>+ {p.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {treeLoading ? (
          <ActivityIndicator />
        ) : candidates.length === 0 ? (
          <Text style={{ color: "#888" }}>No one else in the tree yet.</Text>
        ) : (
          <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 8 }}>
            {candidates.map((p, i) => {
              const checked = taggedIds.includes(p.id);
              return (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => toggleTag(p.id)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingVertical: 14,
                    paddingHorizontal: 14,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: "#eee",
                  }}
                >
                  <View
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      borderWidth: 2,
                      borderColor: checked ? "#1a73e8" : "#bbb",
                      backgroundColor: checked ? "#1a73e8" : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {checked ? <Text style={{ color: "white", fontSize: 14, fontWeight: "700" }}>✓</Text> : null}
                  </View>
                  <Text style={{ fontSize: 16 }}>{p.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

      <TouchableOpacity
        onPress={onSubmit}
        disabled={submitting}
        style={{
          backgroundColor: "#1a73e8",
          paddingVertical: 14,
          borderRadius: 8,
          alignItems: "center",
          opacity: submitting ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "white", fontWeight: "700", fontSize: 16 }}>{submitting ? "Saving…" : "Add memory"}</Text>
      </TouchableOpacity>

      {error ? <Text style={{ color: "#b3261e", fontSize: 14 }}>{error}</Text> : null}
    </ScrollView>
  );
}
