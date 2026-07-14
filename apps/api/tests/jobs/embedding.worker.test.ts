import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";
import type { EmbeddingService } from "../../src/services/embeddings.service";

mockQueues();

describe("embedding worker", () => {
  const ctx = withDb();

  async function seedFamily() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [person] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Someone", status: "active" })
      .returning("*");
    return { group, person };
  }

  describe("embed-memory", () => {
    it("embeds a memory's content and writes it to memories.embedding", async () => {
      const { processEmbedMemoryJob } = await import("../../src/jobs/embedding.worker");
      const { group, person } = await seedFamily();
      const [memory] = await ctx
        .knex()("memories")
        .insert({
          family_group_id: group.id,
          contributor_id: person.id,
          content: "A summer by the lake.",
          provenance_type: "text",
        })
        .returning("*");

      const vector = Array.from({ length: 1024 }, (_, i) => i / 1024);
      const embedText = vi.fn(async () => [vector]);
      const embeddings: EmbeddingService = { embedText, embedImage: vi.fn() };

      const result = await processEmbedMemoryJob({ memoryId: memory.id }, { embeddings, getBytes: vi.fn() });
      expect(result.skipped).toBe(false);
      expect(embedText).toHaveBeenCalledWith(["A summer by the lake."]);

      const refreshed = await ctx.knex().raw("SELECT embedding IS NOT NULL AS has_embedding FROM memories WHERE id = ?", [memory.id]);
      expect(refreshed.rows[0].has_embedding).toBe(true);
    });

    it("skips a memory with no content rather than erroring", async () => {
      const { processEmbedMemoryJob } = await import("../../src/jobs/embedding.worker");
      const { group, person } = await seedFamily();
      const [memory] = await ctx
        .knex()("memories")
        .insert({ family_group_id: group.id, contributor_id: person.id, provenance_type: "photo", media_url: "x" })
        .returning("*");

      const embedText = vi.fn();
      const embeddings: EmbeddingService = { embedText, embedImage: vi.fn() };
      const result = await processEmbedMemoryJob({ memoryId: memory.id }, { embeddings, getBytes: vi.fn() });
      expect(result.skipped).toBe(true);
      expect(embedText).not.toHaveBeenCalled();
    });

    it("throws a clear error for an unknown memory id", async () => {
      const { processEmbedMemoryJob } = await import("../../src/jobs/embedding.worker");
      const embeddings: EmbeddingService = { embedText: vi.fn(), embedImage: vi.fn() };
      await expect(
        processEmbedMemoryJob({ memoryId: "00000000-0000-0000-0000-000000000000" }, { embeddings, getBytes: vi.fn() })
      ).rejects.toThrow(/not found/);
    });
  });

  describe("embed-photo", () => {
    it("fetches the photo's bytes, embeds in image mode, and writes photos.embedding", async () => {
      const { processEmbedPhotoJob } = await import("../../src/jobs/embedding.worker");
      const { group, person } = await seedFamily();
      const [photo] = await ctx
        .knex()("photos")
        .insert({ family_group_id: group.id, r2_key: "photos/beach.png", uploaded_by: person.id })
        .returning("*");

      const vector = Array.from({ length: 1024 }, (_, i) => i / 1024);
      const embedImage = vi.fn(async () => [vector]);
      const getBytes = vi.fn(async () => Buffer.from("fake-image-bytes"));
      const embeddings: EmbeddingService = { embedText: vi.fn(), embedImage };

      const result = await processEmbedPhotoJob({ photoId: photo.id }, { embeddings, getBytes });
      expect(result.photoId).toBe(photo.id);
      expect(getBytes).toHaveBeenCalledWith("photos/beach.png");
      expect(embedImage).toHaveBeenCalledWith([{ bytes: expect.any(Buffer), mimeType: "image/png" }]);

      const refreshed = await ctx.knex().raw("SELECT embedding IS NOT NULL AS has_embedding FROM photos WHERE id = ?", [photo.id]);
      expect(refreshed.rows[0].has_embedding).toBe(true);
    });
  });
});
