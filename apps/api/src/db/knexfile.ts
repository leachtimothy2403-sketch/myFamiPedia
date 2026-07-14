import path from "node:path";
import type { Knex } from "knex";
import { env } from "../config/env";

const config: Knex.Config = {
  client: "pg",
  connection: env.databaseUrl,
  migrations: {
    // Absolute, not "./migrations": a relative path only resolves correctly
    // when driven by the knex CLI from one specific cwd. Anything that calls
    // db.migrate.latest() programmatically (tests, a future bootstrap script)
    // would resolve "./migrations" against process.cwd() instead and fail
    // with ENOENT the moment it's run from anywhere else.
    directory: path.resolve(__dirname, "migrations"),
    extension: "js",
  },
  seeds: {
    directory: path.resolve(__dirname, "seeds"),
    extension: "js",
  },
  // The pglite-backed test harness (tests/helpers/testDb.ts) serves one
  // connection at a time — a larger pool there causes spurious "Connection
  // terminated unexpectedly" errors under any concurrent request. Real
  // Postgres handles the normal pool fine, so this only shrinks it in tests.
  pool: env.nodeEnv === "test" ? { min: 1, max: 1 } : { min: 2, max: 10 },
};

export default config;
