import { beforeAll, afterEach, afterAll } from "vitest";
import type { Knex } from "knex";
import { createTestDb, resetDb } from "./testDb";

// Same pglite-backed harness as withApp.ts, but for worker tests that don't
// need an Express app at all — just a real Knex connection to run the
// worker's processXJob() functions against.
export function withDb(): { knex: () => Knex } {
  let knex: Knex;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    teardown = testDb.teardown;
    const { db } = await import("../../src/db/pool");
    knex = db;
    await knex.migrate.latest();
  }, 35000);

  afterEach(async () => {
    await resetDb(knex);
  });

  afterAll(async () => {
    await knex.destroy();
    await teardown();
  }, 35000);

  return { knex: () => knex };
}
