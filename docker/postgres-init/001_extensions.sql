-- Runs once, automatically, the first time the postgres container creates
-- its data volume (standard docker-entrypoint-initdb.d behavior). Migration
-- 001_extensions.js in apps/api does the same CREATE EXTENSION IF NOT EXISTS
-- calls, so this is redundant-but-harmless belt-and-suspenders — it just
-- means the extensions are available even before the very first
-- `pnpm migrate` runs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
