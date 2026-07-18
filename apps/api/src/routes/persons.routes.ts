import { Router } from "express";
import { requireAuth, AuthedRequest, markAsAdministratorAction, requireFamilyAdministrator } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { notImplemented } from "../utils/notImplemented";
import { HttpError } from "../utils/httpError";
import { embeddingQueue } from "../jobs/queue";

export const personsRouter = Router();

// Shared by /persons/:id/timeline and /persons/:id/memories: a memory
// belongs on profileId's page if profileId is *tagged* on it via
// memory_persons — that's the actual subject. contributor_id is who typed
// it in, which is very often a different person (a parent writing on their
// kid's profile, an admin writing about a deceased relative) and must not
// be treated as "this profile's memory" on its own — that was the bug: a
// memory Tim wrote on Juliette's profile (memory_persons -> Juliette,
// contributor_id -> Tim) was also showing up on Tim's own profile because
// the old query OR'd in contributor_id unconditionally.
// The one place contributor_id still counts is a memory with NO
// memory_persons rows at all (currently only possible via
// collection.routes.ts's proposed-photo accept path, which doesn't tag a
// subject yet) — those still surface on the contributor's own profile
// rather than vanishing entirely.
function belongsToProfile(qb: import("knex").Knex.QueryBuilder, trx: import("knex").Knex, profileId: string) {
  qb.where("memory_persons.person_id", profileId).orWhere((qb2) => {
    qb2
      .where("memories.contributor_id", profileId)
      .whereNotExists(trx("memory_persons as mp_any").whereRaw("mp_any.memory_id = memories.id"));
  });
}

personsRouter.post("/persons/:id/administrator/nominate", requireAuth, notImplemented("docs/api_structure.md#auth--session"));
personsRouter.post("/persons/:id/administrator/confirm", requireAuth, notImplemented("docs/api_structure.md#auth--session"));

// GET /family-groups/:id/tree — worked example showing the withRlsContext pattern
// every other handler in this file should follow once implemented.
personsRouter.get("/family-groups/:id/tree", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const graph = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const persons = await trx("persons_tree_view").where({ family_group_id: req.params.id });
      const personIds = persons.map((p: { id: string }) => p.id);
      const relationships = await trx("relationships")
        .whereIn("person_a_id", personIds)
        .orWhereIn("person_b_id", personIds);
      return { persons, relationships };
    });
    res.json(graph);
  } catch (err) {
    next(err);
  }
});

// Family-wide "recent memories" feed for the Home tab (mobile_app_structure.md's
// "Home: memory feed (section 9)"). Was never actually built — the Home screen
// was calling GET /notifications instead and discarding every row (renderItem
// returned null), so nothing rendered regardless of what was in the family.
//
// Deliberately filters on `familyGroupId` from the auth context, not
// `req.params.id`: unlike `persons`, the `memories` table has RLS *enabled*
// (migration 010) but its only SELECT policy (`memory_privacy`) checks
// retracted/is_private, not family_group_id — there's no tenant_isolation
// equivalent for memories the way there is for persons. So an app-level
// family_group_id filter here is load-bearing, not defense-in-depth; without
// it this would leak every other family's non-private memories.
// excludeVoice=true (used by the mobile Home screen) matches
// /persons/:id/memories' convention: raw Q&A/story recordings aren't
// "specifically entered" memories, so they're left out of both feeds.
personsRouter.get("/family-groups/:id/memories", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const excludeVoice = req.query.excludeVoice === "true";

    const items = await withRlsContext({ personId, familyGroupId }, (trx) => {
      let q = trx("memories")
        .select("memories.*", "persons.name as contributor_name")
        .join("persons", "persons.id", "memories.contributor_id")
        .where("memories.family_group_id", familyGroupId);
      if (excludeVoice) {
        q = q.whereNot("memories.provenance_type", "voice");
      }
      return q.orderBy("memories.created_at", "desc").limit(pageSize).offset((page - 1) * pageSize);
    });
    res.json({ items, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// Profile: header stats, tags, timeline, connections. Reads through
// persons_tree_view (not the raw table) so the opted_out profile_data/
// ai_summary masking lives in one place — see docs/privacy_enforcement.md.
personsRouter.get("/persons/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const person = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons_tree_view").where({ id: req.params.id }).first()
    );
    if (!person) return res.status(404).json({ error: "Person not found" });
    res.json(person);
  } catch (err) {
    next(err);
  }
});

