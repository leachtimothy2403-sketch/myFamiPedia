import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import getPort from "get-port";

/**
 * Boots an in-memory Postgres (PGlite, WASM) exposed over the real Postgres
 * wire protocol via pglite-socket, and points process.env.DATABASE_URL at
 * it so that application code (src/db/pool.ts, via src/config/env.ts)
 * transparently connects to it once imported. Route handlers under test
 * then run through the exact same query code as production.
 *
 * Deliberately does NOT open its own Knex connection: PGLiteSocketServer,
 * used directly as a class (rather than through its CLI's `-m/--max-connections`
 * multiplexer, which isn't exposed on the class), only serves one real
 * connection at a time — a second concurrent pool (e.g. one used here to run
 * migrations, alongside the app's own pool.ts pool) causes spurious
 * "Connection terminated unexpectedly" errors. Callers should import
 * src/db/pool.ts's `db` (after this resolves) and run migrations through
 * that same instance — see withApp.ts.
 *
 * IMPORTANT ordering requirement: because src/config/env.ts reads
 * process.env.DATABASE_URL once at module-import time, this function must
 * run (and env.ts must not have been imported yet in this test file) before
 * any `import` of application code. Static `import` statements are hoisted
 * to the top of a module regardless of where they're written, so
 * application modules must be brought in with a dynamic `await import(...)`
 * placed after `await createTestDb()`.
 *
 * Known limitation (documented, not silently ignored): PGlite's single
 * connection is always a superuser (rolsuper=true, rolbypassrls=true), and
 * pglite-socket does not support authenticating as a different Postgres
 * role. Since Postgres superusers always bypass Row-Level Security
 * regardless of FORCE ROW LEVEL SECURITY, tests using this harness CANNOT
 * verify that RLS policies actually restrict rows — only that queries run
 * without error under a given app.current_person_id/family_group_id
 * context. RLS policy correctness itself was verified by manual review
 * (docs/privacy_enforcement.md) and by confirming the migration's CREATE
 * POLICY statements apply cleanly. Don't write a test that asserts
 * "tenant B's row is hidden" against this harness — it will pass even if
 * the policy is wrong, because the bypass hides the bug.
 */
export interface TestDb {
  teardown: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = await PGlite.create({ extensions: { vector, pgcrypto, citext, pg_trgm } });
  const port = await getPort();
  const server = new PGLiteSocketServer({ db: pglite, port, host: "127.0.0.1" });
  await server.start();

  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
  process.env.NODE_ENV = "test";
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret";

  return {
    teardown: async () => {
      await server.stop();
      await pglite.close();
    },
  };
}

/** Truncates every application table so each test starts from a clean slate. Order doesn't matter — CASCADE handles FKs. */
export async function resetDb(knex: import("knex").Knex): Promise<void> {
  await knex.raw(`
    TRUNCATE TABLE
      notification_settings, notifications, flags,
      interview_answer_photos, interview_answers, interview_sessions, interview_questions,
      voice_models, invitations, holding_space,
      proposed_memories, photo_persons, photos,
      reactions, memory_photos, memory_persons, memories,
      relationships, persons, users, family_groups
    RESTART IDENTITY CASCADE
  `);
}
