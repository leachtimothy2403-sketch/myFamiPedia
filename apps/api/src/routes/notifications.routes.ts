import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { db } from "../db/pool";

export const notificationsRouter = Router();

// Notifications are user-scoped (notifications.user_id), not person-scoped —
// unlike almost everything else in this API, since a login can only ever
// belong to one person anyway, but the notification pipeline (docs/
// section2_pipeline.md section 5, Q_NOTIF) naturally keys off the account,
// not the family-tree identity. No RLS on this table (see data model doc),
// so this queries `db` directly filtered to req.auth.userId rather than
// going through withRlsContext, which is person/family-scoped.
notificationsRouter.get("/notifications", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db("notifications").where({ user_id: req.auth!.userId }).orderBy("created_at", "desc");
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get("/notifications/settings", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db("notification_settings").where({ user_id: req.auth!.userId });
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

// Per-notification-type on/off. body: { notificationType, enabled }
notificationsRouter.patch("/notifications/settings", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { notificationType, enabled } = req.body ?? {};
    if (!notificationType || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "notificationType and enabled (boolean) are required" });
    }
    const [setting] = await db("notification_settings")
      .insert({ user_id: req.auth!.userId, notification_type: notificationType, enabled })
      .onConflict(["user_id", "notification_type"])
      .merge()
      .returning("*");
    res.json(setting);
  } catch (err) {
    next(err);
  }
});