// Edit profile fields — own profile or administrator-managed deceased profile.
// RLS (`privacy_tier_self_write`) blocks anyone but the person themself from
// changing privacy_tier; this handler doesn't special-case that column, it
// relies on the same policy the DB already enforces for every write.
personsRouter.patch("/persons/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { name, birthDate, deathDate, profileData } = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (birthDate !== undefined) updates.birth_date = birthDate;
    if (deathDate !== undefined) updates.death_date = deathDate;
    if (profileData !== undefined) updates.profile_data = profileData;
    updates.updated_at = new Date();

    const [person] = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons").where({ id: req.params.id }).update(updates).returning("*")
    );
    if (!person) return res.status(404).json({ error: "Person not found" });
    res.json(person);
  } catch (err) {
    next(err);
  }
});

// AI-generated "who she was" paragraph. Generating it needs a real Claude
// call (src/services/claude.service.ts, still a stub) — this handler only
// reads the cached column and reports honestly when nothing has been
// generated yet, rather than pretending to synthesize one inline.
personsRouter.get("/persons/:id/summary", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const person = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons_tree_view").where({ id: req.params.id }).first()
    );
    if (!person) return res.status(404).json({ error: "Person not found" });
    if (!person.ai_summary) {
      return res.status(200).json({ summary: null, generated: false });
    }
    res.json({ summary: person.ai_summary, generated: true, aiGenerated: true });
  } catch (err) {
    next(err);
  }
});

// Dated events, voice-recording flags. Built from memories tagging this
// person via memory_persons (see belongsToProfile above) that carry a
// date — the profile timeline is a date-ordered projection of the same
// memories the feed below shows, not a separate table.
personsRouter.get("/persons/:id/timeline", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const events = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("memories")
        .distinct("memories.*")
        .leftJoin("memory_persons", "memory_persons.memory_id", "memories.id")
        .where((qb) => belongsToProfile(qb, trx, req.params.id))
        .whereNotNull("memories.event_date")
        .orderBy("memories.event_date", "asc")
    );
    res.json({ items: events });
  } catch (err) {
    next(err);
  }
});

