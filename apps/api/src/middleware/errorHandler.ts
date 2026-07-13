import { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : "Unknown error";
  // eslint-disable-next-line no-console
  console.error(err);
  const status = /not found/i.test(message) ? 404 : /permission|forbidden|cannot/i.test(message) ? 403 : 500;
  res.status(status).json({ error: message });
}
