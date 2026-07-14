import { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : "Unknown error";
  // eslint-disable-next-line no-console
  console.error(err);

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: message });
  }

  // Fallback heuristic for plain Errors that predate HttpError, or anything
  // unanticipated (a raw driver error, etc.) — new routes should throw
  // HttpError explicitly instead of relying on this.
  let status = 500;
  if (/not found/i.test(message)) status = 404;
  else if (/permission|forbidden|cannot/i.test(message)) status = 403;
  else if (/already|use retract|use restore|conflict|nothing to restore/i.test(message)) status = 409;

  res.status(status).json({ error: message });
}
