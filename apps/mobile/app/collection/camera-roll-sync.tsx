import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import * as MediaLibrary from "expo-media-library";
import * as SecureStore from "expo-secure-store";
import { apiClient } from "../../lib/apiClient";

// The "proactive" path (docs/media_pipeline.md, design doc section 7) — the
// counterpart to collection/add-photo.tsx's deliberate single-photo "pull"
// path. This screen exists to feed POST /collection/camera-roll/sync, which
// was built and tested in an earlier session but had no mobile-side caller:
// the detection/classification/clustering pipeline behind the review queue
// has been sitting dormant because nothing on-device ever scanned the photo
// library and called it. See docs/media_pipeline.md's 2026-07-19 update for
// the full picture, including what's deliberately NOT built here yet
// (background/automatic triggering — this is a manual "Sync now" button
// only, run in the foreground while the app is open).
//
// Cursor-based incremental sync: rather than tracking every synced asset id
// (which would grow unbounded and needs persistent storage this app doesn't
// otherwise have — no AsyncStorage dependency exists yet), this stores a
// single "newest photo creation time already synced" timestamp in
// SecureStore (same mechanism session.ts already uses for tokens) and asks
// MediaLibrary for only what's newer next time. First-ever sync on a device
// defaults to the last FIRST_SYNC_WINDOW_DAYS rather than the entire
// lifetime camera roll — a phone can easily hold 10+ years of photos, and
// uploading + Rekognition/Haiku-processing all of them in one foreground run
// on a "Sync now" tap would be slow, expensive, and a bad first impression.
// Widening that window (or adding a "scan everything" option) is a
// reasonable follow-up once this manual path is proven out.
const CURSOR_KEY = "myfamipedia.cameraRollSyncCursor";
const FIRST_SYNC_WINDOW_DAYS = 60;
const PAGE_SIZE = 50;
// Registered in batches rather than one photo at a time — matches how
// POST /collection/camera-roll/sync is designed to be called (one
// family-wide clustering pass per call, docs/photo_pipeline_beta_architecture.md
// section 6), and keeps each request/queue-enqueue burst a reasonable size.
const REGISTER_BATCH_SIZE = 15;

type SyncPhase = "idle" | "scanning" | "uploading" | "done" | "error";

interface PendingPhoto {
  r2Key: string;
  takenAt: string;
  location?: { lat: number; lng: number };
}

function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "heic" || ext === "heif") return `image/${ext}`;
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// 2026-07-19 fix — screenshots (app UI, chat threads, trading dashboards,
// etc.) were reaching the review queue as "memories." Root cause: a single
// photo's classification (sceneLabels.service.ts's curated
// CANDIDATE_LABEL_ALLOWLIST — Birthday, Wedding, Beach, and so on) would
// correctly never mark a screenshot candidate-worthy, but photoClustering.worker.ts
// deliberately never looks at classification at all — clustering is "pure
// EXIF-metadata arithmetic (timestamp + GPS), no image content ever
// touched" by design (docs/photo_pipeline_beta_architecture.md section 6),
// specifically so an otherwise-unremarkable-looking set of real photos from
// a real outing can still surface as a candidate. That's the right call for
// real photos; it just means two screenshots taken minutes apart (a common
// pattern — checking something twice, a back-and-forth conversation) sail
// straight into a cluster with nothing to stop them, since clustering has
// no concept of "this isn't a camera photo at all." Gating clustering on
// classification would undo the "boring-but-real photos still count"
// design; the more correct fix is to never sync screenshots in the first
// place, so they never reach classification OR clustering.
// iOS-only: MediaLibrary only populates mediaSubtypes there, so this is a
// best-effort filter, not a guarantee — a screenshot saved/re-shared in a
// way that strips the subtype tag would still slip through. Reject in the
// review queue remains the fallback for anything that gets past this.
function isLikelyScreenshot(asset: MediaLibrary.Asset): boolean {
  const subtypes = (asset as unknown as { mediaSubtypes?: string[] }).mediaSubtypes ?? [];
  return subtypes.some((s) => s.toLowerCase().includes("screenshot"));
}

