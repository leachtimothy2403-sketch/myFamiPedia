import { Router } from "express";
import { requireAuth, AuthedRequest, markAsAdministratorAction } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { notImplemented } from "../utils/notImplemented";

export const personsRouter = Router();

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

personsRouter.get("/persons/:id", requireAuth, notImplemented("docs/api_structure.md#family-tree-section-1"));
personsRouter.patch("/persons/:id", requireAuth, notImplemented("docs/api_structure.md#family-tree-section-1"));
personsRouter.get("/persons/:id/summary", requireAuth, notImplemented("docs/api_structure.md#family-tree-section-1"));
personsRouter.get("/persons/:id/timeline", requireAuth, notImplemented("docs/api_structure.md#family-tree-section-1"));
personsRouter.get("/persons/:id/memories", requireAuth, notImplemented("docs/api_structure.md#family-tree-section-1"));
personsRouter.post("/persons/:id/ask", requireAuth, notImplemented("docs/voice_pipeline.md#4-ask-feature-resolution-order"));

personsRouter.get("/relationships", requireAuth, notImplemented("docs/api_structure.md#family-tree-section-1"));
personsRouter.post("/relationships", requireAuth, notImplemented("docs/api_structure.md#family-tree-section-1"));

// Section 4 — posthumous contribution
personsRouter.post("/persons/deceased", requireAuth, markAsAdministratorAction, notImplemented("docs/api_structure.md#posthumous-contribution-section-4"));
personsRouter.patch("/persons/:id/state", requireAuth, markAsAdministratorAction, notImplemented("docs/api_structure.md#posthumous-contribution-section-4"));
personsRouter.post("/persons/:id/memories", requireAuth, notImplemented("docs/api_structure.md#posthumous-contribution-section-4"));
