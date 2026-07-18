import { Router } from "express";
import { requireAuth, AuthedRequest, requireFamilyAdministrator } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { notificationQueue, embeddingQueue } from "../jobs/queue";
import { HttpError } from "../utils/httpError";

export const memoriesRouter = Router();

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
    res.status(201).json(memory);
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
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
