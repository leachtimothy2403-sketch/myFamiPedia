import { Router } from "express";
import { requireAuth, AuthedRequest, markAsAdministratorAction } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { voiceCloningQueue } from "../jobs/queue";
import { HttpError } from "../utils/httpError";

export const voiceRouter = Router();

voiceRouter.get("/persons/:id/voice-model", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const model = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("voice_models").where({ person_id: req.params.id }).first()
    );
    res.json(model ?? { personId: req.params.id, consentStatus: "none", tier: null, audioSecondsAccumulated: 0 });
  } catch (err) {
    next(err);
  }
});

// Moment 1 — no consent asked yet, so open to whoever's running the session
// (a facilitator recording someone else), unlike consent/pause/revoke below.
// The actual 10s clip synthesis is an ElevenLabs call — queued to the (still
// stubbed) voice-cloning worker rather than called inline, per the doc's
// cost/ops note about not blocking the request on that API.
voiceRouter.post("/persons/:id/voice-model/preview", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const model = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const existing = await trx("voice_models").where({ person_id: req.params.id }).first();
      if (existing) {
        if (existing.consent_status === "none") {
          const [updated] = await trx("voice_models")
            .where({ id: existing.id })
            .update({ consent_status: "previewed", updated_at: new Date() })
            .returning("*");
          return updated;
        }
        return existing;
      }
      const [created] = await trx("voice_models")
        .insert({ person_id: req.params.id, consent_status: "previewed", tier: "instant" })
        .returning("*");
      return created;
    });
    await voiceCloningQueue.add("generate-preview", { personId: req.params.id });
    res.json(model);
  } catch (err) {
    next(err);
  }
});

// Self only — enforced here and, more importantly, at the DB layer
// (voice_consent_self_only RLS policy checks consented_by/person_id itself).
// Also blocks consenting on behalf of someone who died before consenting —
// see docs/voice_pipeline.md section 4's ask-feature gap-acknowledgment case,
// which depends on this transition being impossible after death_date is set.
// Copy convention: whatever text the client renders around this call must
// address the subject in second person ("bring your voice to life"), never
// third person by name — see the doc's "Copy convention" note.
voiceRouter.post("/persons/:id/voice-model/consent", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    if (req.params.id !== personId) {
      throw new HttpError(403, "Voice consent cannot be given by anyone other than the person themself");
    }
    const { consented } = req.body ?? {};
    if (typeof consented !== "boolean") {
      return res.status(400).json({ error: "consented (boolean) is required" });
    }

    const model = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const person = await trx("persons").where({ id: personId }).first();
      if (!person) throw new HttpError(404, "Person not found");
      if (consented && person.death_date) {
        throw new HttpError(403, "Voice consent cannot be granted for a person who has died");
      }

      const existing = await trx("voice_models").where({ person_id: personId }).first();
      const update = consented
        ? { consent_status: "consented", consent_date: new Date(), consented_by: personId, updated_at: new Date() }
        : { consent_status: "revoked", updated_at: new Date() };

      if (existing) {
        const [updated] = await trx("voice_models").where({ id: existing.id }).update(update).returning("*");
        return updated;
      }
      const [created] = await trx("voice_models")
        .insert({ person_id: personId, tier: "instant", ...update })
        .returning("*");
      return created;
    });
    res.json(model);
  } catch (err) {
    next(err);
  }
});

// Reversible — synthesis blocked, model retained. Self or nominated
// administrator, per docs/api_structure.md's voice-model table.
voiceRouter.post(
  "/persons/:id/voice-model/pause",
  requireAuth,
  markAsAdministratorAction,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      const model = await withRlsContext(
        { personId, familyGroupId, actingAsAdministrator: true },
        async (trx) => {
          const existing = await trx("voice_models").where({ person_id: req.params.id }).first();
          if (!existing) throw new HttpError(404, "No voice model exists for this person yet");
          const [updated] = await trx("voice_models")
            .where({ id: existing.id })
            .update({ consent_status: "paused", updated_at: new Date() })
            .returning("*");
          return updated;
        }
      );
      res.json(model);
    } catch (err) {
      next(err);
    }
  }
);

// Deletes the ElevenLabs model (worker-side, queued) and stops accumulation
// permanently — equivalent to "No, never" going forward. Original
// recordings in memories/interview_answers are never affected either way.
voiceRouter.post(
  "/persons/:id/voice-model/revoke",
  requireAuth,
  markAsAdministratorAction,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      const model = await withRlsContext(
        { personId, familyGroupId, actingAsAdministrator: true },
        async (trx) => {
          const existing = await trx("voice_models").where({ person_id: req.params.id }).first();
          if (!existing) throw new HttpError(404, "No voice model exists for this person yet");
          const [updated] = await trx("voice_models")
            .where({ id: existing.id })
            .update({ consent_status: "revoked", updated_at: new Date() })
            .returning("*");
          return updated;
        }
      );
      await voiceCloningQueue.add("delete-model", { personId: req.params.id });
      res.json(model);
    } catch (err) {
      next(err);
    }
  }
);
