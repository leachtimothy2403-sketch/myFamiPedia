// dotenv must load before anything below reads process.env. The repo's .env
// lives at the workspace root (see .env.example there, and the README's
// quickstart which does `cp .env.example .env` from the root) — not inside
// apps/api — so this points at an explicit path rather than relying on
// dotenv's cwd-relative default, since `pnpm --filter @myfamipedia/api <script>`
// runs with cwd set to apps/api, not the root. Using an explicit path also
// means this works the same whether it's the tsx-run src file or the
// compiled dist/config/env.js (same relative depth under apps/api either way).
// dotenv.config() never overwrites a process.env var that's already set, so
// this is safe with the test harness's ordering trick (tests/helpers/testDb.ts
// sets process.env.DATABASE_URL to a pglite socket URL before this module is
// ever imported — see that file's docstring for why the ordering matters).
import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

// Central place to read process.env — every other module imports from here,
// never reads process.env directly, so a missing var fails loudly at startup.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),

  databaseUrl: process.env.DATABASE_URL ?? "postgres://myfamipedia:changeme@localhost:5432/myfamipedia",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? "dev-only-change-me",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev-only-change-me",

  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "myfamipedia-media",
  },
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    region: process.env.AWS_REGION ?? "eu-west-1",
  },
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  deeplApiKey: process.env.DEEPL_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};

// Call this explicitly from index.ts in production so a bad deploy fails at boot, not on first request.
export function assertProductionEnv() {
  if (env.nodeEnv !== "production") return;
  ["DATABASE_URL", "REDIS_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"].forEach(required);
}
