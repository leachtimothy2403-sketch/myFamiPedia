# myFamiPedia

AI-powered family memory and genealogy platform — a living, interactive family
knowledge graph. Built by Azerguia (SASU).

Repo: https://github.com/leachtimothy2403-sketch/myFamiPedia.git

## Structure

```
apps/
  api/      Node.js / Express backend — Postgres + pgvector, Redis, BullMQ workers
  mobile/   React Native / Expo app (iOS + Android)
  web/      React web app — family tree desktop view
packages/
  shared/   TypeScript types, Zod schemas, and API client shared by mobile + web
docs/       Full technical architecture (system diagram, API spec, data model,
            pipelines, privacy model, app structure, cost model)
```

`docs/` is the source of truth this scaffold was generated from. Read those
before making structural changes — most design decisions (privacy enforcement,
consent flows, the retraction/delete policy, the invitation state machine) are
explained there, not just implemented in code.

## Getting started

This is a **pnpm workspace** (see `pnpm-workspace.yaml`) — the `@myfamipedia/api`
and `@myfamipedia/web` packages depend on `@myfamipedia/shared` via the
`workspace:*` protocol, which plain `npm install` does not understand and will
fail on with `EUNSUPPORTEDPROTOCOL`. Use pnpm:

```bash
corepack enable                 # ships with Node 20+; activates the pinned pnpm version below
pnpm install                    # also builds packages/shared once, via postinstall
cp .env.example .env            # fill in real credentials
pnpm migrate                    # runs apps/api's Knex migrations against DATABASE_URL
pnpm dev:api                    # Express API on :3000
pnpm dev:web                    # Vite dev server
pnpm dev:mobile                 # Expo dev server
```

If `corepack enable` fails with a permissions error (writing into
`Program Files\nodejs` needs admin rights on Windows), skip it and run
`npx pnpm install` instead, then `npx pnpm dev:api` etc. in place of the plain
`pnpm` commands. Or run PowerShell "as Administrator" once for `corepack
enable` and use `pnpm` directly afterward.

Requires Postgres 15+ with the `pgvector` and `pgcrypto` extensions available,
and Redis for BullMQ.

If you add or change anything in `packages/shared`, run `pnpm build:shared`
before the api/web dev servers will pick it up (there's no watch mode wired
up yet — `pnpm --filter @myfamipedia/shared dev` runs `tsc --watch` if you
want one open in a spare terminal).

## Status

Full DB schema + RLS (verified against a pglite Postgres instance — all 10
migrations apply cleanly), route stubs for every endpoint in
`docs/api_structure.md` (auth, memory delete/retract, tree, and reactions are
fully implemented; the rest return 501 with a pointer to the relevant doc),
BullMQ worker stubs for the async pipelines, a shared `packages/shared` (types
+ Zod schemas + a fetch-based `ApiClient` used by both clients), and route
scaffolds for both mobile (Expo Router) and web (Vite + React Router) matching
their respective app-structure docs.

`packages/shared`, `apps/api`, and `apps/web` all type-check clean
(`pnpm exec tsc --noEmit`) as of this scaffold. `apps/mobile` was reviewed by
hand rather than compiled — its Expo/React Native dependency tree is heavy
enough that a full `pnpm install` didn't reliably finish in this environment;
worth running `pnpm install && pnpm exec tsc --noEmit` inside `apps/mobile`
once you have a normal dev machine, as a first sanity check.

Business logic inside the stub routes/workers is not yet implemented — this
is the skeleton to build into, not a working product yet.
