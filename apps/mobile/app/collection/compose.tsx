import { useEffect, useState } from "react";
import { View, Text, Image, TextInput, TouchableOpacity, ActivityIndicator, ScrollView, Dimensions } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { RelationshipType } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

// Same options/phrasing as family-member/new.tsx's RELATION_OPTIONS —
// "New person is my ___", relationshipType stored in the anchor person's
// direction, not the raw column direction.
const RELATION_OPTIONS: { label: string; value: RelationshipType }[] = [
  { label: "child", value: "parent_of" },
  { label: "parent", value: "child_of" },
  { label: "spouse", value: "spouse_of" },
  { label: "sibling", value: "sibling_of" },
  { label: "other relative", value: "other" },
];

// Tap-to-tag + memory compose. Reached two ways, both passing ?photoId=:
//  - collection/add-photo.tsx (the "pull" path, design doc section 7): a
//    brand-new photo with no memory yet — Save creates one (POST /memories).
//  - collection/review.tsx's Accept button (a proposed_memories candidate
//    accepted): also passes &memoryId=, since accepting already created a
//    bare memory server-side (POST /collection/proposed/:id/accept) with its
//    photo(s) attached but no content. Save edits that memory instead
//    (PATCH /memories/:id) rather than creating a second one. tagFace() also
//    passes memoryId through to POST /photos/:id/faces/:faceId/tag when
//    present, so tags attach to that specific memory (memory_persons /
//    memory_photos) rather than just photo_persons — see that endpoint's
//    branch (a) doc comment.
//
// "Someone new" (design doc section 2 branch (c)) is now handled too: the
// tag endpoint's third branch — { newPersonName, relatedToPersonId,
// relationshipType }, no personId — routes to the family administrator's
// approval queue (person_tag_proposals) rather than tagging anyone directly,
// same "consequential act" principle as apps/mobile/app/family-member/new.tsx.
// A 202 here means "proposed, not yet real" — this screen just remembers
// which face got a proposal submitted (proposedFaceIds, local-only state)
// since GET /photos/:id/faces has no way to reflect a pending proposal
// (photo_persons has no row yet, and the proposal queue itself is
// admin-only to read).
interface FaceBox {
  id: string;
  faceCoordinates: { left: number; top: number; width: number; height: number };
  confidence: number | null;
  tag: { personId: string; name: string; identificationStatus: string } | null;
}

const SCREEN_WIDTH = Dimensions.get("window").width;
const PHOTO_WIDTH = SCREEN_WIDTH - 32;
const FALLBACK_DISPLAY_HEIGHT = 260;

const FACE_POLL_TIMEOUT_MS = 20000;

