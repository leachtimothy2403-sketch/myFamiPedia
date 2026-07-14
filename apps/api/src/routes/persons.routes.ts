import { Router } from "express";
import { requireAuth, AuthedRequest, markAsAdministratorAction } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { notImplemented } from "../utils/notImplemented";

export const personsRouter = Router();

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

// Dated events, voice-recording flags. Built from this person's memories
// (contributed by them, or featuring them via memory_persons) that carry a
// date — the profile timeline is a date-ordered projection of the same
// memories the feed below shows, not a separate table.
personsRouter.get("/persons/:id/timeline", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const events = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("memories")
        .distinct("memories.*")
        .leftJoin("memory_persons", "memory_persons.memory_id", "memories.id")
        .where((qb) => qb.where("memories.contributor_id", req.params.id).orWhere("memory_persons.person_id", req.params.id))
        .whereNotNull("memories.event_date")
        .orderBy("memories.event_date", "asc")
    );
    res.json({ items: events });
  } catch (err) {
    next(err);
  }
});

// Paginated memories feed for this profile — contributed by this person, or
// featuring them. `?page=`/`?pageSize=` both optional, default 20/page.
personsRouter.get("/persons/:id/memories", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);

    const items = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("memories")
        .distinct("memories.*")
        .leftJoin("memory_persons", "memory_persons.memory_id", "memories.id")
        .where((qb) => qb.where("memories.contributor_id", req.params.id).orWhere("memory_persons.person_id", req.params.id))
        .orderBy("memories.created_at", "desc")
        .limit(pageSize)
        .offset((page - 1) * pageSize)
    );
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

// Section 4 (posthumous contribution) is scoped out of this pass: the
// current schema's persons.status enum ('active'|'invited_pending'|
// 'declined_grace'|'opted_out'|'deceased') has no "collecting" vs "complete"
// sub-state for a deceased profile to move between, which PATCH
// /persons/:id/state depends on. Implementing these three routes needs a
// small schema decision first (a new column, or repurposing profile_data)
// rather than a route-only change — left as stubs pending that decision.
personsRouter.post("/persons/deceased", requireAuth, markAsAdministratorAction, notImplemented("docs/api_structure.md#posthumous-contribution-section-4"));
personsRouter.patch("/persons/:id/state", requireAuth, markAsAdministratorAction, notImplemented("docs/api_structure.md#posthumous-contribution-section-4"));
personsRouter.post("/persons/:id/memories", requireAuth, notImplemented("docs/api_structure.md#posthumous-contribution-section-4"));
