import type { Express } from "express";
import type { Knex } from "knex";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createTestDb, resetDb } from "./testDb";

export interface TestContext {
  request: () => ReturnType<typeof supertest>;
  knex: () => Knex;
}

/**
 * Standard per-test-file wiring: boots a fresh pglite instance and points
 * DATABASE_URL at it (see testDb.ts), THEN dynamically imports the app's own
 * db pool to run migrations through the SAME Knex instance the app will use
 * (a second pool competing for pglite-socket's single real connection causes
 * spurious drops — see testDb.ts), THEN imports src/index for the Express
 * app. Truncates all tables between tests; tears the whole instance down
 * once the file's tests finish.
 */
export function withApp(): TestContext {
  let app: Express;
  let knex: Knex;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    teardown = testDb.teardown;

    const { db } = await import("../../src/db/pool");
    knex = db;
    await knex.migrate.latest();

    const mod = await import("../../src/index");
    app = mod.default;
  });

  afterEach(async () => {
    await resetDb(knex);
  });

  afterAll(async () => {
    await knex.destroy();
    await teardown();
  });

  return {
    request: () => supertest(app),
    knex: () => knex,
  };
}

export interface TestUser {
  accessToken: string;
  refreshToken: string;
  personId: string;
  familyGroupId: string;
  userId: string;
}

/** Registers a fresh account via the real /auth/register endpoint and returns its tokens/ids. */
export async function registerTestUser(
  request: () => ReturnType<typeof supertest>,
  overrides: Partial<{ email: string; password: string; name: string }> = {}
): Promise<TestUser> {
  const email = overrides.email ?? `test-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await request()
    .post("/api/v1/auth/register")
    .send({ email, password: overrides.password ?? "hunter2hunter2", name: overrides.name ?? "Test Person" });
  if (res.status !== 201) {
    throw new Error(`registerTestUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const decoded = JSON.parse(Buffer.from(res.body.accessToken.split(".")[1], "base64").toString());
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    personId: decoded.personId,
    familyGroupId: decoded.familyGroupId,
    userId: decoded.userId,
  };
}
