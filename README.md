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
