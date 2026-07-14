import pg from "pg";
import knexFactory from "knex";
import knexConfig from "./knexfile";

// node-postgres parses DATE columns (OID 1082) into JS Date objects at local
// midnight by default. That's a real bug for this schema specifically:
// birth_date/death_date/event_date have no time-of-day or timezone meaning,
// so serializing that Date back out (e.g. via res.json) shifts the calendar
// day whenever the server's TZ isn't UTC — a birth date silently moving by a
// day is exactly the kind of error genealogical data can't tolerate. Returning
// the raw "YYYY-MM-DD" string sidesteps the ambiguity entirely; callers that
// want a Date can parse it themselves knowing there's no time component to lose.
pg.types.setTypeParser(1082, (value: string) => value);

// Single shared Knex instance for the whole API process.
export const db = knexFactory(knexConfig);

// Sets the RLS session variables for the current request's transaction.
// Every route handler that touches the DB should run its queries through
// withRlsContext rather than using `db` directly, or RLS silently falls
// back to "no rows visible" (current_setting returns null).
export async function withRlsContext<T>(
  ctx: { personId: string | null; familyGroupId: string | null; actingAsAdministrator?: boolean },
  fn: (trx: knexFactory.Knex.Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (trx) => {
    if (ctx.personId) await trx.raw("SELECT set_config('app.current_person_id', ?, true)", [ctx.personId]);
    if (ctx.familyGroupId) await trx.raw("SELECT set_config('app.current_family_group_id', ?, true)", [ctx.familyGroupId]);
    if (ctx.actingAsAdministrator) await trx.raw("SELECT set_config('app.acting_as_administrator', 'true', true)");
    return fn(trx);
  });
}

// Public, token-authenticated routes (invitation accept/decline landing —
// see docs/invitation_flow.md) have no logged-in person at all, so
// withRlsContext's app.current_person_id doesn't apply. This sets
// app.invitation_lookup_token instead, matched by the
// invitation_public_token_access RLS policy (migration 011) — a visitor can
// only ever see/act on the single invitations row whose token they hold.
export async function withTokenContext<T>(
  token: string,
  fn: (trx: knexFactory.Knex.Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.invitation_lookup_token', ?, true)", [token]);
    return fn(trx);
  });
}
