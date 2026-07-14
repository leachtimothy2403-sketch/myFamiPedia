// Explicit status beats message-sniffing. errorHandler still falls back to a
// regex heuristic for anything that throws a plain Error (e.g. a driver
// error it never anticipated), but every route added from here on should
// throw HttpError with the status it actually means, not rely on wording
// like "cannot"/"not found" happening to match.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
