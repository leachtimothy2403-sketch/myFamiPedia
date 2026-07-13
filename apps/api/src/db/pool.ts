import knexFactory from "knex";
import knexConfig from "./knexfile";

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
    if (ctx.personId) await trx.raw("SET LOCAL app.current_person_id = ?", [ctx.personId]);
    if (ctx.familyGroupId) await trx.raw("SET LOCAL app.current_family_group_id = ?", [ctx.familyGroupId]);
    if (ctx.actingAsAdministrator) await trx.raw("SET LOCAL app.acting_as_administrator = 'true'");
    return fn(trx);
  });
}
