import { Router } from "express";
import { requireAuth, AuthedRequest, requireFamilyAdministrator } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { HttpError } from "../utils/httpError";
import { createPersonInvitation } from "./invitations.routes";
import { presignDownload } from "../services/r2.service";

export const photosRouter = Router();

// docs/photo_pipeline_beta_architecture.md section 4 — the design doc leaves
// this threshold explicitly open ("needs a number, not yet picked"). 8 is a
// working default so crowd-mode is testable end-to-end, not a settled
// product decision — expect this to move once there's real usage data.
const CROWD_MODE_THRESHOLD = 8;

// Best-effort presign — matches the established pattern for R2 reads
// elsewhere (scheduledJobs.worker.ts's grace-period cleanup, and
// collection.routes.ts's GET /collection/proposed, which hit exactly this
// gap first: presignDownload throws hard when R2 isn't configured, which is
// correct for a write path but takes an otherwise-fine read endpoint down
// with a 500 in any environment without R2 credentials set (e.g. the test
// suite). A photo with no resolvable URL should render as "no preview
// available" client-side, not break the request.
async function safePresignDownload(r2Key: string): Promise<string | null> {
  try {
    return await presignDownload(r2Key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`presignDownload failed for ${r2Key}:`, err);
    return null;
  }
}

// Minimal single-photo lookup — a viewable URL plus enough to drive the
// compose/tap-to-tag screen's initial render before it also calls
// GET /photos/:id/faces. Nothing else in the API returned a presigned GET
// URL for an arbitrary photo_id before this; GET /collection/proposed
// (apps/api/src/routes/collection.routes.ts) resolves its own URLs inline
// for review-queue cards specifically, but compose.tsx is reachable from
// other entry points (the pull-path add flow first, proposal-accept later)
// that don't go through that endpoint at all.
photosRouter.get("/photos/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const photo = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("photos").where({ id: req.params.id }).first()
    );
    if (!photo) throw new HttpError(404, "Photo not found");
    res.json({
      id: photo.id,
      photoUrl: await safePresignDownload(photo.r2_key),
      faceCount: photo.face_count,
      takenAt: photo.taken_at,
    });
  } catch (err) {
    next(err);
  }
});

