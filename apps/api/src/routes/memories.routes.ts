import { Router } from "express";
import type { Knex } from "knex";
import { requireAuth, AuthedRequest, requireFamilyAdministrator } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { notificationQueue, embeddingQueue, memoryBiographyQueue } from "../jobs/queue";
import { HttpError } from "../utils/httpError";
import { isValidDate } from "../utils/isValidDate";
import { presignDownload } from "../services/r2.service";
import { getBiographySectionsForMemory, recomputeBiographySection } from "../services/biography.service";
import { suggestMentionedPersons } from "../services/claude.service";

// Shared by retract and restore below — both flip memories.retracted (in
// opposite directions) and then need the exact same follow-up: find every
// biography section this memory ever fed (getBiographySectionsForMemory,
// migration 028) and rebuild each one from whatever sources are live now.
// Non-fatal, same convention as every other biography-touching call site
// this week (question-prompt's answer route, memoryBiography.worker.ts) — a
// Claude hiccup here shouldn't undo the retract/restore action that already
// committed successfully.
async function recomputeBiographyForMemory(trx: Knex.Transaction | Knex, memoryId: string) {
  const sections = await getBiographySectionsForMemory(trx, memoryId);
  for (const section of sections) {
    try {
      await recomputeBiographySection(trx, section);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[memories] biography recompute failed for memory ${memoryId}, person ${section.personId}, category ${section.lifePhase}:`, err);
    }
  }
}

export const memoriesRouter = Router();

// Same best-effort presign as photos.routes.ts / collection.routes.ts —
// presignDownload throws hard when R2 isn't configured, which would take an
// otherwise-fine read endpoint down with a 500 in any environment without R2
// credentials set (e.g. the test suite).
async function safePresignDownload(r2Key: string): Promise<string | null> {
  try {
    return await presignDownload(r2Key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`presignDownload failed for ${r2Key}:`, err);
    return null;
  }
}

// 2026-07-21 — the compose screen's "suggest people" affordance (mobile's new
// quick-compose flow, see the Share-tab redesign). Text-only "who's this
// about" suggestion — see claude.service.ts's suggestMentionedPersons for why
// this reads plain text for name mentions rather than doing anything with
// photos/faces (that's a deliberately different, retired capability).
// Suggestions only, never applied server-side — the client shows them as
// tappable chips and the contributor still has to confirm each one via the
// normal personIds field on POST /memories.
//
// Degrades to an empty suggestion list rather than a hard error when Claude
// isn't configured or the call fails — this is a nice-to-have on top of a
// fully-functional manual picker, not something that should block composing
// a memory.
memoriesRouter.post("/memories/suggest-tags", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { content } = req.body ?? {};
    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }

    const roster: { id: string; name: string }[] = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons")
        .where({ family_group_id: familyGroupId })
        .whereIn("status", ["active", "invited_pending"])
        .whereNot({ id: personId })
        .select("id", "name")
    );

    try {
      const personIds = await suggestMentionedPersons(content, roster);
      res.json({ personIds });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[memories] suggest-tags failed, returning no suggestions:", err);
      res.json({ personIds: [] });
    }
  } catch (err) {
    next(err);
  }
});

// General memory creation — the living-person counterpart to
// persons.routes.ts's POST /persons/:id/memories, which is deceased-profile
// only ("posthumous contribution", Section 4). This is everything else: a
// memory about yourself or a living relative. personIds tags who it
// features (memory_persons) — the feed/timeline queries in persons.routes.ts
// match on contributor_id OR memory_persons, so tagging the profile you're
// adding this about is what makes it show up there.
//
// mediaUrl/photoIds are accepted per createMemorySchema but nothing can
// populate them yet — presigning an upload needs R2 credentials that aren't
// configured (src/services/r2.service.ts, deliberately stubbed), so this
// only ever gets exercised as a text memory for now.
memoriesRouter.post("/memories", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { content, mediaUrl, eventDate, provenanceType, isPrivate, personIds, photoIds } = req.body ?? {};
    if (!content && !mediaUrl) {
      return res.status(400).json({ error: "content or mediaUrl is required" });
    }
    const resolvedProvenance = provenanceType ?? (mediaUrl || photoIds?.length ? "photo" : "text");
    if (!["voice", "photo", "text", "ai_generated"].includes(resolvedProvenance)) {
      return res.status(400).json({ error: "invalid provenanceType" });
    }
    if (eventDate != null && !isValidDate(eventDate)) {
      return res.status(400).json({ error: "eventDate must be a valid YYYY-MM-DD date" });
    }

    const memory = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const [created] = await trx("memories")
        .insert({
          family_group_id: familyGroupId,
          contributor_id: personId,
          content: content ?? null,
          media_url: mediaUrl ?? null,
          event_date: eventDate ?? null,
          provenance_type: resolvedProvenance,
          is_private: Boolean(isPrivate),
        })
        .returning("*");

      const taggedPersonIds: string[] = Array.isArray(personIds) ? personIds : [];
      if (taggedPersonIds.length) {
        const taggedPersons = await trx("persons").whereIn("id", taggedPersonIds).select("id", "status");
        const activeIds = taggedPersons.filter((p: { status: string }) => p.status === "active").map((p: { id: string }) => p.id);
        const pendingPersons = taggedPersons.filter((p: { status: string }) => p.status === "invited_pending");

        if (activeIds.length) {
          await trx("memory_persons").insert(activeIds.map((pid: string) => ({ memory_id: created.id, person_id: pid })));
        }

        // docs/family_administrator_and_privacy_model.md section 3, "Bug
        // identified, not yet fixed": a text-tagged still-pending person used
        // to write straight to memory_persons and show live on their profile
        // immediately, despite their invitation being pending — the Juliette
        // case. Fixed here: per-tag, not per-memory (section 3's principle) —
        // a memory tagging both an active and a pending person still shows
        // normally for the active one; only the pending person's specific tag
        // is held, mirroring what photo-tagging already does via
        // holding_space (photos.routes.ts). Promoted on acceptance by
        // holdingSpaceDrain.worker.ts's media_type === 'mention' branch.
        for (const p of pendingPersons) {
          await trx("holding_space").insert({
            person_id: p.id,
            source_person_id: personId,
            media_type: "mention",
            raw_metadata: JSON.stringify({ memoryId: created.id }),
          });
        }
        // Any other status (declined_grace, opted_out, deceased, or a bad id
        // not found at all) is neither tagged nor held — same as this
        // endpoint's prior behavior of not validating tagged ids' existence.
      }
      if (Array.isArray(photoIds) && photoIds.length) {
        await trx("memory_photos").insert(
          photoIds.map((pid: string) => ({ memory_id: created.id, photo_id: pid }))
        );
      }

      return created;
    });

    await embeddingQueue.add("embed-memory", { memoryId: memory.id });
    // 2026-07-20 — folds this memory into the same running per-category
    // biography Q&A answers already build (see memoryBiography.worker.ts).
    // Only worth enqueueing when there's actual text to categorize — a
    // bare photo/mediaUrl memory with no content has nothing to classify
    // yet (PATCH /memories/:id below enqueues this same job if/when a
    // caption gets added later).
    if (memory.content) {
      await memoryBiographyQueue.add("update-biography", { memoryId: memory.id });
    }
    res.status(201).json(memory);
  } catch (err) {
    next(err);
  }
});

// Closes a gap flagged in docs/media_pipeline.md (2026-07-19 update):
// accepting a proposed_memories candidate (POST /collection/proposed/:id/accept)
// creates a bare `memories` row with no content, and there was previously no
// way to add any afterward — collection/compose.tsx's tap-to-tag flow could
// tag faces onto it (via POST /photos/:id/faces/:faceId/tag's memoryId
// param) but never actually describe what the memory *is*. Contributor-only,
// same permission shape as retract/restore/delete above. Deliberately
// narrow: content and eventDate only — not personIds/photoIds/isPrivate,
// which have their own dedicated write paths already (tap-to-tag for who's
// in a photo, memory_photos at creation time) and would need real thought
// about diffing add/remove semantics rather than a blind overwrite.
memoriesRouter.patch("/memories/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { content, eventDate } = req.body ?? {};
    if (content === undefined && eventDate === undefined) {
      return res.status(400).json({ error: "content or eventDate is required" });
    }
    if (eventDate !== undefined && eventDate !== null && !isValidDate(eventDate)) {
      return res.status(400).json({ error: "eventDate must be a valid YYYY-MM-DD date" });
    }

    const memory = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const existing = await trx("memories").where({ id: req.params.id }).first();
      if (!existing) throw new HttpError(404, "Memory not found");
      if (existing.contributor_id !== personId) {
        throw new HttpError(403, "This memory cannot be edited by anyone other than its original contributor");
      }
      // Same restriction as delete/retract above — posthumous contributions
      // only ever move through moderation, never a unilateral contributor edit.
      if (existing.is_posthumous_contribution) {
        throw new HttpError(403, "Posthumous-profile contributions cannot be self-edited — they go through moderation instead");
      }

      const updates: Record<string, unknown> = {};
      if (content !== undefined) updates.content = content;
      if (eventDate !== undefined) updates.event_date = eventDate;

      const [updated] = await trx("memories").where({ id: existing.id }).update(updates).returning("*");
      return updated;
    });

    // Only re-embed when content actually changed — an eventDate-only edit
    // doesn't touch what semantic search matches against.
    if (content !== undefined) {
      await embeddingQueue.add("embed-memory", { memoryId: memory.id });
      // Same biography hook as POST /memories above — this is specifically
      // the trigger point for a photo-sourced memory that started with no
      // content at all (collection.routes.ts's accept flow) and only gets
      // real text here, whenever a caption/description is eventually added.
      // Guarded on the post-update value, not the raw request body value —
      // an edit that clears content back to null/empty shouldn't enqueue a
      // classification call over nothing.
      if (memory.content) {
        await memoryBiographyQueue.add("update-biography", { memoryId: memory.id });
      }
    }
    res.json(memory);
  } catch (err) {
    next(err);
  }
});

// Companion to the accept-a-proposal gap noted above (2026-07-19): accepting
// a cluster-sourced proposed_memories candidate attaches EVERY photo in the
// cluster to the new memory unconditionally (photoClustering.worker.ts groups
// purely on time/GPS, so a cluster can easily catch a few photos that don't
// actually belong in the resulting memory — a stray shot mid-outing, a
// near-duplicate burst). collection/compose.tsx previously only ever
// fetched/displayed the ONE representative photo it was launched with, with
// no way to see or trim the rest. This lists all of them so the client can
// build that picker; DELETE below is the corresponding removal action.
memoriesRouter.get("/memories/:id/photos", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const items = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const memory = await trx("memories").where({ id: req.params.id }).first();
      if (!memory) throw new HttpError(404, "Memory not found");

      const photos = await trx("memory_photos as mp")
        .join("photos as p", "p.id", "mp.photo_id")
        .where("mp.memory_id", memory.id)
        .orderBy("p.taken_at", "asc")
        .select("p.id", "p.r2_key", "p.face_count", "p.taken_at");

      return Promise.all(
        photos.map(async (p: { id: string; r2_key: string; face_count: number; taken_at: Date }) => ({
          id: p.id,
          photoUrl: await safePresignDownload(p.r2_key),
          faceCount: p.face_count,
          takenAt: p.taken_at,
        }))
      );
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// Removal side of the picker above. Same permission shape as PATCH
// /memories/:id (contributor-only, posthumous contributions excluded — those
// only ever move through moderation). Refuses to drop the last photo rather
// than leaving a photo-provenance memory with nothing attached; the user can
// still delete/retract the whole memory through the existing routes if that's
// really what they want.
memoriesRouter.delete("/memories/:id/photos/:photoId", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const memory = await trx("memories").where({ id: req.params.id }).first();
      if (!memory) throw new HttpError(404, "Memory not found");
      if (memory.contributor_id !== personId) {
        throw new HttpError(403, "This memory's photos cannot be edited by anyone other than its original contributor");
      }
      if (memory.is_posthumous_contribution) {
        throw new HttpError(403, "Posthumous-profile contributions cannot be self-edited — they go through moderation instead");
      }

      const link = await trx("memory_photos").where({ memory_id: memory.id, photo_id: req.params.photoId }).first();
      if (!link) throw new HttpError(404, "This photo is not attached to this memory");

      const remainingCount = await trx("memory_photos").where({ memory_id: memory.id }).count().first();
      if (Number(remainingCount?.count ?? 0) <= 1) {
        throw new HttpError(400, "Can't remove the last photo from a memory — delete the memory instead if you don't want it");
      }

      await trx("memory_photos").where({ memory_id: memory.id, photo_id: req.params.photoId }).del();
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

memoriesRouter.post("/memories/:id/react", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { reactionType } = req.body ?? {};
    if (!reactionType) return res.status(400).json({ error: "reactionType is required" });

    await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("reactions")
        .insert({ memory_id: req.params.id, person_id: personId, reaction_type: reactionType })
        .onConflict(["memory_id", "person_id", "reaction_type"])
        .ignore()
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Worked example of the three-tier deletion policy from docs/data_model.md
// ("Memory deletion policy"). Real business logic, not a stub — this is the
// one endpoint most worth getting exactly right early, since it's where a
// bug would either destroy something meant to be permanent or block a
// legitimate self-delete.
memoriesRouter.delete("/memories/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const memory = await trx("memories").where({ id: req.params.id }).first();
      if (!memory) throw new HttpError(404, "Memory not found");
      if (memory.contributor_id !== personId) {
        throw new HttpError(403, "This memory cannot be deleted by anyone other than its original contributor");
      }
      if (memory.provenance_type === "voice") {
        throw new HttpError(403, "Voice-provenance memories cannot be hard-deleted, only retracted");
      }
      if (memory.is_posthumous_contribution) {
        throw new HttpError(403, "Posthumous-profile contributions cannot be self-deleted — they go through moderation instead");
      }
      const [reactionCount, otherPersonLinks] = await Promise.all([
        trx("reactions").where({ memory_id: memory.id }).count().first(),
        trx("memory_persons").where({ memory_id: memory.id }).whereNot({ person_id: personId }).first(),
      ]);
      if (Number(reactionCount?.count ?? 0) > 0 || otherPersonLinks) {
        throw new HttpError(409, "This memory is linked or reacted to — use retract instead of delete");
      }
      await trx("memories").where({ id: memory.id }).del(); // the DB trigger is the real backstop, this check is the friendly error path
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Soft-hides a linked/reacted (or voice, or simply preferred) memory. Contributor only.
// Notifies anyone who reacted to it — see docs/data_model.md's three-tier policy,
// tier 2. Posthumous contributions are excluded here too: those only ever move
// through the flags/moderation path (tier 3), never a unilateral contributor action.
memoriesRouter.post("/memories/:id/retract", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const memory = await trx("memories").where({ id: req.params.id }).first();
      if (!memory) throw new HttpError(404, "Memory not found");
      if (memory.contributor_id !== personId) {
        throw new HttpError(403, "This memory cannot be retracted by anyone other than its original contributor");
      }
      if (memory.is_posthumous_contribution) {
        throw new HttpError(403, "Posthumous-profile contributions cannot be self-retracted — they go through moderation instead");
      }
      if (memory.retracted) {
        throw new HttpError(409, "This memory has already been retracted");
      }

      const reactors = await trx("reactions").where({ memory_id: memory.id }).distinct("person_id");
      await trx("memories").where({ id: memory.id }).update({ retracted: true, retracted_at: new Date() });

      // 2026-07-20 — closes a reported bug: this used to leave the memory's
      // content sitting in whatever biography section(s) it had already fed
      // (interview_biography_sections), forever, with no way to walk it back
      // out. Rebuilds each affected section from its remaining, still-live
      // sources — see biography.service.ts's recomputeBiographySection.
      await recomputeBiographyForMemory(trx, memory.id);

      await Promise.all(
        reactors.map((r: { person_id: string }) =>
          notificationQueue.add("memory-retracted", {
            recipientPersonId: r.person_id,
            type: "memory_retracted",
            payload: { memoryId: memory.id },
          })
        )
      );
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Administrator-only: notifies the original contributor that a restore has
// been requested. Does NOT flip `retracted` itself — only the contributor's
// own POST /restore can do that (enforced by the route below, and backstopped
// by the memory_retraction_self_only RLS policy).
memoriesRouter.post(
  "/memories/:id/restore-request",
  requireAuth,
  requireFamilyAdministrator,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      await withRlsContext(
        { personId, familyGroupId, actingAsAdministrator: true },
        async (trx) => {
          const memory = await trx("memories").where({ id: req.params.id }).first();
          if (!memory) throw new HttpError(404, "Memory not found");
          if (!memory.retracted) throw new HttpError(409, "This memory is not retracted, so there is nothing to restore");

          await notificationQueue.add("memory-restore-requested", {
            recipientPersonId: memory.contributor_id,
            type: "memory_restore_requested",
            payload: { memoryId: memory.id, requestedBy: personId },
          });
        }
      );
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// Contributor only — reverses a retraction. Administrators cannot call this
// directly; they can only ask via restore-request above.
memoriesRouter.post("/memories/:id/restore", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const memory = await trx("memories").where({ id: req.params.id }).first();
      if (!memory) throw new HttpError(404, "Memory not found");
      if (memory.contributor_id !== personId) {
        throw new HttpError(403, "This memory cannot be restored by anyone other than its original contributor");
      }
      if (!memory.retracted) throw new HttpError(409, "This memory is not retracted, so there is nothing to restore");

      await trx("memories").where({ id: memory.id }).update({ retracted: false, retracted_at: null });

      // Symmetric with retract above — bringing the content back should bring
      // it back into the biography too, not leave it permanently excluded.
      await recomputeBiographyForMemory(trx, memory.id);
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
