import { useMemo, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Switch, ScrollView, ActivityIndicator } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Memory, Person, Relationship, RelationshipType } from "@myfamipedia/shared";
import { apiClient } from "../../../lib/apiClient";
import { useSessionIds } from "../../../lib/useSessionIds";

const STATUS_LABEL: Record<Person["status"], string> = {
  active: "Active",
  invited_pending: "Invitation pending",
  declined_grace: "Declined (grace period)",
  opted_out: "Opted out",
  deceased: "In memoriam",
};

function lifespan(person: Person): string | null {
  const birthYear = person.birthDate?.slice(0, 4);
  const deathYear = person.deathDate?.slice(0, 4);
  if (!birthYear && !deathYear) return null;
  if (person.status === "deceased") return `${birthYear ?? "?"} – ${deathYear ?? "?"}`;
  return birthYear ? `Born ${birthYear}` : null;
}

function ProfileHeader({ person }: { person: Person }) {
  const years = lifespan(person);
  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ fontSize: 22, fontWeight: "700" }}>{person.name}</Text>
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: person.status === "deceased" ? "#e5e5e5" : "#e8f0fe",
          }}
        >
          <Text style={{ fontSize: 12, color: person.status === "deceased" ? "#555" : "#1a73e8" }}>
            {STATUS_LABEL[person.status] ?? person.status}
          </Text>
        </View>
      </View>
      {years ? <Text style={{ color: "#666", marginTop: 4 }}>{years}</Text> : null}
      {person.aiSummary ? (
        <View style={{ backgroundColor: "#fafafa", padding: 12, borderRadius: 8, marginTop: 8 }}>
          <Text style={{ fontSize: 13 }}>
            <Text style={{ fontStyle: "italic" }}>AI-generated summary: </Text>
            {person.aiSummary}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

interface TimelineEvent {
  id: string;
  date: string | null;
  label: string;
}

// Dumb/presentational on purpose, same as apps/web's LifeTimeline — the
// screen maps raw Memory rows (content/eventDate) into this shape.
function LifeTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <Text style={{ color: "#888", fontSize: 14, marginBottom: 16 }}>No dated memories yet.</Text>;
  }
  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 8 }}>Timeline</Text>
      {events.map((e) => (
        <View
          key={e.id}
          style={{ paddingVertical: 6, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: "#e0e0e0" }}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#555" }}>{e.date ?? "Undated"}</Text>
          <Text>{e.label}</Text>
        </View>
      ))}
    </View>
  );
}

function ReactionBar({ memoryId }: { memoryId: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
      <TouchableOpacity onPress={() => apiClient.reactToMemory(memoryId, { reactionType: "touched_me" })}>
        <Text style={{ fontSize: 12, color: "#1a73e8" }}>This touched me</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => apiClient.reactToMemory(memoryId, { reactionType: "i_remember_this_too" })}>
        <Text style={{ fontSize: 12, color: "#1a73e8" }}>I remember this too</Text>
      </TouchableOpacity>
    </View>
  );
}

function MemoryCard({ memory }: { memory: Memory }) {
  const isVoice = memory.provenanceType === "voice";
  const isAi = memory.provenanceType === "ai_generated";
  return (
    <View style={{ borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 12, marginBottom: 8 }}>
      {isVoice || isAi ? (
        <View
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: isVoice ? "#0f766e" : "#6b7280",
            marginBottom: 6,
          }}
        >
          <Text style={{ fontSize: 11, color: "white" }}>{isVoice ? "Real voice" : "AI voice"}</Text>
        </View>
      ) : null}
      <Text>{memory.content}</Text>
      {memory.provenanceLabel ? (
        <Text style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{memory.provenanceLabel}</Text>
      ) : null}
      <ReactionBar memoryId={memory.id} />
    </View>
  );
}

function MemoriesFeed({ memories }: { memories: Memory[] }) {
  return (
    <View>
      <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 8 }}>Memories</Text>
      {memories.length === 0 ? (
        <Text style={{ color: "#888", fontSize: 14 }}>No memories shared yet.</Text>
      ) : (
        memories.map((m) => <MemoryCard key={m.id} memory={m} />)
      )}
    </View>
  );
}

