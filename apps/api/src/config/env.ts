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
