import { Router } from "express";
import { requireAuth, AuthedRequest, markAsAdministratorAction } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { notImplemented } from "../utils/notImplemented";

export const memoriesRouter = Router();

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
      if (!memory) throw new Error("Memory not found");
      if (memory.contributor_id !== personId) {
        throw new Error("Only the original contributor can delete this memory");
      }
      if (memory.provenance_type === "voice") {
        throw new Error("Voice-provenance memories cannot be hard-deleted, only retracted");
      }
      if (memory.is_posthumous_contribution) {
        throw new Error("Posthumous-profile contributions go through moderation, not self-delete");
      }
      const [reactionCount, otherPersonLinks] = await Promise.all([
        trx("reactions").where({ memory_id: memory.id }).count().first(),
        trx("memory_persons").where({ memory_id: memory.id }).whereNot({ person_id: personId }).first(),
      ]);
      if (Number(reactionCount?.count ?? 0) > 0 || otherPersonLinks) {
        throw new Error("This memory is linked or reacted to — use retract instead of delete");
      }
      await trx("memories").where({ id: memory.id }).del(); // the DB trigger is the real backstop, this check is the friendly error path
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

memoriesRouter.post("/memories/:id/retract", requireAuth, notImplemented("docs/data_model.md#memory-deletion-policy"));
memoriesRouter.post("/memories/:id/restore-request", requireAuth, markAsAdministratorAction, notImplemented("docs/data_model.md#memory-deletion-policy"));
memoriesRouter.post("/memories/:id/restore", requireAuth, notImplemented("docs/data_model.md#memory-deletion-policy"));
