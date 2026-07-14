# myFamiPedia — .env was never actually loaded (real root cause)

## What was wrong

No code anywhere in `apps/api` called `dotenv.config()` or otherwise loaded
`.env` into `process.env`. `src/config/env.ts` reads `process.env.DATABASE_URL`
etc. directly, but a `.env` file sitting on disk does nothing on its own —
Node doesn't read it unless something tells it to. So every edit to `.env`
(the Docker port remap to 5433/6380 included) was silently ignored, and the
app kept falling back to its hardcoded default
(`postgres://myfamipedia:changeme@localhost:5432/myfamipedia`) — which is
why `migrate` kept hitting port 5432 (your other project's Postgres
container) no matter what `.env` said.

This is a pre-existing gap in the original scaffold, not something you did
wrong — it just hadn't been exercised until now since this looks like the
first time `.env` needed to actually take effect.

## The fix

`apps/api/src/config/env.ts` now does:

```ts
import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
```

An explicit path is used (not dotenv's cwd-relative default) because
`pnpm --filter @myfamipedia/api <script>` runs with cwd set to `apps/api`,
while the actual `.env` lives at the repo root (matching `.env.example` and
the README's quickstart). `dotenv.config()` never overwrites a `process.env`
var that's already set, so this stays compatible with the test harness's
existing ordering trick (`tests/helpers/testDb.ts` sets
`process.env.DATABASE_URL` to a pglite socket URL before `config/env.ts` is
ever imported) — verified by running the suite both with and without a real
root `.env` present.

Adds `dotenv` (^16.4.5) as a real dependency (needed at runtime, not just
dev) — `package.json` and `pnpm-lock.yaml` are both included so
`pnpm install` won't need to re-resolve anything.

## Verification

- `tsc --noEmit`: clean.
- Confirmed `env.databaseUrl`/`env.redisUrl` correctly pick up a root `.env`'s
  values when imported the way `pnpm --filter @myfamipedia/api migrate` runs
  it (cwd = `apps/api`).
- `persons.test.ts` (20), `scheduledJobs.worker.test.ts` (13),
  `subscription.test.ts` (4), `notification.worker.test.ts` (3) all pass —
  run once with no `.env` present, and again with a real root `.env` present,
  to confirm no leakage into the pglite test harness either way.

## Apply

```powershell
Expand-Archive -Path myfamipedia-dotenv-fix.zip -DestinationPath . -Force
npx pnpm install
```

Then retry:

```powershell
npx pnpm --filter @myfamipedia/api migrate
```

This should now actually connect to port 5433 (your Docker Postgres), not
5432 — and succeed.
