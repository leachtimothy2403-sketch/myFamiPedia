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

  async function insertPhoto(
    groupId: string,
    uploadedBy: string,
    opts: { takenAt?: string | null; location?: { lat: number; lng: number } | null } = {}
  ) {
    const knex = ctx.knex();
    const [photo] = await knex("photos")
      .insert({
        family_group_id: groupId,
        r2_key: `photos/${Math.random().toString(36).slice(2)}.jpg`,
        uploaded_by: uploadedBy,
        taken_at: opts.takenAt ?? null,
        location: opts.location ? JSON.stringify(opts.location) : null,
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
});
