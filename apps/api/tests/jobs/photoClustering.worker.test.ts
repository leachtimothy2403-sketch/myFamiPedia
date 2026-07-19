import { describe, it, expect } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("photo-clustering worker", () => {
  const ctx = withDb();

  async function seedFamily() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [uploaderA] = await knex("persons").insert({ family_group_id: group.id, name: "A", status: "active" }).returning("*");
    const [uploaderB] = await knex("persons").insert({ family_group_id: group.id, name: "B", status: "active" }).returning("*");
    return { group, uploaderA, uploaderB };
  }

  // faceCount defaults to 1 — every test in this file except the dedicated
  // face-count-gate tests below is exercising the time/GPS chaining logic,
  // not the personal-content gate, so they shouldn't need to know that gate
  // exists. Explicitly pass faceCount: 0 to exercise that gate.
  async function insertPhoto(
    groupId: string,
    uploadedBy: string,
    opts: { takenAt?: string | null; location?: { lat: number; lng: number } | null; faceCount?: number } = {}
  ) {
    const knex = ctx.knex();
    const [photo] = await knex("photos")
      .insert({
        family_group_id: groupId,
        r2_key: `photos/${Math.random().toString(36).slice(2)}.jpg`,
        uploaded_by: uploadedBy,
        taken_at: opts.takenAt ?? null,
        location: opts.location ? JSON.stringify(opts.location) : null,
        face_count: opts.faceCount ?? 1,
      })
      .returning("*");
    return photo;
  }

  it("chains photos within the time window into one cluster and creates a proposal for the uploader", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    const p1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
    const p2 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString() });

    const result = await processClusterJob({ familyGroupId: group.id });

    expect(result.clustersCreated).toBe(1);
    const knex = ctx.knex();
    const members = await knex("photo_cluster_photos").where({ cluster_id: result.clusterIds[0] });
    expect(members.map((m: { photo_id: string }) => m.photo_id).sort()).toEqual([p1.id, p2.id].sort());

    const proposals = await knex("proposed_memories").where({ cluster_id: result.clusterIds[0] });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].person_id).toBe(uploaderA.id);
    expect(proposals[0].photo_id).toBeNull();
  });

  it("does not chain photos more than the time window apart", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 12 * 60 * 60 * 1000).toISOString() }); // 12h later

    const result = await processClusterJob({ familyGroupId: group.id });

    expect(result.clustersCreated).toBe(0);
    const knex = ctx.knex();
    expect(await knex("photo_clusters").where({ family_group_id: group.id })).toHaveLength(0);
  });

  it("does not chain photos within the time window but far apart in GPS distance", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    await insertPhoto(group.id, uploaderA.id, {
      takenAt: new Date(base).toISOString(),
      location: { lat: 48.8566, lng: 2.3522 }, // Paris
    });
    await insertPhoto(group.id, uploaderA.id, {
      takenAt: new Date(base + 60 * 60 * 1000).toISOString(),
      location: { lat: 51.5074, lng: -0.1278 }, // London — well over the 2km threshold
    });

    const result = await processClusterJob({ familyGroupId: group.id });
    expect(result.clustersCreated).toBe(0);
  });

  it("chains a photo with no GPS onto a chain even when its neighbor has GPS", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString(), location: { lat: 48.8566, lng: 2.3522 } });
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString(), location: null });

    const result = await processClusterJob({ familyGroupId: group.id });
    expect(result.clustersCreated).toBe(1);
  });

  it("never clusters a photo that doesn't chain with any other (singleton stays pull-path-only)", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date("2026-07-01T10:00:00.000Z").toISOString() });

    const result = await processClusterJob({ familyGroupId: group.id });
    expect(result.clustersCreated).toBe(0);
    const knex = ctx.knex();
    expect(await knex("photo_cluster_photos")).toHaveLength(0);
  });

  it("never clusters a photo with no taken_at at all", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    await insertPhoto(group.id, uploaderA.id, { takenAt: null });
    await insertPhoto(group.id, uploaderA.id, { takenAt: null });

    const result = await processClusterJob({ familyGroupId: group.id });
    expect(result.clustersCreated).toBe(0);
  });

  it("creates one proposal per distinct uploader when a cluster spans multiple contributors", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA, uploaderB } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
    await insertPhoto(group.id, uploaderB.id, { takenAt: new Date(base + 30 * 60 * 1000).toISOString() });

    const result = await processClusterJob({ familyGroupId: group.id });
    expect(result.clustersCreated).toBe(1);

    const knex = ctx.knex();
    const proposals = await knex("proposed_memories").where({ cluster_id: result.clusterIds[0] });
    expect(proposals.map((p: { person_id: string }) => p.person_id).sort()).toEqual([uploaderA.id, uploaderB.id].sort());
  });

  it("does not re-cluster photos that are already in a cluster on a subsequent run", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString() });

    const first = await processClusterJob({ familyGroupId: group.id });
    expect(first.clustersCreated).toBe(1);

    const second = await processClusterJob({ familyGroupId: group.id });
    expect(second.clustersCreated).toBe(0);
  });

  // 2026-07-19 fix — a photo could previously generate two review-queue
  // cards at once: its own classification-sourced proposal (stage 2,
  // sceneClassificationReview.worker.ts) AND a cluster-sourced proposal once
  // swept into an "outing" with its siblings, both showing the same event.
  it("excludes a photo that already has a pending individual proposal from clustering", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    const p1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString() });

    const knex = ctx.knex();
    await knex("proposed_memories").insert({ person_id: uploaderA.id, photo_id: p1.id, status: "pending" });

    const result = await processClusterJob({ familyGroupId: group.id });
    // p1 is excluded as a candidate; the remaining photo is a singleton and
    // singletons never form a cluster on their own.
    expect(result.clustersCreated).toBe(0);
  });

  it("still clusters a photo whose individual proposal was already accepted or rejected", async () => {
    const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
    const { group, uploaderA } = await seedFamily();
    const base = new Date("2026-07-01T10:00:00.000Z").getTime();
    const p1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
    await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString() });

    const knex = ctx.knex();
    await knex("proposed_memories").insert({ person_id: uploaderA.id, photo_id: p1.id, status: "rejected" });

    const result = await processClusterJob({ familyGroupId: group.id });
    expect(result.clustersCreated).toBe(1);
  });

  // 2026-07-19 fix — a real live sync surfaced clusters made entirely of
  // photographed documents/maps (nobody in any photo), since clustering
  // previously only looked at timestamp/GPS. face_count is already computed
  // for every photo independently of clustering (faceDetection.worker.ts).
  describe("face-count gate (non-personal-photo clusters)", () => {
    it("suppresses a group where nobody appears in any photo", async () => {
      const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
      const { group, uploaderA } = await seedFamily();
      const base = new Date("2026-07-01T10:00:00.000Z").getTime();
      await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString(), faceCount: 0 });
      await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString(), faceCount: 0 });

      const result = await processClusterJob({ familyGroupId: group.id });
      expect(result.clustersCreated).toBe(0);
      const knex = ctx.knex();
      expect(await knex("photo_cluster_photos")).toHaveLength(0);
    });

    it("still clusters a group where only one of several photos has a face", async () => {
      const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
      const { group, uploaderA } = await seedFamily();
      const base = new Date("2026-07-01T10:00:00.000Z").getTime();
      const p1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString(), faceCount: 0 });
      const p2 = await insertPhoto(group.id, uploaderA.id, {
        takenAt: new Date(base + 60 * 60 * 1000).toISOString(),
        faceCount: 2,
      });

      const result = await processClusterJob({ familyGroupId: group.id });
      expect(result.clustersCreated).toBe(1);
      const knex = ctx.knex();
      const members = await knex("photo_cluster_photos").where({ cluster_id: result.clusterIds[0] });
      expect(members.map((m: { photo_id: string }) => m.photo_id).sort()).toEqual([p1.id, p2.id].sort());
    });

    it("leaves a suppressed group's photos unclustered so a later run can pick them up once a face lands", async () => {
      const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
      const { group, uploaderA } = await seedFamily();
      const base = new Date("2026-07-01T10:00:00.000Z").getTime();
      const p1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString(), faceCount: 0 });
      const p2 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString(), faceCount: 0 });

      const first = await processClusterJob({ familyGroupId: group.id });
      expect(first.clustersCreated).toBe(0);

      // A face is later detected on p1 (simulating faceDetection.worker.ts
      // finishing async and re-triggering clustering).
      const knex = ctx.knex();
      await knex("photos").where({ id: p1.id }).update({ face_count: 1 });

      const second = await processClusterJob({ familyGroupId: group.id });
      expect(second.clustersCreated).toBe(1);
      const members = await knex("photo_cluster_photos").where({ cluster_id: second.clusterIds[0] });
      expect(members.map((m: { photo_id: string }) => m.photo_id).sort()).toEqual([p1.id, p2.id].sort());
    });
  });

  // 2026-07-19 fix — a real 90-photo live sync split one event across two
  // clusters: face detection landed for an early subset of the event's
  // photos before the rest had even been face-detected yet, so an early
  // clustering pass locked those few in, and the remaining photos — once
  // their own faces landed later — could only ever start a brand-new
  // cluster, never rejoin the first. These tests verify the extend-or-create
  // fix: a later pass whose chain touches an already-persisted cluster adds
  // to it instead of splitting off a second one.
  describe("extending an existing cluster", () => {
    it("adds a newly-eligible photo to an existing cluster instead of creating a second one", async () => {
      const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
      const { group, uploaderA } = await seedFamily();
      const base = new Date("2026-07-01T10:00:00.000Z").getTime();
      const p1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
      const p2 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString() });

      const first = await processClusterJob({ familyGroupId: group.id });
      expect(first.clustersCreated).toBe(1);
      const existingClusterId = first.clusterIds[0];

      // p3 arrives later (simulating a photo whose upload/face-detection
      // lagged behind p1/p2), chaining directly onto p2's timestamp.
      const p3 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 2 * 60 * 60 * 1000).toISOString() });

      const second = await processClusterJob({ familyGroupId: group.id });
      expect(second.clustersCreated).toBe(0);
      expect(second.clustersExtended).toEqual([existingClusterId]);

      const knex = ctx.knex();
      const members = await knex("photo_cluster_photos").where({ cluster_id: existingClusterId });
      expect(members.map((m: { photo_id: string }) => m.photo_id).sort()).toEqual([p1.id, p2.id, p3.id].sort());
      // Still exactly one cluster for this event, not two.
      expect(await knex("photo_clusters").where({ family_group_id: group.id })).toHaveLength(1);
    });

    it("gives a newly-joining uploader their own review card without duplicating the existing uploader's", async () => {
      const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
      const { group, uploaderA, uploaderB } = await seedFamily();
      const base = new Date("2026-07-01T10:00:00.000Z").getTime();
      await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
      await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString() });

      const first = await processClusterJob({ familyGroupId: group.id });
      const existingClusterId = first.clusterIds[0];

      await insertPhoto(group.id, uploaderB.id, { takenAt: new Date(base + 2 * 60 * 60 * 1000).toISOString() });
      await processClusterJob({ familyGroupId: group.id });

      const knex = ctx.knex();
      const proposals = await knex("proposed_memories").where({ cluster_id: existingClusterId });
      expect(proposals.map((p: { person_id: string }) => p.person_id).sort()).toEqual([uploaderA.id, uploaderB.id].sort());
    });

    it("does not re-extend or duplicate rows on a run where nothing new joins", async () => {
      const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
      const { group, uploaderA } = await seedFamily();
      const base = new Date("2026-07-01T10:00:00.000Z").getTime();
      await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() });
      await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 60 * 60 * 1000).toISOString() });

      await processClusterJob({ familyGroupId: group.id });
      const second = await processClusterJob({ familyGroupId: group.id });

      expect(second.clustersCreated).toBe(0);
      expect(second.clustersExtended).toEqual([]);
    });

    it("leaves two different pre-existing clusters alone when a chain would span both (merge case, out of scope)", async () => {
      const { processClusterJob } = await import("../../src/jobs/photoClustering.worker");
      const { group, uploaderA } = await seedFamily();
      const base = new Date("2026-07-01T10:00:00.000Z").getTime();
      const HOUR = 60 * 60 * 1000;

      // Two separate clusters, 11h apart at their nearest points — too far
      // to chain directly (TIME_WINDOW_HOURS = 6), so they form independently.
      const a1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base).toISOString() }); // 10:00
      const a2 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + HOUR).toISOString() }); // 11:00
      const b1 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 12 * HOUR).toISOString() }); // 22:00
      const b2 = await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 13 * HOUR).toISOString() }); // 23:00

      const first = await processClusterJob({ familyGroupId: group.id });
      expect(first.clustersCreated).toBe(2);

      // A bridging photo at 16:00 is exactly 5h after a2 and exactly 6h
      // before b1 — within the window of both, so it chains the two
      // previously-separate clusters into one contiguous group.
      await insertPhoto(group.id, uploaderA.id, { takenAt: new Date(base + 6 * HOUR).toISOString() });

      const second = await processClusterJob({ familyGroupId: group.id });
      expect(second.clustersCreated).toBe(0);
      expect(second.clustersExtended).toEqual([]);

      const knex = ctx.knex();
      // Both original clusters are untouched — still exactly their original members.
      expect(await knex("photo_cluster_photos").where({ cluster_id: first.clusterIds[0] })).toHaveLength(2);
      expect(await knex("photo_cluster_photos").where({ cluster_id: first.clusterIds[1] })).toHaveLength(2);
      const allPhotoIds = [a1.id, a2.id, b1.id, b2.id];
      const clusteredPhotoIds = (await knex("photo_cluster_photos").whereIn("photo_id", allPhotoIds)).map(
        (r: { photo_id: string }) => r.photo_id
      );
      expect(clusteredPhotoIds.sort()).toEqual(allPhotoIds.sort());
    });
  });
});
