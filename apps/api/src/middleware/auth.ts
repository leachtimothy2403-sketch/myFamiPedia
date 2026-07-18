import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { withRlsContext } from "../db/pool";

export interface AuthedRequest extends Request {
  auth?: {
    userId: string;
    personId: string;
    familyGroupId: string;
  };
}

// Verifies the access token and attaches req.auth. Does NOT open a DB transaction —
// that happens per-route via withRlsContext (see src/db/pool.ts) so RLS session
// vars are always set from the same values the route actually uses.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    const payload = jwt.verify(header.slice(7), env.jwtAccessSecret) as {
      userId: string;
      personId: string;
      familyGroupId: string;
    };
    req.auth = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Marks the request as an admin-scoped action — sets app.acting_as_administrator
// for the duration of the DB transaction. This flag only unlocks the DB-level
// admin affordances (see docs/privacy_enforcement.md); it is NOT itself an
// authorization check, and nothing in the codebase reads the request property
// this sets — every route using it has always had to do its own check.
//
// Kept only for PATCH /persons/:id/state (persons.routes.ts), which
// legitimately wants a *different*, narrower check than requireFamilyAdministrator
// below — that route gates on the deceased profile's own administrator_person_id,
// not the family-group-wide role, and already does that check inline. Every
// other former caller of this function turned out to have no real check
// behind it at all — see docs/family_administrator_and_privacy_model.md
// section 1 — and has been switched to requireFamilyAdministrator or
// requireSelfOrFamilyAdministrator instead, per what each route's own docs
// comment actually specified (GET/PATCH /flags and the memory
// restore-request are administrator-only; voice-model pause/revoke are
// "self or nominated administrator" per docs/api_structure.md's voice-model
// table, so those two use the "self or" variant, not a blanket admin-only gate).
export function markAsAdministratorAction(req: AuthedRequest, _res: Response, next: NextFunction) {
  (req as any)._actingAsAdministrator = true;
  next();
}

// Real authorization check for the family-group administrator role
// (docs/family_administrator_and_privacy_model.md section 1): does
// req.auth.personId hold persons.family_role = 'administrator' within their
// own family group? Queries through withRlsContext (tenant_isolation already
// scopes this to the caller's family group) rather than raw `db`, consistent
// with every other route's DB access pattern. On success, also sets the
// app.acting_as_administrator RLS flag for the route's own subsequent
// withRlsContext call — callers should still pass actingAsAdministrator: true
// themselves where they need it (this middleware runs in its own short-lived
// transaction, separate from the route handler's).
export async function requireFamilyAdministrator(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { personId, familyGroupId } = req.auth!;
    const isAdmin = await isFamilyAdministrator(personId, familyGroupId);
    if (!isAdmin) {
      return res.status(403).json({ error: "This action can only be performed by the family administrator" });
    }
    (req as any)._actingAsAdministrator = true;
    next();
  } catch (err) {
    next(err);
  }
}

export async function isFamilyAdministrator(personId: string, familyGroupId: string): Promise<boolean> {
  const person = await withRlsContext({ personId, familyGroupId }, (trx) =>
    trx("persons").where({ id: personId }).first("family_role")
  );
  return person?.family_role === "administrator";
}

// "Self or nominated administrator" (docs/api_structure.md's voice-model
// table) — the caller may act on their own record unconditionally, or on
// someone else's if they hold the family administrator role. paramName is
// the route param holding the target person id (defaults to "id", i.e.
// /persons/:id/...).
export function requireSelfOrFamilyAdministrator(paramName = "id") {
  return async function (req: AuthedRequest, res: Response, next: NextFunction) {
    try {
      const { personId, familyGroupId } = req.auth!;
      if (req.params[paramName] === personId) return next();
      const isAdmin = await isFamilyAdministrator(personId, familyGroupId);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ error: "This action can only be performed by the person themself or the family administrator" });
      }
      (req as any)._actingAsAdministrator = true;
      next();
    } catch (err) {
      next(err);
    }
  };
}
