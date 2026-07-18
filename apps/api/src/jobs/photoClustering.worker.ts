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
}

// Tuning knobs (design doc section 6, explicitly flagged there as "need real
// usage data or at least a product judgment call, not something to hardcode
// confidently here") — starting values only, expect to revisit.
const TIME_WINDOW_HOURS = 6;
const DISTANCE_THRESHOLD_KM = 2;

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
export async function processClusterJob(data: ClusterJobData) {
  const { familyGroupId } = data;

  const candidates = await withServiceContext((trx) =>
    trx("photos as p")
      .leftJoin("photo_cluster_photos as pcp", "pcp.photo_id", "p.id")
      .where("p.family_group_id", familyGroupId)
      .whereNull("pcp.photo_id")
      .whereNotNull("p.taken_at")
      .select("p.id", "p.taken_at", "p.location", "p.uploaded_by")
  );

  const groups = groupPhotos(candidates as ClusterablePhoto[]);
  const clusterIds: string[] = [];

  for (const group of groups) {
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

  return { familyGroupId, clustersCreated: clusterIds.length, clusterIds };
}

export const photoClusteringWorker = new Worker(
  "photo-clustering",
  async (job: Job<ClusterJobData>) => processClusterJob(job.data),
  { connection }
);
