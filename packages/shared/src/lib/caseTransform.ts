// The API's route handlers return raw Postgres rows (see apps/api's
// persons.routes.ts, etc.) — snake_case on the wire is the real, tested
// contract (apps/api/tests assert e.g. `res.body.birth_date`), while every
// type in ../types is declared camelCase to match normal TS/JS convention.
// Rather than rewrite the API (149 passing tests assert the current shape)
// or hand-map every response, ApiClient normalizes snake_case -> camelCase
// once, here, so both web and mobile consume the camelCase shape the types
// already promise.
//
// A handful of columns are opaque, caller-defined JSON blobs rather than a
// fixed schema (`profile_data`, `raw_metadata`, `face_coordinates`, `payload`
// across the migrations) — their *key* gets camelCased like any other field,
// but we don't recurse into their *contents*, since those inner keys belong
// to whatever put them there, not to this API contract.
const OPAQUE_KEYS = new Set(["profileData", "rawMetadata", "faceCoordinates", "payload"]);

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelizeKeys<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((v) => camelizeKeys(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const camelKey = toCamel(key);
      out[camelKey] = OPAQUE_KEYS.has(camelKey) ? v : camelizeKeys(v);
    }
    return out as T;
  }
  return value as T;
}
