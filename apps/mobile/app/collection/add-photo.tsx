import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Image } from "react-native";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { apiClient } from "../../lib/apiClient";

// How long to wait for face detection before giving up and letting the user
// through anyway — compose.tsx polls for faces on its own too (its own,
// shorter safety net), so timing out here just means the user sees "no faces
// detected yet" there instead of a button that never appears here.
const FACE_DETECTION_WAIT_MS = 15000;
const FACE_DETECTION_POLL_MS = 1500;

// Manual entry point into the photo pipeline (docs/photo_pipeline_beta_architecture.md,
// docs/media_pipeline.md) — picks a photo from the library and runs the same
// presign -> PUT to R2 -> complete flow camera-roll sync uses. This is the
// "pull" path (design doc section 7): the user deliberately chose this photo
// to become a memory, so /uploads/:id/complete only enqueues face detection
// and embedding — no scene classification, no clustering, no
// proposed_memories row (apps/api/src/routes/uploads.routes.ts). Once
// complete, this screen goes straight to collection/compose.tsx (tap-to-tag
// + memory text) rather than the review queue, since there's nothing there
// to review for a photo the user already decided is a memory.
type Status = "idle" | "uploading" | "done" | "error";

// EXIF's DateTimeOriginal is "YYYY:MM:DD HH:MM:SS", not ISO 8601 — taken_at
// is a timestamptz column on the server, so this only forwards the value
// when it actually parses into a real date.
function parseExifDate(exifDate: string | undefined): string | null {
  if (!exifDate) return null;
  const [datePart, timePart] = exifDate.split(" ");
  if (!datePart || !timePart) return null;
  const parsed = new Date(`${datePart.replace(/:/g, "-")}T${timePart}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export default function AddPhotoScreen() {
  const [picked, setPicked] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [detectingFaces, setDetectingFaces] = useState(false);

  // Rekognition's DetectFaces call itself is normally sub-second to a couple
  // seconds; the earlier design (navigate to compose.tsx immediately, poll
  // there) made the user watch that wait on the wrong screen. Polling here
  // instead means "Add details & tag people" only appears once face
  // detection has actually finished (or FACE_DETECTION_WAIT_MS has passed),
  // so compose.tsx opens with tap targets already in place instead of an
  // empty photo.
  useEffect(() => {
    if (!photoId) return;
    let cancelled = false;
    setDetectingFaces(true);
    const startedAt = Date.now();

    async function poll() {
      try {
        const photo = await apiClient.request<{ faceCount: number }>(`/photos/${photoId}`);
        if (cancelled) return;
        if (photo.faceCount > 0 || Date.now() - startedAt > FACE_DETECTION_WAIT_MS) {
          setDetectingFaces(false);
          return;
        }
      } catch {
        // Transient read failure — keep polling until the timeout above.
      }
      if (!cancelled) setTimeout(poll, FACE_DETECTION_POLL_MS);
    }
    poll();

    return () => {
      cancelled = true;
    };
  }, [photoId]);

  async function pick() {
    setError(null);
    setStatus("idle");
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Photo library access is needed to add a photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      exif: true,
    });
    if (result.canceled || result.assets.length === 0) return;
    setPicked(result.assets[0]);
  }

  async function upload() {
    if (!picked) return;
    setStatus("uploading");
    setError(null);
    try {
      const contentType = picked.mimeType ?? "image/jpeg";
      const { uploadId, uploadUrl } = await apiClient.presignUpload({ contentType, context: "photo" });

      const bytes = await fetch(picked.uri).then((r) => r.blob());
      // Must match the Content-Type the URL was signed with, or R2 rejects
      // the PUT with a signature mismatch (apps/api/src/services/r2.service.ts).
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
      });
      if (!putRes.ok) throw new Error(`Upload to storage failed (${putRes.status})`);

      const takenAt = parseExifDate(picked.exif?.DateTimeOriginal as string | undefined);
      const completed = await apiClient.request<{ photoId: string }>(`/uploads/${uploadId}/complete`, {
        method: "POST",
        body: takenAt ? { takenAt } : {},
      });

      setPhotoId(completed.photoId);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Upload failed — try again.");
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Add a photo</Text>
      <Text style={{ color: "#666" }}>
        Uploads a photo and detects faces so you can tag who's in it, then lets you add a few words about the
        memory.
      </Text>

      {picked ? (
        <Image source={{ uri: picked.uri }} style={{ width: "100%", height: 240, borderRadius: 8 }} resizeMode="cover" />
      ) : null}

      <TouchableOpacity
        onPress={pick}
        disabled={status === "uploading"}
        style={{ backgroundColor: "#f0f0f0", padding: 14, borderRadius: 8, opacity: status === "uploading" ? 0.6 : 1 }}
      >
        <Text style={{ fontWeight: "600", textAlign: "center" }}>{picked ? "Choose a different photo" : "Choose a photo"}</Text>
      </TouchableOpacity>

      {picked ? (
        <TouchableOpacity
          onPress={upload}
          disabled={status === "uploading"}
          style={{ backgroundColor: "#1a73e8", padding: 14, borderRadius: 8, opacity: status === "uploading" ? 0.6 : 1 }}
        >
          {status === "uploading" ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>Upload</Text>
          )}
        </TouchableOpacity>
      ) : null}

      {status === "done" && photoId ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: "#188038" }}>Uploaded.</Text>
          {detectingFaces ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator />
              <Text style={{ color: "#666" }}>Detecting faces…</Text>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => router.push(`/collection/compose?photoId=${photoId}`)}
              style={{ backgroundColor: "#1a73e8", padding: 14, borderRadius: 8 }}
            >
              <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>Add details &amp; tag people</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}

      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
