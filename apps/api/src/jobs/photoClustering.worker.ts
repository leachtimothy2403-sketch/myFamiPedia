import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";

export interface ClusterJobData {
  familyGroupId: string;
}

interface ClusterablePhoto {
  id: string;
  taken_at: Date;
  location: { lat: number; lng: number } | null;
  uploaded_by: string;
  face_count: number;
  // null = not yet in any cluster. Present so a single grouping pass can
  // tell "this chain is entirely new" apart from "this chain already
  // includes photos from an existing cluster" — see processClusterJob.
  existing_cluster_id: string | null;
}

// Tuning knobs (design doc section 6, explicitly flagged there as "need real
// usage data or at least a product judgment call, not something to hardcode
// confidently here") — starting values only, expect to revisit.
const TIME_WINDOW_HOURS = 6;
const DISTANCE_THRESHOLD_KM = 2;
// 2026-07-20 fix — see processClusterJob's own comment on the query change
// this bounds. Deliberately much wider than TIME_WINDOW_HOURS: a real chain
// can transitively span longer than any one hop's window (a multi-day trip,
// say), and bounding too tightly here would silently reintroduce the
// split-cluster bug the "extend-or-create" rewrite below exists to prevent.
// Wide enough to comfortably cover any realistic single outing/trip on each
// side of a sync's own date range, tight enough to actually bound cost.
const CLUSTER_LOOKBACK_PAD_DAYS = 7;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Rolling-window chain over photos sorted by taken_at: a photo joins the
// current group if it's within TIME_WINDOW_HOURS of the group's most recent
// photo (chains transitively — the group's overall span can exceed the
// window as long as no single gap does) AND, only when both photos carry
// GPS, within DISTANCE_THRESHOLD_KM of the group's most recent point.
// Missing GPS never breaks a chain on location grounds — section 6: "Photos
// without EXIF location still cluster on time alone." A group of exactly
// one photo (nothing chained to it) is discarded rather than turned into a
// cluster — an "outing" implies more than one photo; a lone photo is still
// reachable via the pull path (section 6's "never clustered, just available
// via the pull path" extended to this case too, as an explicit decision).
function groupPhotos(photos: ClusterablePhoto[]): ClusterablePhoto[][] {
  const sorted = [...photos].sort((a, b) => a.taken_at.getTime() - b.taken_at.getTime());
  const groups: ClusterablePhoto[][] = [];
  let current: ClusterablePhoto[] = [];

  for (const photo of sorted) {
    const last = current[current.length - 1];
    const withinTime = last ? (photo.taken_at.getTime() - last.taken_at.getTime()) / 36e5 <= TIME_WINDOW_HOURS : true;
    const withinDistance =
      last && last.location && photo.location ? haversineKm(last.location, photo.location) <= DISTANCE_THRESHOLD_KM : true;

    if (current.length > 0 && withinTime && withinDistance) {
      current.push(photo);
    } else {
      if (current.length > 1) groups.push(current);
      current = [photo];
    }
  }
  if (current.length > 1) groups.push(current);
  return groups;
}

