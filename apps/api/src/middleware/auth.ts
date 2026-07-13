import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

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
// for the duration of the DB transaction. Route handlers still must check the
// caller actually holds the administrator role for the target person/family;
// this flag only unlocks the DB-level admin affordances (see docs/privacy_enforcement.md),
// it is not itself an authorization check.
export function markAsAdministratorAction(req: AuthedRequest, _res: Response, next: NextFunction) {
  (req as any)._actingAsAdministrator = true;
  next();
}