export default function ComposeMemoryScreen() {
  const { photoId, memoryId } = useLocalSearchParams<{ photoId: string; memoryId?: string }>();
  const isEditingExisting = Boolean(memoryId);
  const { personId, familyGroupId } = useSessionIds();
  const [mountedAt] = useState(() => Date.now());

  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [activeFaceId, setActiveFaceId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [proposingNewPerson, setProposingNewPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonRelationship, setNewPersonRelationship] = useState<RelationshipType>("parent_of");
  const [newPersonRelatedTo, setNewPersonRelatedTo] = useState<string | null>(null);
  const [proposedFaceIds, setProposedFaceIds] = useState<Set<string>>(new Set());
  const [proposing, setProposing] = useState(false);

  const { data: photo } = useQuery({
    queryKey: ["photo", photoId],
    queryFn: () => apiClient.request<{ photoUrl: string }>(`/photos/${photoId}`),
    enabled: Boolean(photoId),
  });

  const {
    data: facesData,
    refetch: refetchFaces,
  } = useQuery({
    queryKey: ["photo-faces", photoId],
    queryFn: () => apiClient.request<{ faces: FaceBox[]; crowdMode: boolean }>(`/photos/${photoId}/faces`),
    enabled: Boolean(photoId),
    // Face detection (faceDetection.worker.ts) runs async right after
    // upload — the user can reach this screen (add-photo.tsx navigates here
    // immediately once the upload completes) before the Rekognition
    // round-trip finishes. Poll every 3s until at least one face shows up,
    // rather than leaving "no faces detected yet" stuck on screen forever
    // for what's usually just a race, not a failure — capped at
    // FACE_POLL_TIMEOUT_MS so a genuinely faceless photo (or a real failure)
    // doesn't poll forever; "Check again" below covers that case manually.
    refetchInterval: (query) => {
      if ((query.state.data?.faces.length ?? 0) > 0) return false;
      if (Date.now() - mountedAt > FACE_POLL_TIMEOUT_MS) return false;
      return 3000;
    },
  });

  const { data: tree } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });

  // Face bounding boxes are fractional (0-1) relative to the photo's own
  // pixel dimensions (AWS Rekognition's convention, carried through
  // faceDetection.worker.ts unchanged) — map them onto the displayed image
  // by rendering it at exactly PHOTO_WIDTH * (naturalHeight/naturalWidth),
  // so a fractional box scales directly onto pixels with no separate
  // crop/letterbox offset to account for. Doesn't correct for EXIF
  // orientation mismatches between what Rekognition saw and what the device
  // displays — a known caveat, not handled here.
  useEffect(() => {
    if (!photo?.photoUrl) return;
    Image.getSize(
      photo.photoUrl,
      (width, height) => setImageSize({ width, height }),
      () => setImageSize(null)
    );
  }, [photo?.photoUrl]);

  const faces = facesData?.faces ?? [];
  const taggedPersonIds = Array.from(
    new Set(faces.map((f) => f.tag?.personId).filter((id): id is string => Boolean(id)))
  );
  const activeFace = faces.find((f) => f.id === activeFaceId) ?? null;
  const effectiveRelatedTo = newPersonRelatedTo ?? personId ?? "";
  // Both "active" and "invited_pending" are taggable — photos.routes.ts's
  // tag endpoint handles invited_pending as branch (b), writing to
  // holding_space (docs/media_pipeline.md section 3) rather than
  // photo_persons directly, and promotes it automatically once that person
  // accepts (holdingSpaceDrain.worker.ts). Excluding pending members here
  // was a bug, not a deliberate choice — declined_grace/opted_out/deceased
  // are correctly excluded: the tag endpoint 409s on those statuses (no
  // branch handles them), so offering them in the picker would just produce
  // an error.
  const persons = (tree?.persons ?? []).filter((p) => p.status === "active" || p.status === "invited_pending");
  const displayHeight = imageSize ? PHOTO_WIDTH * (imageSize.height / imageSize.width) : FALLBACK_DISPLAY_HEIGHT;

  function closeFacePanel() {
    setActiveFaceId(null);
    setProposingNewPerson(false);
    setNewPersonName("");
    setNewPersonRelatedTo(null);
  }

  async function tagFace(taggedPersonId: string) {
    if (!activeFace || !photoId) return;
    try {
      await apiClient.request(`/photos/${photoId}/faces/${activeFace.id}/tag`, {
        method: "POST",
        // memoryId is only set when this screen was reached via review.tsx's
        // Accept button (an already-created memory) — passing it through
        // makes photos.routes.ts's tag endpoint also attach memory_persons/
        // memory_photos to that specific memory, not just photo_persons.
        // Omitted for the plain pull-path/new-memory case, matching that
        // endpoint's own documented convention.
        body: memoryId ? { personId: taggedPersonId, memoryId } : { personId: taggedPersonId },
      });
      closeFacePanel();
      await refetchFaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't tag that face — try again.");
    }
  }

  async function proposeNewPerson() {
    if (!activeFace || !photoId) return;
    if (!newPersonName.trim()) {
      setError("Enter a name for this person.");
      return;
    }
    if (!effectiveRelatedTo) {
      setError("Pick who this new person is related to.");
      return;
    }
    setProposing(true);
    setError(null);
    try {
      await apiClient.request(`/photos/${photoId}/faces/${activeFace.id}/tag`, {
        method: "POST",
        body: {
          newPersonName: newPersonName.trim(),
          relatedToPersonId: effectiveRelatedTo,
          relationshipType: newPersonRelationship,
        },
      });
      setProposedFaceIds((prev) => new Set(prev).add(activeFace.id));
      closeFacePanel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit that proposal — try again.");
    } finally {
      setProposing(false);
    }
  }

  async function save() {
    if (!content.trim()) {
      setError("Add a few words about this memory before saving.");
      return;
    }
    const trimmedDate = eventDate.trim();
    if (trimmedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate) || Number.isNaN(Date.parse(trimmedDate)))) {
      setError('Enter the date as YYYY-MM-DD (e.g. 2026-07-16), or leave it blank.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (memoryId) {
        // Editing an already-created memory (accepted from the review
        // queue) — photos and any per-face memory_persons tags were already
        // attached at accept time / via tagFace() above, so this only needs
        // to fill in content/eventDate.
        await apiClient.request(`/memories/${memoryId}`, {
          method: "PATCH",
          body: { content, eventDate: trimmedDate || null },
        });
      } else {
        await apiClient.createMemory({
          content,
          eventDate: trimmedDate || null,
          provenanceType: "photo",
          isPrivate: false,
          photoIds: [photoId as string],
          personIds: taggedPersonIds,
        });
      }
      router.replace("/(tabs)");
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "Couldn't save this memory — try again.");
    }
  }

  if (!photo) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>{isEditingExisting ? "Finish this memory" : "Add this memory"}</Text>
      <Text style={{ color: "#666" }}>
        Tap a face to say who it is, then add a few words about what was happening.
      </Text>

      <View style={{ width: PHOTO_WIDTH, height: displayHeight }}>
        <Image
          source={{ uri: photo.photoUrl }}
          style={{ width: PHOTO_WIDTH, height: displayHeight, borderRadius: 12, backgroundColor: "#e5e5e5" }}
          resizeMode="cover"
        />
        {faces.map((face) => {
          const c = face.faceCoordinates;
          return (
            <TouchableOpacity
              key={face.id}
              onPress={() => setActiveFaceId(face.id)}
              style={{
                position: "absolute",
                left: c.left * PHOTO_WIDTH,
                top: c.top * displayHeight,
                width: c.width * PHOTO_WIDTH,
                height: c.height * displayHeight,
                borderWidth: 2,
                borderColor: face.tag ? "#188038" : proposedFaceIds.has(face.id) ? "#e8a33d" : "#1a73e8",
                borderRadius: 6,
                justifyContent: "flex-end",
              }}
            >
              {face.tag ? (
                <Text
                  style={{
                    backgroundColor: "#188038",
                    color: "white",
                    fontSize: 11,
                    paddingHorizontal: 4,
                    paddingVertical: 1,
                    alignSelf: "flex-start",
                  }}
                >
                  {face.tag.name}
                </Text>
              ) : proposedFaceIds.has(face.id) ? (
                <Text
                  style={{
                    backgroundColor: "#e8a33d",
                    color: "white",
                    fontSize: 11,
                    paddingHorizontal: 4,
                    paddingVertical: 1,
                    alignSelf: "flex-start",
                  }}
                >
                  Proposed
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      {faces.length === 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: "#666", fontSize: 13 }}>
            No faces detected yet — face detection may still be processing. You can still save this as a memory.
          </Text>
          <TouchableOpacity onPress={() => refetchFaces()}>
            <Text style={{ color: "#1a73e8", fontSize: 13 }}>Check again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {activeFace && !proposingNewPerson ? (
        <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 4 }}>
          <Text style={{ fontWeight: "600", marginBottom: 4 }}>Who is this?</Text>
          {persons.length === 0 ? (
            <Text style={{ color: "#666" }}>No one in your family tree yet.</Text>
          ) : (
            persons.map((p) => (
              <TouchableOpacity key={p.id} onPress={() => tagFace(p.id)} style={{ paddingVertical: 8 }}>
                <Text style={{ fontSize: 15 }}>
                  {p.name}
                  {p.status === "invited_pending" ? (
                    <Text style={{ color: "#888", fontSize: 13 }}> (invitation pending)</Text>
                  ) : null}
                </Text>
              </TouchableOpacity>
            ))
          )}
          <TouchableOpacity onPress={() => setProposingNewPerson(true)} style={{ paddingVertical: 8 }}>
            <Text style={{ fontSize: 15, color: "#1a73e8" }}>Someone new…</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={closeFacePanel} style={{ paddingTop: 4 }}>
            <Text style={{ color: "#1a73e8" }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {activeFace && proposingNewPerson ? (
        <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 12, gap: 8 }}>
          <Text style={{ fontWeight: "600" }}>Who is this new person?</Text>
          <Text style={{ color: "#666", fontSize: 12 }}>
            An administrator reviews this before it's added — nothing is tagged until then.
          </Text>
          <TextInput
            placeholder="Name"
            value={newPersonName}
            onChangeText={setNewPersonName}
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 6, padding: 8 }}
          />
          <Text style={{ fontSize: 12, color: "#555" }}>New person is my…</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {RELATION_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                onPress={() => setNewPersonRelationship(opt.value)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: newPersonRelationship === opt.value ? "#1a73e8" : "#ddd",
                  backgroundColor: newPersonRelationship === opt.value ? "#e8f0fe" : "white",
                }}
              >
                <Text style={{ fontSize: 13, color: newPersonRelationship === opt.value ? "#1a73e8" : "#333" }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {persons.length > 1 ? (
            <>
              <Text style={{ fontSize: 12, color: "#555" }}>relative to</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {persons.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => setNewPersonRelatedTo(p.id)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: effectiveRelatedTo === p.id ? "#1a73e8" : "#ddd",
                      backgroundColor: effectiveRelatedTo === p.id ? "#e8f0fe" : "white",
                    }}
                  >
                    <Text style={{ fontSize: 13, color: effectiveRelatedTo === p.id ? "#1a73e8" : "#333" }}>
                      {p.name}
                      {p.id === personId ? " (you)" : ""}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}
          <TouchableOpacity
            onPress={proposeNewPerson}
            disabled={proposing}
            style={{ backgroundColor: "#1a73e8", padding: 10, borderRadius: 8, opacity: proposing ? 0.6 : 1, marginTop: 4 }}
          >
            {proposing ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>Propose</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setProposingNewPerson(false)} style={{ paddingTop: 4 }}>
            <Text style={{ color: "#1a73e8" }}>Back</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <Text style={{ fontWeight: "600" }}>What's the memory?</Text>
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="What was happening in this photo?"
          multiline
          style={{
            borderWidth: 1,
            borderColor: "#ddd",
            borderRadius: 8,
            padding: 10,
            minHeight: 90,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ fontWeight: "600" }}>When (optional)</Text>
        <TextInput
          value={eventDate}
          onChangeText={setEventDate}
          placeholder="e.g. 2026-07-16"
          style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10 }}
        />
      </View>

      <TouchableOpacity
        onPress={save}
        disabled={saving}
        style={{ backgroundColor: "#1a73e8", padding: 14, borderRadius: 8, opacity: saving ? 0.6 : 1 }}
      >
        {saving ? (
          <ActivityIndicator color="white" />
        ) : (
          <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>Save memory</Text>
        )}
      </TouchableOpacity>

      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </ScrollView>
  );
}