export default function CameraRollSyncScreen() {
  const [phase, setPhase] = useState<SyncPhase>("idle");
  const [found, setFound] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 2026-07-19 — surfaced after a real sync's "1 of 1 new photo" result read
  // as broken rather than correct: nothing else on this screen showed *why*
  // a later sync would legitimately find almost nothing (the cursor already
  // covers everything up to this timestamp). null means no cursor saved yet
  // — either the device has never synced, or history was just reset below.
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    SecureStore.getItemAsync(CURSOR_KEY).then((v) => setLastSyncedAt(v ? Number(v) : null));
  }, []);

  async function resetSyncHistory() {
    Alert.alert(
      "Reset sync history?",
      "The next sync will treat every photo from the last " +
        FIRST_SYNC_WINDOW_DAYS +
        " days as new again — including ones already synced before. Nothing already in the review queue or family tree is affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            await SecureStore.deleteItemAsync(CURSOR_KEY);
            setLastSyncedAt(null);
            setPhase("idle");
          },
        },
      ]
    );
  }

  // 2026-07-19 fix — every registration call in a sync session defers
  // clustering (skipClustering: true); sync() triggers exactly one deferred
  // pass at the very end, once every chunk has landed. Registering in
  // chunks but clustering per-chunk was splitting single real events into
  // multiple disjoint clusters — see docs/media_pipeline.md.
  async function registerBatch(batch: PendingPhoto[]) {
    if (batch.length === 0) return;
    await apiClient.syncCameraRoll(batch, { skipClustering: true });
  }

  async function sync() {
    setError(null);
    setFound(0);
    setUploaded(0);
    setSkipped(0);
    setFailed(0);
    setPhase("scanning");

    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        setError("Photo library access is needed to sync your camera roll.");
        setPhase("error");
        return;
      }

      const storedCursor = await SecureStore.getItemAsync(CURSOR_KEY);
      const createdAfter = storedCursor
        ? new Date(Number(storedCursor))
        : new Date(Date.now() - FIRST_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      let pageCursor: string | undefined;
      let hasNextPage = true;
      let pendingBatch: PendingPhoto[] = [];
      let newestSeen = createdAfter.getTime();
      let sawAny = false;

      setPhase("uploading");

      while (hasNextPage) {
        const page = await MediaLibrary.getAssetsAsync({
          mediaType: MediaLibrary.MediaType.photo,
          first: PAGE_SIZE,
          after: pageCursor,
          createdAfter,
        });
        hasNextPage = page.hasNextPage;
        pageCursor = page.endCursor;

        for (const asset of page.assets) {
          sawAny = true;
          // Advance the cursor watermark for every asset the library returns,
          // screenshots included — otherwise a run of screenshots at the end
          // of createdAfter's window would keep getting re-fetched (harmless
          // but wasteful) on every future sync since they'd never advance it
          // themselves.
          newestSeen = Math.max(newestSeen, asset.creationTime);

          if (isLikelyScreenshot(asset)) {
            setSkipped((n) => n + 1);
            continue;
          }

          setFound((n) => n + 1);
          try {
            const info = await MediaLibrary.getAssetInfoAsync(asset);
            const localUri = info.localUri ?? asset.uri;
            const contentType = guessContentType(asset.filename);

            const { uploadUrl, r2Key } = await apiClient.presignUpload({ contentType, context: "photo" });
            const bytes = await fetch(localUri).then((r) => r.blob());
            const putRes = await fetch(uploadUrl, {
              method: "PUT",
              headers: { "Content-Type": contentType },
              body: bytes,
            });
            if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

            pendingBatch.push({
              r2Key,
              takenAt: new Date(asset.creationTime).toISOString(),
              location: info.location ? { lat: info.location.latitude, lng: info.location.longitude } : undefined,
            });
            setUploaded((n) => n + 1);

            if (pendingBatch.length >= REGISTER_BATCH_SIZE) {
              await registerBatch(pendingBatch);
              pendingBatch = [];
            }
          } catch {
            // One bad photo (unreadable file, presign hiccup, flaky network)
            // shouldn't stop the whole sync — skip it and keep going. It'll
            // be picked up again on the next sync since the cursor only
            // advances past photos that made it into a registered batch.
            setFailed((n) => n + 1);
          }
        }
      }

      await registerBatch(pendingBatch);

      // One clustering pass for the whole session, now that every chunk has
      // landed — not one per chunk (see registerBatch's comment above).
      // Unconditional (not gated on anyUploaded): clustering is cheap and
      // idempotent, so this also makes "Sync now" double as a manual
      // "recheck for clusters" action even with zero new photos — useful
      // after a DB-side cleanup, or once a delayed face-detection job
      // finally lands for an older photo.
      await apiClient.triggerCameraRollClustering();

      if (sawAny) {
        await SecureStore.setItemAsync(CURSOR_KEY, String(newestSeen));
        setLastSyncedAt(newestSeen);
      }
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed — try again.");
      setPhase("error");
    }
  }

  const syncing = phase === "scanning" || phase === "uploading";

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Sync camera roll</Text>
      <Text style={{ color: "#666" }}>
        Looks for new photos on your phone and adds them to the pipeline that suggests memories — nothing is added
        to the family tree automatically. Anything that looks worthwhile shows up in the review queue for you to
        accept or reject, and every face still needs a human tap to name someone.
      </Text>

      <TouchableOpacity
        onPress={sync}
        disabled={syncing}
        style={{ backgroundColor: "#1a73e8", padding: 14, borderRadius: 8, opacity: syncing ? 0.6 : 1 }}
      >
        {syncing ? (
          <ActivityIndicator color="white" />
        ) : (
          <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>Sync now</Text>
        )}
      </TouchableOpacity>

      {/* Explains why a later sync might legitimately find almost nothing —
          without this, "Synced 1 of 1" reads as broken instead of correct. */}
      {lastSyncedAt !== undefined ? (
        <Text style={{ color: "#999", fontSize: 12 }}>
          {lastSyncedAt === null
            ? "This device has never synced — the first sync covers the last " + FIRST_SYNC_WINDOW_DAYS + " days."
            : "Last synced up to " + new Date(lastSyncedAt).toLocaleString() + ". Only newer photos are checked next time."}
        </Text>
      ) : null}

      {phase === "scanning" ? <Text style={{ color: "#666" }}>Checking permissions…</Text> : null}
      {phase === "uploading" ? (
        <Text style={{ color: "#666" }}>
          Found {found} new photo{found === 1 ? "" : "s"} so far — uploaded {uploaded}
          {skipped > 0 ? `, skipped ${skipped} screenshot${skipped === 1 ? "" : "s"}` : ""}
          {failed > 0 ? `, ${failed} failed` : ""}…
        </Text>
      ) : null}
      {phase === "done" ? (
        <Text style={{ color: "#188038" }}>
          {found === 0 && skipped === 0
            ? "Nothing new since your last sync."
            : `Synced ${uploaded} of ${found} new photo${found === 1 ? "" : "s"}${
                skipped > 0 ? ` (skipped ${skipped} screenshot${skipped === 1 ? "" : "s"})` : ""
              }${
                failed > 0 ? ` (${failed} couldn't be uploaded)` : ""
              }. Check the review queue in a bit for anything that looks like a memory.`}
        </Text>
      ) : null}
      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}

      {lastSyncedAt ? (
        <TouchableOpacity onPress={resetSyncHistory} disabled={syncing} style={{ marginTop: 8 }}>
          <Text style={{ color: "#1a73e8", fontSize: 13 }}>Reset sync history</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