// Tap targets for the manual tagging flow (design doc section 1/2/7) — every
// detected face on this photo, joined against any existing photo_persons tag
// so the client can distinguish "already identified" from "still open."
// crowdMode tells the client whether to suppress a proactive "who are all
// these people?" prompt (section 4) — tap targets themselves are unaffected,
// identifying someone in a crowd photo is still a pull action.
photosRouter.get("/photos/:id/faces", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const photo = await trx("photos").where({ id: req.params.id }).first();
      if (!photo) throw new HttpError(404, "Photo not found");

      const faces = await trx("photo_faces").where({ photo_id: photo.id }).orderBy("created_at", "asc");
      const tags = await trx("photo_persons as pp")
        .join("persons as p", "p.id", "pp.person_id")
        .where("pp.photo_id", photo.id)
        .whereNotNull("pp.face_id")
        .select("pp.face_id", "pp.person_id", "p.name", "pp.identification_status");
      const tagsByFace = new Map(tags.map((t: { face_id: string }) => [t.face_id, t]));

      return {
        faces: faces.map((f: { id: string; face_coordinates: unknown; confidence: number | null }) => {
          const tag = tagsByFace.get(f.id) as
            | { person_id: string; name: string; identification_status: string }
            | undefined;
          return {
            id: f.id,
            faceCoordinates: f.face_coordinates,
            confidence: f.confidence,
            tag: tag ? { personId: tag.person_id, name: tag.name, identificationStatus: tag.identification_status } : null,
          };
        }),
        faceCount: photo.face_count,
        crowdMode: photo.face_count > CROWD_MODE_THRESHOLD,
      };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// The core tap-to-tag flow (design doc section 2), three branches on the
// body, callable by ANY active family member — including tagging a face
// someone else uploaded/left unidentified (section 8, crowdsourced
// completion; the idx_photo_persons_face_unique / …_proposals_face_unique
// partial indexes are what actually enforce "add-only, not edit" here, not
// an application-layer ownership check).
//
// Known simplification: the "already claimed" check below covers
// photo_persons (confirmed tags) and person_tag_proposals (pending new-person
// proposals), but NOT a face that's already been tagged onto a still-pending
// existing person (branch B, which writes to holding_space — there's no
// indexed way to check that without a JSON containment query on
// raw_metadata). Double-tagging that specific edge case isn't prevented yet;
// flagging rather than silently accepting the gap.
photosRouter.post("/photos/:id/faces/:faceId/tag", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { personId: targetPersonId, memoryId, newPersonName, relatedToPersonId, relationshipType } = req.body ?? {};

    const isNewPersonBranch = !!newPersonName;
    if (!targetPersonId && !isNewPersonBranch) {
      return res.status(400).json({ error: "Either personId or newPersonName is required" });
    }
    if (isNewPersonBranch && (!relatedToPersonId || !relationshipType)) {
      return res
        .status(400)
        .json({ error: "relatedToPersonId and relationshipType are required when proposing a new person" });
    }

    const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const photo = await trx("photos").where({ id: req.params.id }).first();
      if (!photo) throw new HttpError(404, "Photo not found");
      const face = await trx("photo_faces").where({ id: req.params.faceId, photo_id: photo.id }).first();
      if (!face) throw new HttpError(404, "Face not found on this photo");

      const existingTag = await trx("photo_persons").where({ face_id: face.id }).first();
      if (existingTag) throw new HttpError(409, "This face has already been tagged");
      const existingProposal = await trx("person_tag_proposals")
        .where({ face_id: face.id, status: "pending" })
        .first();
      if (existingProposal) throw new HttpError(409, "This face already has a pending identification proposal");

      // Branch (c) — unrecognized face, new person: goes to the admin
      // approval queue, NOT straight to persons/invitations (design doc
      // section 2). invited_by_person_id on the eventual invitation is set
      // to proposed_by_person_id (this tagger) on approval, not the admin.
      if (isNewPersonBranch) {
        const [proposal] = await trx("person_tag_proposals")
          .insert({
            family_group_id: familyGroupId,
            proposed_name: newPersonName,
            proposed_by_person_id: personId,
            related_to_person_id: relatedToPersonId,
            relationship_type: relationshipType,
            photo_id: photo.id,
            face_id: face.id,
          })
          .returning("*");
        return { kind: "proposal" as const, proposal };
      }

      const target = await trx("persons").where({ id: targetPersonId, family_group_id: familyGroupId }).first();
      if (!target) throw new HttpError(404, "Target person not found in this family group");

      // Branch (a) — existing active person: tag directly, optionally
      // attaching to an already-in-progress memory (memoryId — set when the
      // photo arrived via an accepted proposed_memories candidate, section 9;
      // omitted for the plain pull path or for a tag-only crowdsourced
      // completion where the tagger doesn't know what/where/when, only who).
      if (target.status === "active") {
        const [tag] = await trx("photo_persons")
          .insert({
            photo_id: photo.id,
            person_id: target.id,
            face_coordinates: face.face_coordinates,
            identification_status: "confirmed",
            face_id: face.id,
            tagged_by: personId,
          })
          .returning("*");

        if (memoryId) {
          const memory = await trx("memories").where({ id: memoryId, family_group_id: familyGroupId }).first();
          if (!memory) throw new HttpError(404, "Memory not found in this family group");
          await trx("memory_persons")
            .insert({ memory_id: memoryId, person_id: target.id })
            .onConflict(["memory_id", "person_id"])
            .ignore();
          await trx("memory_photos")
            .insert({ memory_id: memoryId, photo_id: photo.id })
            .onConflict(["memory_id", "photo_id"])
            .ignore();
        }
        return { kind: "tagged" as const, tag };
      }

      // Branch (b) — existing but still-pending person: per
      // docs/media_pipeline.md section 3's still-correct rule, any data about
      // a not-yet-consented person routes to holding_space, unprocessed,
      // rather than photo_persons/memories directly. Nothing about this tag
      // is visible anywhere until they accept.
      if (target.status === "invited_pending") {
        const [holding] = await trx("holding_space")
          .insert({
            person_id: target.id,
            source_person_id: personId,
            media_type: "photo",
            r2_key: photo.r2_key,
            raw_metadata: JSON.stringify({
              photoId: photo.id,
              faceId: face.id,
              faceCoordinates: face.face_coordinates,
              memoryId: memoryId ?? null,
            }),
          })
          .returning("*");
        return { kind: "held" as const, holding };
      }

      throw new HttpError(409, `Cannot tag a photo to a person with status '${target.status}'`);
    });

    // 201 for a real tag or a holding-space write (both are "created a
    // record"), 202 for a proposal — it's accepted for processing, not yet
    // effective until an administrator reviews it.
    res.status(result.kind === "proposal" ? 202 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

// Admin approval queue (design doc section 1/2, the "consequential act"
// gate on creating a new person from an unrecognized face).
photosRouter.get(
  "/person-tag-proposals",
  requireAuth,
  requireFamilyAdministrator,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      const items = await withRlsContext({ personId, familyGroupId, actingAsAdministrator: true }, (trx) =>
        trx("person_tag_proposals")
          .where({ family_group_id: familyGroupId, status: "pending" })
          .orderBy("created_at", "asc")
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

// Approving fires the same persons + relationships + invitations write as a
// direct POST /invitations call (createPersonInvitation, shared with
// invitations.routes.ts) — invited_by_person_id is the ORIGINAL TAGGER
// (proposed_by_person_id), not this approving administrator. The original
// photo tag is then written into the newly-created person's holding_space,
// same as tagging any other still-pending person (branch (b) above) — a
// brand-new person is pending by definition.
photosRouter.post(
  "/person-tag-proposals/:id/approve",
  requireAuth,
  requireFamilyAdministrator,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      const result = await withRlsContext({ personId, familyGroupId, actingAsAdministrator: true }, async (trx) => {
        const proposal = await trx("person_tag_proposals")
          .where({ id: req.params.id, family_group_id: familyGroupId })
          .first();
        if (!proposal) throw new HttpError(404, "Proposal not found");
        if (proposal.status !== "pending") throw new HttpError(409, "This proposal has already been resolved");

        const { person, invitation } = await createPersonInvitation(trx, {
          familyGroupId,
          name: proposal.proposed_name,
          relationshipType: proposal.relationship_type,
          relatedToPersonId: proposal.related_to_person_id,
          invitedByPersonId: proposal.proposed_by_person_id,
          triggeringPhotoId: proposal.photo_id,
        });

        const face = await trx("photo_faces").where({ id: proposal.face_id }).first();
        const photo = await trx("photos").where({ id: proposal.photo_id }).first();
        await trx("holding_space").insert({
          person_id: person.id,
          source_person_id: proposal.proposed_by_person_id,
          media_type: "photo",
          r2_key: photo.r2_key,
          raw_metadata: JSON.stringify({ photoId: proposal.photo_id, faceId: proposal.face_id, faceCoordinates: face.face_coordinates }),
        });

        await trx("person_tag_proposals").where({ id: proposal.id }).update({ status: "approved" });
        return { person, invitation };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

photosRouter.post(
  "/person-tag-proposals/:id/reject",
  requireAuth,
  requireFamilyAdministrator,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      await withRlsContext({ personId, familyGroupId, actingAsAdministrator: true }, async (trx) => {
        const proposal = await trx("person_tag_proposals")
          .where({ id: req.params.id, family_group_id: familyGroupId })
          .first();
        if (!proposal) throw new HttpError(404, "Proposal not found");
        if (proposal.status !== "pending") throw new HttpError(409, "This proposal has already been resolved");
        await trx("person_tag_proposals").where({ id: proposal.id }).update({ status: "rejected" });
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
