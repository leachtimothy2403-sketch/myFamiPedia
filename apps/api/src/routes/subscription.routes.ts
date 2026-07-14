import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { db } from "../db/pool";
import { HttpError } from "../utils/httpError";

export const subscriptionRouter = Router();

// family_groups has no RLS (see data model doc — it's not one of the tables
// migration 010 enables it on), so this checks familyGroupId membership at
// the app layer instead of relying on a DB-level filter.
subscriptionRouter.get("/family-groups/:id/subscription", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    if (req.params.id !== req.auth!.familyGroupId) {
      throw new HttpError(403, "This subscription cannot be viewed by anyone outside the family group");
    }
    const group = await db("family_groups").where({ id: req.params.id }).first();
    if (!group) throw new HttpError(404, "Family group not found");
    res.json({
      status: group.subscription_status,
      gracePeriodEnd: group.grace_period_end,
      coldStorageEnd: group.cold_storage_end,
      payingMemberId: group.paying_member_id,
    });
  } catch (err) {
    next(err);
  }
});

// Any member becomes the paying member, one tap — resets the group back to
// 'active' regardless of what grace/cold-storage state it was in.
subscriptionRouter.post("/family-groups/:id/subscription/takeover", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    if (req.params.id !== req.auth!.familyGroupId) {
      throw new HttpError(403, "This subscription cannot be taken over by anyone outside the family group");
    }
    const [group] = await db("family_groups")
      .where({ id: req.params.id })
      .update({
        paying_member_id: req.auth!.userId,
        subscription_status: "active",
        grace_period_end: null,
        cold_storage_end: null,
      })
      .returning("*");
    if (!group) throw new HttpError(404, "Family group not found");
    res.json({ status: group.subscription_status, payingMemberId: group.paying_member_id });
  } catch (err) {
    next(err);
  }
});
