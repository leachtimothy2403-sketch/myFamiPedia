import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth, AuthedRequest, isFamilyAdministrator } from "../middleware/auth";
import { withRlsContext, withTokenContext } from "../db/pool";
import { holdingSpaceQueue, faceDetectionQueue } from "../jobs/queue";
import { HttpError } from "../utils/httpError";

export const invitationsRouter = Router();

const GRACE_PERIOD_DAYS = 90;

// Two entry points collapse to one handler: triggeringPhotoId set = someone
// was tagged in a photo/memory; contact info given instead = manual "add
// family member" from the tree. Either way this creates the persons row +
// (for the manual path) a relationship + the invitations row together — see
// docs/data_model.md's "Adding a family member — living vs. deceased branch".
// Neither email nor phone given -> returns a shareable link for the inviter
// to send themselves (documented MVP fallback, no contact-lookup service).
//
// Admin gate applies to the MANUAL path only (!triggeringPhotoId) — per
// docs/family_administrator_and_privacy_model.md section 2's "consequential
// act" principle, tapping "add family member" from the tree is
// administrator-only, while recognizing a face in a photo stays open to any
// family member (that's the whole point of section 2's photo-tag branch —
// an admin isn't necessarily who'll recognize a cousin's college roommate).
// This can't be a blanket route-level middleware since the same handler
// serves both paths with different gating; checked inline instead, against
// the same isFamilyAdministrator helper requireFamilyAdministrator uses.
invitationsRouter.post("/invitations", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { name, relationshipType, relatedToPersonId, inviteeEmail, inviteePhone, triggeringPhotoId } =
      req.body ?? {};
    if (!name || !relationshipType || !relatedToPersonId) {
      return res.status(400).json({ error: "name, relationshipType, and relatedToPersonId are required" });
    }

    if (!triggeringPhotoId) {
      const isAdmin = await isFamilyAdministrator(personId, familyGroupId);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ error: "Manually adding a family member can only be done by the family administrator" });
      }
    }

    const token = crypto.randomBytes(24).toString("base64url");

    const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const [person] = await trx("persons")
        .insert({ family_group_id: familyGroupId, name, status: "invited_pending" })
        .returning("*");

      await trx("relationships").insert({
        person_a_id: relatedToPersonId,
        person_b_id: person.id,
        relationship_type: relationshipType,
      });

      const [invitation] = await trx("invitations")
        .insert({
          person_id: person.id,
          invited_by_person_id: personId,
          token,
          triggering_photo_id: triggeringPhotoId ?? null,
          invitee_email: inviteeEmail ?? null,
          invitee_phone: inviteePhone ?? null,
        })
        .returning("*");

      return { person, invitation };
    });

    const needsShareableLink = !inviteeEmail && !inviteePhone;
    res.status(201).json({
      person: result.person,
      invitation: result.invitation,
      shareableLink: needsShareableLink ? `https://app.myfamipedia.com/invite/${token}` : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// Public accept/decline landing — no auth, token IS the authentication.
invitationsRouter.get("/invitations/:token", async (req, res, next) => {
  try {
    const invitation = await withTokenContext(req.params.token, (trx) =>
      trx("invitations").where({ token: req.params.token }).first()
    );
    if (!invitation) return res.status(404).json({ error: "Invitation not found" });
    const person = await withTokenContext(req.params.token, (trx) =>
      trx("persons").where({ id: invitation.person_id }).first()
    );
    res.json({ invitation, person: person ? { id: person.id, name: person.name } : null });
  } catch (err) {
    next(err);
  }
});

invitationsRouter.post("/invitations/:token/accept", async (req, res, next) => {
  try {
    const invitation = await withTokenContext(req.params.token, async (trx) => {
      const invite = await trx("invitations").where({ token: req.params.token }).first();
      if (!invite) throw new HttpError(404, "Invitation not found");
      if (invite.status === "accepted") throw new HttpError(409, "This invitation has already been accepted");

      await trx("invitations").where({ id: invite.id }).update({ status: "accepted" });
      await trx("persons").where({ id: invite.person_id }).update({ status: "active" });
      return invite;
    });

    await holdingSpaceQueue.add("drain", { personId: invitation.person_id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

invitationsRouter.post("/invitations/:token/decline", async (req, res, next) => {
  try {
    await withTokenContext(req.params.token, async (trx) => {
      const invite = await trx("invitations").where({ token: req.params.token }).first();
      if (!invite) throw new HttpError(404, "Invitation not found");
      if (invite.status !== "pending") throw new HttpError(409, "This invitation is not pending, so it cannot be declined");

      const gracePeriodEnd = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
      await trx("invitations").where({ id: invite.id }).update({ status: "declined", decline_at: new Date() });
      await trx("persons").where({ id: invite.person_id }).update({ status: "declined_grace" });
      // grace_period_end lives on invitations (queried privately by the inviter,
      // never broadcast — see docs/invitation_flow.md's Decline step 4), not on persons.
      await trx("invitations").where({ id: invite.id }).update({ grace_period_end: gracePeriodEnd });
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// One re-invite allowed, and only by the original inviter. Anchors
// grace_period_end to the ORIGINAL decline rather than resetting it — see
// docs/invitation_flow.md's flagged assumption; this is a one-line change
// if that product call ever goes the other way.
invitationsRouter.post("/invitations/:id/reinvite", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const newInvitation = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const original = await trx("invitations").where({ id: req.params.id }).first();
      if (!original) throw new HttpError(404, "Invitation not found");
      if (original.invited_by_person_id !== personId) {
        throw new HttpError(403, "This invitation cannot be re-invited by anyone other than the original inviter");
      }
      if (original.status !== "declined") throw new HttpError(409, "Only a declined invitation can be re-invited");
      if (original.reinvited) throw new HttpError(409, "This invitation has already used its one re-invite");

      const token = crypto.randomBytes(24).toString("base64url");
      const [fresh] = await trx("invitations")
        .insert({
          person_id: original.person_id,
          invited_by_person_id: original.invited_by_person_id,
          token,
          triggering_photo_id: original.triggering_photo_id,
          invitee_email: original.invitee_email,
          invitee_phone: original.invitee_phone,
          grace_period_end: original.grace_period_end,
        })
        .returning("*");
      await trx("invitations").where({ id: original.id }).update({ reinvited: true });
      return fresh;
    });
    res.status(201).json(newInvitation);
  } catch (err) {
    next(err);
  }
});

// Callable by the person themself at any state, including from 'active'.
invitationsRouter.post("/persons/:id/opt-out", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    if (req.params.id !== personId) {
      throw new HttpError(403, "This opt-out cannot be requested by anyone other than the person themself");
    }
    await withRlsContext({ personId, familyGroupId }, async (trx) => {
      await trx("persons").where({ id: personId }).update({ status: "opted_out" });
      await trx("photo_persons").where({ person_id: personId }).update({ face_blurred: true });
    });
    await faceDetectionQueue.add("remove-from-collection", { personId });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Private count ("X moments waiting") for the inviter only — the
// holding_space_owner_only RLS policy already restricts visible rows to
// source_person_id = the caller, so this is a plain count with no extra filter.
invitationsRouter.get("/persons/:id/holding-space-count", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const result = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("holding_space").where({ person_id: req.params.id }).count().first()
    );
    res.json({ count: Number(result?.count ?? 0) });
  } catch (err) {
    next(err);
  }
});
