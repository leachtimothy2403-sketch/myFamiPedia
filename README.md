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
pnpm workers                    # background workers (face detection, transcription, voice cloning, ...)
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

`apps/api` has a real, tested implementation behind every route in
`docs/api_structure.md` — auth, tree, memories, persons, invitations,
collection/camera-roll, voice consent, interviews, moderation, notifications,
subscription, and keyword-mode search. Semantic-mode search returns a clear
501 (needs a Voyage embedding call, see below). Full DB schema + RLS, 15
migrations, all verified against an in-memory pglite Postgres via a real
integration test suite (`apps/api/tests`, 120 tests, `pnpm --filter
@myfamipedia/api test`) that runs the actual Express handlers over a real
Postgres wire protocol connection — not a reimplementation. A GitHub Actions
workflow (`.github/workflows/api-tests.yml`) runs this suite on every push/PR.

The five async pipelines (face detection, holding-space-drain-on-acceptance,
interview transcription, voice cloning, notifications) have real BullMQ
workers in `apps/api/src/jobs/*.worker.ts` (alongside `queue.ts`, matching
the scaffold's existing convention and `ecosystem.config.js`'s PM2 process
pointing at `dist/jobs/runWorkers.js`), run as a separate process
(`pnpm --filter @myfamipedia/api workers`, or `pnpm workers` from the repo
root). Their DB orchestration —
transitions, tier-1/2/3 branching, archiving, RLS-safe writes — is real and
tested against fakes; only the actual external API calls are conditionally
stubbed, and only where genuinely necessary:
- **Real, working today** given the right API key: transcription (OpenAI
  Whisper), voice cloning (ElevenLabs), embeddings (Voyage AI) — see
  `apps/api/src/services/{transcription,voiceClone,embeddings}.service.ts`.
- **Still a deliberate stub**: face detection/recognition (needs
  `@aws-sdk/client-rekognition` and real AWS credentials — SigV4 signing
  isn't something to hand-roll) and R2 object storage (needs
  `@aws-sdk/client-s3`) — see `vision.service.ts` and `r2.service.ts`. Every
  worker that depends on these is fully implemented and tested against a
  fake; only this one boundary in each is unfinished.

Workers run under a `withServiceContext` DB helper (`app.service_role` RLS
GUC) rather than a per-request person/family context, since a background job
often has neither — see `src/db/pool.ts`'s doc comment and migration
`015_service_role_and_missing_write_policies.js` for why that migration was
needed (several tables had RLS enabled with no INSERT policy at all, which
is invisible in tests since pglite always runs as a superuser that bypasses
RLS, but would have silently blocked real writes in production).

A shared `packages/shared` (types + Zod schemas + a fetch-based `ApiClient`
used by both clients) and route scaffolds for both mobile (Expo Router) and
web (Vite + React Router) exist matching their respective app-structure docs,
but their business logic (wiring screens to real API calls, state
management) is not yet implemented — that's the next layer to build.

`packages/shared`, `apps/api`, and `apps/web` all type-check clean
(`pnpm exec tsc --noEmit`). `apps/mobile` was reviewed by hand rather than
compiled — its Expo/React Native dependency tree is heavy enough that a full
`pnpm install` didn't reliably finish in this environment; worth running
`pnpm install && pnpm exec tsc --noEmit` inside `apps/mobile` once you have a
normal dev machine, as a first sanity check.
