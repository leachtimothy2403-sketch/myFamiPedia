import { Request, Response } from "express";

// Stub handler for endpoints not yet built. Keeps every route in
// docs/api_structure.md represented in code from day one, even before
// the business logic exists, so the route table and the doc never drift apart.
export function notImplemented(specRef: string) {
  return (_req: Request, res: Response) => {
    res.status(501).json({ error: "Not implemented yet", spec: specRef });
  };
}