// Paginated memories feed for this profile — memories tagging this person
// via memory_persons (see belongsToProfile above), i.e. memories *about*
// them, not just written by them. `?page=`/`?pageSize=` both optional,
// default 20/page.
//
// `?asContributor=true` switches to a different question entirely: not
// "what's this profile's life story" but "what has this person contributed,
// regardless of who it's about" — a strict `contributor_id = :id` match,
// memory_persons ignored. That's what collection/manage.tsx's "Your
// memories" screen needs: it lists things the caller can retract/delete,
// which is a contributor right (see docs/data_model.md's deletion policy),
// not a subject right. Using belongsToProfile there instead would hide a
// memory like "Tim wrote this on Juliette's profile" from Tim's own manage
// screen, even though Tim is the one who can retract it.
//
// `?excludeVoice=true` drops provenance_type = 'voice' rows. Both "Share a
// memory / talk about your life" and "Q & A" on mobile's Share your story
// screen record through the same interview-session -> transcribeAnswer.ts
// pipeline, which lands every recorded answer here as a 'voice'-provenance
// memory (see migration 008's interview_answers.memory_id and
// transcribeAnswer.ts). Per product direction, the person-profile Memories
// Feed (apps/mobile person/[id]/index.tsx, apps/web person/[id]/index.tsx)
// should only show memories someone specifically chose to enter (text via
// AddMemoryForm, or an accepted photo proposal) — not raw Q&A/story
// recordings — so those callers pass excludeVoice=true. collection/manage.tsx
// still needs voice memories listed (it's the only place you can retract
// one), so the default stays false rather than filtering unconditionally.
personsRouter.get("/persons/:id/memories", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const excludeVoice = req.query.excludeVoice === "true";
    const asContributor = req.query.asContributor === "true";

    const items = await withRlsContext({ personId, familyGroupId }, (trx) => {
      let q = trx("memories")
        .distinct("memories.*")
        .leftJoin("memory_persons", "memory_persons.memory_id", "memories.id")
        .where((qb) =>
          asContributor ? qb.where("memories.contributor_id", req.params.id) : belongsToProfile(qb, trx, req.params.id)
        );
      if (excludeVoice) {
        q = q.whereNot("memories.provenance_type", "voice");
      }
      return q.orderBy("memories.created_at", "desc").limit(pageSize).offset((page - 1) * pageSize);
    });
    res.json({ items, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// Ask feature needs a real embeddings + Claude call to resolve real-clip vs
// AI-synthesis vs gap-acknowledgment (docs/voice_pipeline.md) — left as a
// stub pending those credentials, see src/services/claude.service.ts.
personsRouter.post("/persons/:id/ask", requireAuth, notImplemented("docs/voice_pipeline.md#4-ask-feature-resolution-order"));

personsRouter.get("/relationships", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { personId: filterPersonId } = req.query;
    const rows = await withRlsContext({ personId, familyGroupId }, (trx) => {
      let q = trx("relationships").select("relationships.*");
      if (filterPersonId) {
        q = q.where((qb) => qb.where("person_a_id", String(filterPersonId)).orWhere("person_b_id", String(filterPersonId)));
      } else {
        // Scope to the caller's own family group even with no filter — relationships
        // has no family_group_id column of its own, so join through persons.
        q = q
          .join("persons", "persons.id", "relationships.person_a_id")
          .where("persons.family_group_id", familyGroupId);
      }
      return q;
    });
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

personsRouter.post("/relationships", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { personAId, personBId, relationshipType } = req.body ?? {};
    if (!personAId || !personBId || !relationshipType) {
      return res.status(400).json({ error: "personAId, personBId, and relationshipType are required" });
    }
    const [relationship] = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("relationships")
        .insert({ person_a_id: personAId, person_b_id: personBId, relationship_type: relationshipType })
        .onConflict(["person_a_id", "person_b_id", "relationship_type"])
        .merge()
        .returning("*")
    );
    res.status(201).json(relationship);
  } catch (err) {
    next(err);
  }
});

// Section 4 (posthumous contribution). Creating a deceased profile has no
// invitation step at all — "no one to invite" (docs/data_model.md's "Adding
// a family member — living vs. deceased branch") — so this is a straight
// persons + relationships insert, no invitations row. The creator becomes
// the profile's *own* administrator (administrator_person_id, set below) —
// separate from, and in addition to, the family-group-wide administrator
// gate on who may *start* this profile in the first place
// (docs/family_administrator_and_privacy_model.md section 1/2, "consequential
// act" principle — initiating a deceased profile is one of the three gated
// actions). requireFamilyAdministrator enforces that; there's no separate
// nomination step for the deceased person's own admin the way there is for
// a living member's (auth.routes.ts's nominate/confirm), since there's no
// one alive at that profile to confirm anything.
personsRouter.post(
  "/persons/deceased",
  requireAuth,
  requireFamilyAdministrator,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      const { name, birthDate, deathDate, relationshipType, relatedToPersonId, profileData } = req.body ?? {};
      if (!name || !deathDate || !relationshipType || !relatedToPersonId) {
        return res
          .status(400)
          .json({ error: "name, deathDate, relationshipType, and relatedToPersonId are required" });
      }

      const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
        const [person] = await trx("persons")
          .insert({
            family_group_id: familyGroupId,
            name,
            birth_date: birthDate ?? null,
            death_date: deathDate,
            status: "deceased",
            deceased_profile_state: "collecting",
            administrator_person_id: personId,
            profile_data: profileData ?? {},
          })
          .returning("*");

        await trx("relationships").insert({
          person_a_id: relatedToPersonId,
          person_b_id: person.id,
          relationship_type: relationshipType,
        });

        return person;
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// collecting <-> complete, administrator only. "Administrator" here means
// the profile's own administrator_person_id — set once, at creation, above
// — not the family-group-wide sense used elsewhere (there's no separate
// nomination flow for a deceased profile's admin).
personsRouter.patch(
  "/persons/:id/state",
  requireAuth,
  markAsAdministratorAction,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      const { state } = req.body ?? {};
      if (!["collecting", "complete"].includes(state)) {
        return res.status(400).json({ error: "state must be 'collecting' or 'complete'" });
      }

      const person = await withRlsContext(
        { personId, familyGroupId, actingAsAdministrator: true },
        async (trx) => {
          const existing = await trx("persons").where({ id: req.params.id }).first();
          if (!existing) throw new HttpError(404, "Person not found");
          if (existing.status !== "deceased") {
            throw new HttpError(409, "Only a deceased profile has a collecting/complete state");
          }
          if (existing.administrator_person_id !== personId) {
            throw new HttpError(403, "This profile's state can only be changed by its administrator");
          }
          const [updated] = await trx("persons")
            .where({ id: req.params.id })
            .update({ deceased_profile_state: state, updated_at: new Date() })
            .returning("*");
          return updated;
        }
      );
      res.json(person);
    } catch (err) {
      next(err);
    }
  }
);

