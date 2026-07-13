import { Router } from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { db } from "../db/pool";
import { env } from "../config/env";
import { notImplemented } from "../utils/notImplemented";

export const authRouter = Router();

// POST /auth/register — creates a users row + the person's own `persons` record.
// Full implementation as a worked example; every other route in this file/API
// follows this same withRlsContext-free pattern for pre-auth endpoints
// (there's no person/family context yet at registration time).
authRouter.post("/register", async (req, res, next) => {
  try {
    const { email, password, name, familyGroupId, familyGroupName } = req.body ?? {};
    if (!email || !password || !name) {
      return res.status(400).json({ error: "email, password, and name are required" });
    }
    const passwordHash = crypto.scryptSync(password, email, 64).toString("hex");

    const result = await db.transaction(async (trx) => {
      const [user] = await trx("users").insert({ email, password_hash: passwordHash }).returning("*");

      const familyGroup = familyGroupId
        ? await trx("family_groups").where({ id: familyGroupId }).first()
        : (await trx("family_groups").insert({ name: familyGroupName ?? `${name}'s family` }).returning("*"))[0];

      const [person] = await trx("persons")
        .insert({
          family_group_id: familyGroup.id,
          user_id: user.id,
          name,
          status: "active",
          privacy_tier: 2,
        })
        .returning("*");

      return { user, person, familyGroup };
    });

    const tokens = issueTokens(result.user.id, result.person.id, result.familyGroup.id);
    res.status(201).json({ ...tokens, person: result.person });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const user = await db("users").where({ email }).first();
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const passwordHash = crypto.scryptSync(password, email, 64).toString("hex");
    if (passwordHash !== user.password_hash) return res.status(401).json({ error: "Invalid credentials" });

    const person = await db("persons").where({ user_id: user.id }).first();
    if (!person) return res.status(500).json({ error: "User has no linked person record" });

    await db("users").where({ id: user.id }).update({ last_login_at: new Date() });
    res.json(issueTokens(user.id, person.id, person.family_group_id));
  } catch (err) {
    next(err);
  }
});

// Passwordless path — recommended default for this audience, see docs/web_app_structure.md.
authRouter.post("/magic-link/request", notImplemented("docs/api_structure.md#auth--session"));
authRouter.post("/magic-link/verify", notImplemented("docs/api_structure.md#auth--session"));

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body ?? {};
  try {
    const payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as {
      userId: string;
      personId: string;
      familyGroupId: string;
    };
    res.json(issueTokens(payload.userId, payload.personId, payload.familyGroupId));
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// TODO: also revoke the session in Redis once the session store is wired up (see docs/system_architecture.mermaid).
authRouter.post("/logout", (_req, res) => res.status(204).send());

authRouter.post("/persons/:id/administrator/nominate", notImplemented("docs/api_structure.md#auth--session"));
authRouter.post("/persons/:id/administrator/confirm", notImplemented("docs/api_structure.md#auth--session"));

function issueTokens(userId: string, personId: string, familyGroupId: string) {
  const payload = { userId, personId, familyGroupId };
  const accessToken = jwt.sign(payload, env.jwtAccessSecret, { expiresIn: "15m" });
  const refreshToken = jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: "30d" });
  return { accessToken, refreshToken };
}
