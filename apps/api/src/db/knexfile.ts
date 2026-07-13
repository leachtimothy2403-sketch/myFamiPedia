import type { Knex } from "knex";
import { env } from "../config/env";

const config: Knex.Config = {
  client: "pg",
  connection: env.databaseUrl,
  migrations: {
    directory: "./migrations",
    extension: "js",
  },
  seeds: {
    directory: "./seeds",
    extension: "js",
  },
  pool: { min: 2, max: 10 },
};

export default config;