// Text-only for now: mediaUrl/photoIds are accepted by the API
// (createMemorySchema) but nothing can populate them without R2 credentials
// being configured (apps/api's r2.service.ts is a deliberate stub) — same
// note as apps/web's AddMemoryForm. Date is a plain YYYY-MM-DD TextInput
// rather than a native date picker, matching mobile's existing
// minimal-dependency approach (no new packages for one field).
function AddMemoryForm({ personId }: { personId: string }) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        personIds: [personId],
        photoIds: [],
      });
      setContent("");
      setEventDate("");
      setIsPrivate(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["person-memories", personId] }),
        queryClient.invalidateQueries({ queryKey: ["person-timeline", personId] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this memory");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View
      style={{ borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 12, marginBottom: 16, gap: 8 }}
    >
      <TextInput
        placeholder="Share a memory…"
        value={content}
        onChangeText={setContent}
        multiline
        numberOfLines={3}
        style={{ minHeight: 60, textAlignVertical: "top" }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <TextInput
          placeholder="Date (YYYY-MM-DD, optional)"
          value={eventDate}
          onChangeText={setEventDate}
          style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 6, fontSize: 13 }}
        />
        <Text style={{ fontSize: 13 }}>Private</Text>
        <Switch value={isPrivate} onValueChange={setIsPrivate} />
      </View>
      <TouchableOpacity
        onPress={onSubmit}
        disabled={submitting}
        style={{
          alignSelf: "flex-end",
          backgroundColor: "#1a73e8",
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 6,
          opacity: submitting ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>{submitting ? "Saving…" : "Add memory"}</Text>
      </TouchableOpacity>
      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

// Relationship rows are directional and carry no names — same resolution
// logic as apps/web's ConnectionsPanel, phrased from the viewed profile's
// point of view.
const FORWARD_LABEL: Record<RelationshipType, string> = {
  parent_of: "Parent of",
  child_of: "Child of",
  spouse_of: "Spouse of",
  sibling_of: "Sibling of",
  other: "Related to",
};
const REVERSE_LABEL: Record<RelationshipType, string> = {
  parent_of: "Child of",
  child_of: "Parent of",
  spouse_of: "Spouse of",
  sibling_of: "Sibling of",
  other: "Related to",
};

function ConnectionsPanel({
  profileId,
  relationships,
  persons,
}: {
  profileId: string;
  relationships: Relationship[];
  persons: Person[];
}) {
  const personById = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons]);

  const connections = relationships
    .map((r) => {
      const isForward = r.personAId === profileId;
      const otherId = isForward ? r.personBId : r.personAId;
      const other = personById.get(otherId);
      if (!other) return null;
      const label = (isForward ? FORWARD_LABEL : REVERSE_LABEL)[r.relationshipType] ?? "Related to";
      return { id: r.id, otherId, name: other.name, label };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <View style={{ marginTop: 16 }}>
      <Text style={{ fontSize: 16, fontWeight: "600", marginBottom: 8 }}>Connections</Text>
      {connections.length === 0 ? (
        <Text style={{ color: "#888", fontSize: 14 }}>No connections yet.</Text>
      ) : (
        connections.map((c) => (
          <TouchableOpacity key={c.id} onPress={() => router.push(`/person/${c.otherId}`)} style={{ paddingVertical: 4 }}>
            <Text style={{ fontSize: 14 }}>
              <Text style={{ color: "#666", fontSize: 13 }}>{c.label} </Text>
              <Text style={{ color: "#1a73e8" }}>{c.name}</Text>
            </Text>
          </TouchableOpacity>
        ))
      )}
    </View>
  );
}

// Full profile: header, timeline, add-memory form, memories feed,
// connections, Ask/Edit links — mobile's counterpart to
// apps/web/src/routes/person/[id]/index.tsx. Relationships/names reuse the
// same ["family-tree", familyGroupId] query the tree tab uses, so this is
// usually a cache hit if you got here by tapping a person row there.
export default function PersonProfileScreen() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const { familyGroupId } = useSessionIds();

  const {
    data: person,
    isLoading: personLoading,
    isError: personError,
    refetch: refetchPerson,
  } = useQuery({
    queryKey: ["person", id],
    queryFn: () => apiClient.getPerson(id),
    enabled: Boolean(id),
  });

  const { data: tree } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });

  const { data: memories } = useQuery({
    queryKey: ["person-memories", id],
    queryFn: () => apiClient.request<{ items: Memory[] }>(`/persons/${id}/memories`),
    enabled: Boolean(id),
  });

  const { data: timeline } = useQuery({
    queryKey: ["person-timeline", id],
    queryFn: () => apiClient.request<{ items: Memory[] }>(`/persons/${id}/timeline`),
    enabled: Boolean(id),
  });

  if (personLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (personError || !person) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
        <Text>Couldn't load this profile.</Text>
        <TouchableOpacity onPress={() => refetchPerson()}>
          <Text style={{ color: "#1a73e8" }}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const timelineEvents: TimelineEvent[] = (timeline?.items ?? []).map((m) => ({
    id: m.id,
    date: m.eventDate,
    label: m.content ?? (m.mediaUrl ? "Photo memory" : "Memory"),
  }));

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <ProfileHeader person={person} />
      <LifeTimeline events={timelineEvents} />
      <AddMemoryForm personId={id} />
      <MemoriesFeed memories={memories?.items ?? []} />
      <ConnectionsPanel profileId={id} relationships={tree?.relationships ?? []} persons={tree?.persons ?? []} />
      <View style={{ flexDirection: "row", gap: 20, marginTop: 20, marginBottom: 24 }}>
        <TouchableOpacity onPress={() => router.push(`/person/${id}/ask`)}>
          <Text style={{ color: "#1a73e8" }}>Ask about {person.name}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.push(`/person/${id}/edit`)}>
          <Text style={{ color: "#1a73e8" }}>Edit profile</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}