// Batch job (design doc section 6) — triggered after each camera-roll sync
// batch (src/routes/collection.routes.ts), once per family rather than once
// per photo, since the grouping only makes sense across the family's whole
// un-clustered backlog. Pure EXIF-metadata arithmetic (timestamp + GPS), no
// image content ever touched — the deliberate contrast with the two-stage
// classification pipeline in sceneClassification.worker.ts.
// 2026-07-19 fix — extend-or-create. Every earlier version of this job only
// ever *created* clusters from photos that weren't in one yet, which sounds
// right but has a sharp edge: face detection lands asynchronously, often
// well after photos are registered, and each detection re-triggers a
// clustering pass (faceDetection.worker.ts). If a pass ran while only *some*
// of a real event's photos had a face detected yet, it would lock those few
// into a cluster on the strength of the face-count gate below — and because
// clustering never looked at already-clustered photos again, the rest of
// that same event's photos (registered or face-detected moments later)
// could only ever form a *second, separate* cluster once their own turn
// came, silently splitting one real event into two review-queue cards. This
// isn't hypothetical — it happened on a live 90-photo sync. Same root cause,
// different trigger, as the earlier chunked-registration split fix; this
// version fixes the general case instead of just that one trigger.
//
// The fix: a grouping pass now considers ALL taken_at-chainable photos,
// already-clustered or not, together. A chain that turns out to include
// photos from exactly one existing cluster gets its new members *added* to
// that cluster instead of spawning a new one. A chain that's entirely new
// still goes through the face-count gate as before (existing clusters don't
// re-gate — they already passed it once). A chain that happens to span two
// *different* pre-existing clusters (a genuine merge case) is left alone —
// rare, and reconciling two already-surfaced review cards into one is a
// bigger decision than this job should make silently.
export async function processClusterJob(data: ClusterJobData) {
  const { familyGroupId } = data;

  // 2026-07-19 fix — excludes photos that already have their own pending
  // single-photo proposal (stage 2 classification, sceneClassificationReview.worker.ts,
  // is a completely separate path into proposed_memories from this one).
  // Before this, the same photo could generate two review-queue cards at
  // once — its own classification-sourced card AND a cluster-sourced card
  // once it got swept into an "outing" with its siblings — showing up
  // twice for the same real event. Scoped to status = 'pending' rather than
  // excluding permanently: a photo whose individual proposal was already
  // accepted or rejected shouldn't keep blocking it from ever joining a
  // cluster with unrelated later photos.
  //
  // 2026-07-20 fix — this used to be one query fetching EVERY taken_at-having,
  // non-pending-individually-proposed photo in the family, already-clustered
  // or not (media_pipeline.md section 6's "known remaining cost" callout:
  // "every clustering pass now re-fetches every taken_at-having... photo in
  // the family, not just unclustered ones, so the query grows with the
  // family's total library size over time rather than staying bounded to
  // the backlog"). Fine at beta scale, a real problem once a family's synced
  // their whole multi-year archive — this job runs after every camera-roll
  // sync batch, so that unbounded scan repeats often, not just once.
  //
  // Split into two queries instead. First, the genuinely new (unclustered)
  // candidates — naturally bounded to whatever this sync's backlog actually
  // is, regardless of how large the family's total library has grown. If
  // there's nothing new, there's nothing to (re-)cluster at all — skip the
  // second query entirely rather than paying for it on a no-op trigger
  // (e.g. face detection landing on a photo that's already fully clustered).
  const newCandidates: Omit<ClusterablePhoto, "existing_cluster_id">[] = await withServiceContext((trx) =>
    trx("photos as p")
      .leftJoin("photo_cluster_photos as pcp", "pcp.photo_id", "p.id")
      .leftJoin("proposed_memories as pm", function () {
        this.on("pm.photo_id", "=", "p.id").andOnVal("pm.status", "=", "pending");
      })
      .where("p.family_group_id", familyGroupId)
      .whereNull("pm.photo_id")
      .whereNotNull("p.taken_at")
      .whereNull("pcp.cluster_id")
      .select("p.id", "p.taken_at", "p.location", "p.uploaded_by", "p.face_count")
  );

  if (newCandidates.length === 0) {
    return { familyGroupId, clustersCreated: 0, clusterIds: [] as string[], clustersExtended: [] as string[] };
  }

  // Second, already-clustered photos too (needed for the extend-vs-create
  // logic below), but only within a padded window around the NEW candidates'
  // own taken_at range — see CLUSTER_LOOKBACK_PAD_DAYS above for why the pad
  // is wider than TIME_WINDOW_HOURS. Bounds cost to roughly this sync's date
  // range instead of the whole archive, while still correctly finding an
  // old cluster to extend when photos from an old album get synced/uploaded
  // together (their own taken_at range drives the window, not wall-clock
  // "now" — a decades-old batch still windows correctly around itself).
  const takenAtMs = newCandidates.map((p) => p.taken_at.getTime());
  const padMs = CLUSTER_LOOKBACK_PAD_DAYS * 24 * 60 * 60 * 1000;
  const windowStart = new Date(Math.min(...takenAtMs) - padMs);
  const windowEnd = new Date(Math.max(...takenAtMs) + padMs);

  const existingClusteredNearby = await withServiceContext((trx) =>
    trx("photos as p")
      .join("photo_cluster_photos as pcp", "pcp.photo_id", "p.id")
      .leftJoin("proposed_memories as pm", function () {
        this.on("pm.photo_id", "=", "p.id").andOnVal("pm.status", "=", "pending");
      })
      .where("p.family_group_id", familyGroupId)
      .whereNull("pm.photo_id")
      .whereBetween("p.taken_at", [windowStart, windowEnd])
      .select("p.id", "p.taken_at", "p.location", "p.uploaded_by", "p.face_count", "pcp.cluster_id as existing_cluster_id")
  );

  const candidates: ClusterablePhoto[] = [
    ...newCandidates.map((p) => ({ ...p, existing_cluster_id: null })),
    ...existingClusteredNearby,
  ];

  const groups = groupPhotos(candidates);
  const clusterIds: string[] = [];
  const extendedClusterIds: string[] = [];

  for (const group of groups) {
    const newMembers = group.filter((p) => !p.existing_cluster_id);
    if (newMembers.length === 0) continue; // fully already persisted (or an unresolved multi-cluster span) — nothing to do

    const existingClusterIds = [...new Set(group.map((p) => p.existing_cluster_id).filter((id): id is string => id !== null))];

    if (existingClusterIds.length > 1) continue; // spans two different pre-existing clusters — a merge decision, not this job's call

    if (existingClusterIds.length === 1) {
      // Extend: these new photos chain directly onto an already-surfaced
      // cluster. It already passed the face-count gate when first created —
      // adding more of the same event's photos doesn't need to re-earn that.
      const clusterId = existingClusterIds[0];
      await withServiceContext(async (trx) => {
        await trx("photo_cluster_photos").insert(newMembers.map((p) => ({ cluster_id: clusterId, photo_id: p.id })));

        // A newly-joining photo might belong to an uploader who wasn't part
        // of the cluster before — give them a review card for it too,
        // same "one proposal per distinct uploader" rule as cluster
        // creation below, but only for uploaders who don't already have one
        // for this specific cluster.
        const existingProposalUploaders = new Set(
          (await trx("proposed_memories").where({ cluster_id: clusterId }).select("person_id")).map(
            (r: { person_id: string }) => r.person_id
          )
        );
        const newUploaderIds = [...new Set(newMembers.map((p) => p.uploaded_by))].filter(
          (id) => !existingProposalUploaders.has(id)
        );
        if (newUploaderIds.length > 0) {
          await trx("proposed_memories").insert(newUploaderIds.map((personId) => ({ person_id: personId, cluster_id: clusterId })));
        }
      });
      extendedClusterIds.push(clusterId);
      continue;
    }

    // 2026-07-19 fix — a group of photographed documents/maps/receipts
    // (nobody in any of them) was clustering exactly like a real outing,
    // since clustering only ever looked at timestamp/GPS. face_count is
    // already computed for every photo independently (faceDetection.worker.ts),
    // at no extra cost — requiring at least one member of the group to have
    // a detected face is a much sharper "is this a personal photo at all"
    // signal than trying to curate a label blocklist. Explicit tradeoff
    // accepted: a genuine outing where literally nobody appears in any photo
    // (pure scenery, an empty table setting) won't surface via clustering
    // either. Skipping rather than discarding — these photos stay
    // unclustered and get reconsidered the next time clustering runs, e.g.
    // once face detection lands for one of them (see the re-trigger in
    // faceDetection.worker.ts) or a later photo joins the chain.
    if (!group.some((p) => p.face_count > 0)) continue;

    const representativeTakenAt = group[Math.floor(group.length / 2)].taken_at;
    const withLocation = group.filter((p) => p.location);
    const centroid =
      withLocation.length > 0
        ? {
            lat: withLocation.reduce((sum, p) => sum + p.location!.lat, 0) / withLocation.length,
            lng: withLocation.reduce((sum, p) => sum + p.location!.lng, 0) / withLocation.length,
          }
        : null;

    await withServiceContext(async (trx) => {
      const [cluster] = await trx("photo_clusters")
        .insert({
          family_group_id: familyGroupId,
          representative_taken_at: representativeTakenAt,
          location: centroid ? JSON.stringify(centroid) : null,
        })
        .returning("id");

      await trx("photo_cluster_photos").insert(group.map((p) => ({ cluster_id: cluster.id, photo_id: p.id })));

      // One proposed_memories row per distinct uploader among the cluster's
      // photos, not one per cluster. proposed_memories.person_id means "the
      // person reviewing a candidate from their own camera roll" (section
      // 9), and a family-wide cluster can span multiple contributors'
      // photos — each of them gets their own review card for the same
      // cluster rather than one arbitrary "winner" being notified while the
      // others' contributed photos silently ride along.
      const uploaderIds = [...new Set(group.map((p) => p.uploaded_by))];
      await trx("proposed_memories").insert(uploaderIds.map((personId) => ({ person_id: personId, cluster_id: cluster.id })));

      clusterIds.push(cluster.id);
    });
  }

  return { familyGroupId, clustersCreated: clusterIds.length, clusterIds, clustersExtended: extendedClusterIds };
}

export const photoClusteringWorker = new Worker(
  "photo-clustering",
  async (job: Job<ClusterJobData>) => processClusterJob(job.data),
  { connection }
);
