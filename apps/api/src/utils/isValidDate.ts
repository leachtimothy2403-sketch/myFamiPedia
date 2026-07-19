// Shared date-format guard. First written inline in memories.routes.ts
// (POST /memories' eventDate) after a raw "July 2026" string reached
// Postgres unvalidated and surfaced as a leaked driver error via
// errorHandler.ts's fallback branch. persons.routes.ts's birthDate/deathDate
// (PATCH /persons/:id, POST /persons/deceased) had the exact same shape of
// bug — a date string taken straight from req.body into a knex insert/update
// with no format check — so this is pulled out here rather than copied a
// third time. Deliberately just YYYY-MM-DD (matches every date column here,
// all `date` type, not `timestamptz`); reject anything else rather than
// trying to parse looser formats.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}