// Family-group administrator — docs/family_administrator_and_privacy_model.md
// section 1. Separate from family_groups.paying_member_id (billing) and from
// persons.administrator_person_id (per-deceased-profile, unrelated to this).
// No :id param — scoped implicitly to the caller's own family_group_id via
// req.auth, same convention as /persons/:id/privacy-tier being self-only.
personsRouter.get("/family/administrator", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const admin = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons").where({ family_group_id: familyGroupId, family_role: "administrator" }).first("id", "name")
    );
    res.json({ administrator: admin ? { personId: admin.id, name: admin.name } : null });
  } catch (err) {
    next(err);
  }
});

// "Ship with exactly one administrator per family group, transferable by the
// current one" — design doc section 1. Callable only by the current
// administrator; the target must be an active member of the same family
// group (RLS tenant_isolation already confines the lookup to this family,
// but "active" is checked explicitly — transferring onto a pending/deceased/
// opted-out person would create an administrator who can't act). Clears the
// old row before setting the new one, in that order, within one transaction
// — the partial unique index (migration 023) would reject having both rows
// carry family_role = 'administrator' at once, even transiently.
personsRouter.post("/family/administrator/transfer", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { toPersonId } = req.body ?? {};
    if (!toPersonId) return res.status(400).json({ error: "toPersonId is required" });

    const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const current = await trx("persons").where({ id: personId }).first();
      if (!current || current.family_role !== "administrator") {
        throw new HttpError(403, "Only the current family administrator can transfer this role");
      }
      const target = await trx("persons").where({ id: toPersonId, family_group_id: familyGroupId }).first();
      if (!target) throw new HttpError(404, "Target person not found in this family group");
      if (target.status !== "active") {
        throw new HttpError(409, "The family administrator role can only be transferred to an active member");
      }

      await trx("persons").where({ id: personId }).update({ family_role: null, updated_at: new Date() });
      const [updated] = await trx("persons")
        .where({ id: toPersonId })
        .update({ family_role: "administrator", updated_at: new Date() })
        .returning("id", "name", "family_role");
      return updated;
    });
    res.json({ administrator: { personId: result.id, name: result.name } });
  } catch (err) {
    next(err);
  }
});

// "Any family member contributes memory/photo/story" — no admin gate here,
// unlike the state route above; the profile's administrator only curates
// the collecting/complete state, not who's allowed to contribute. Voice and
// ai_generated provenance are excluded on purpose: there's no one left to
// interview, and posthumous contributions are explicitly first-person
// family recollections, not synthesized content (docs/data_model.md's
// three-tier deletion policy also treats is_posthumous_contribution
// memories as never self-deletable/retractable, only reachable through
// moderation — matching that a real person is vouching for this content).
personsRouter.post("/persons/:id/memories", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { content, mediaUrl, eventDate, provenanceType, photoId } = req.body ?? {};
    if (!content && !mediaUrl) {
      return res.status(400).json({ error: "content or mediaUrl is required" });
    }
    const resolvedProvenance = provenanceType ?? (mediaUrl || photoId ? "photo" : "text");
    if (!["text", "photo"].includes(resolvedProvenance)) {
      return res.status(400).json({ error: "provenanceType must be 'text' or 'photo' for a posthumous contribution" });
    }

    const memory = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const subject = await trx("persons").where({ id: req.params.id }).first();
      if (!subject) throw new HttpError(404, "Person not found");
      if (subject.status !== "deceased") {
        throw new HttpError(409, "Posthumous contributions can only be made to a deceased profile");
      }

      const [created] = await trx("memories")
        .insert({
          family_group_id: familyGroupId,
          contributor_id: personId,
          content: content ?? null,
          media_url: mediaUrl ?? null,
          event_date: eventDate ?? null,
          provenance_type: resolvedProvenance,
          is_posthumous_contribution: true,
        })
        .returning("*");

      await trx("memory_persons").insert({ memory_id: created.id, person_id: subject.id });
      if (photoId) {
        await trx("memory_photos").insert({ memory_id: created.id, photo_id: photoId });
      }
      return created;
    });

    await embeddingQueue.add("embed-memory", { memoryId: memory.id });
    res.status(201).json(memory);
  } catch (err) {
    next(err);
  }
});
