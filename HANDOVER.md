# myFamiPedia — session handover (2026-07-18)

For a new Claude session (or human) picking this up cold. `README.md` is currently stale — it's a leftover one-off bugfix note, not real project docs — don't trust it as an entry point.

## What this project is

myFamiPedia is a family history / memory archive app (mobile + web + API monorepo: `apps/api` Node/Express/TS + Postgres/Knex, `apps/mobile` Expo/React Native, `apps/web`, `packages/shared`). Families record voice/text memories, build a family tree, and (newer feature) upload photos that get auto-analyzed to surface candidate memories for review.

## What's built and working as of this session

- **Core app**: auth, family tree, memories (voice/text), interview Q&A with adaptive frequency, search, notifications, admin roles (`family_role`, succession via transfer endpoint), privacy tiers (now only `2`/`3` — see below), voice pipeline (transcription).
- **Photo pipeline** (`docs/photo_pipeline_beta_architecture.md`, `docs/media_pipeline.md`, `docs/section2_pipeline.md` — all current as of this session):
  - Detection-only face pipeline via AWS Rekognition (`DetectFaces`) — **no automated face matching/identification**, that was permanently retired for GDPR Article 9 reasons. Faces are detected and stored (`photo_faces`); a human taps a face to tag it (`POST /photos/:id/faces/:faceId/tag`), either to an existing person or proposing a new one.
  - Two-stage scene classification: Rekognition `DetectLabels` (cheap triage) → Claude Haiku (judgment) to decide if a photo is memory-worthy. Both are **real API calls now**, not mocks (this session's main backend work).
  - Time/location clustering job groups photos into `photo_clusters` (rolling 6h window + 2km haversine), producing one `proposed_memories` row per distinct uploader per cluster.
  - Crowd-mode: photos with >8 faces skip individual tap-to-tag UI.
  - Trust-list tag-review feature (self-governed list of who can tag you without review) was **designed but deliberately tabled** — noted in the architecture doc's "Open items" section with full reasoning. Don't build it without the user raising it again.
- **Mobile UI**: only one screen currently calls into the photo pipeline — `apps/mobile/app/collection/add-photo.tsx` (built this session), reachable from Home → "Add a photo". It picks **one** photo via `expo-image-picker`, uploads it (presign → PUT to R2 → complete), which enqueues face detection/embedding/classification/clustering. Results show up in the existing `collection/review.tsx` accept/reject screen.
  - **Not built yet**: camera-roll batch sync UI (needs `expo-media-library`, not installed) and tap-to-tag face UI (needs a photo-overlay component). Both have working backend routes already (`POST /collection/camera-roll/sync`, `GET /photos/:id/faces`, `POST /photos/:id/faces/:faceId/tag`) with zero UI calling them.

## This session's changes, in order

1. Fixed a CI `TS2554` bug in `persons.routes.ts` (an uncommitted local fix from an earlier session, never pushed).
2. Found and committed a full day of previously-uncommitted work across the repo in one commit (uploads/R2, adaptive Q&A, notifications, search, mobile upgrades) — cross-platform `git config core.fileMode false` needed first to separate real diffs from Windows/Linux file-mode noise.
3. Tabled the trust-list feature (documented, not built) after walking through why it wasn't a clear win yet.
4. Rewrote stale docs (`media_pipeline.md`, `section2_pipeline.md`, `family_administrator_and_privacy_model.md`) to accurately reflect what's built vs. designed.
5. Wired real AWS Rekognition (`DetectFaces`, `DetectLabels`, `ListFaces`+`DeleteFaces`) and confirmed Claude Haiku classification calls — previously these were interfaces with no real implementation.
6. Fixed two real gaps: manual single-photo uploads weren't enqueuing any pipeline jobs (now they do, `uploads.routes.ts`), and `privacy_tier=1` was dead code with no live behavior (retired via migration `025_retire_privacy_tier_one.js`, values `2`/`3` only now).
7. Built the `add-photo.tsx` mobile screen described above — first UI entry point into the pipeline.
8. User created a scoped AWS IAM user (Rekognition-only policy: `DetectFaces`/`DetectLabels`/`ListFaces`/`DeleteFaces`) on an AWS Free plan account, and populated `.env` with real `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`/`ANTHROPIC_API_KEY`.

All backend work was verified via `tsc --noEmit` + `pnpm test` (216/216 passing) run locally by the user — I don't have a working local Postgres/Redis/full node_modules in my own sandbox, so I verify syntax with esbuild and hand real typecheck/test commands to the user.

## Immediate next step (in progress, unconfirmed)

User was about to run the live end-to-end test on a real iPhone: launch the app, Home → "Add a photo" → pick a photo → Upload → check "Review proposed memories". **Result not yet reported as of this handover.** If it failed, the workers terminal output is the place to start debugging (Rekognition/Claude/R2 call failures surface there, not in the API server log).

## How to run locally

```
docker-compose up -d          # Postgres (5433), Redis (6380)
cd apps/api
pnpm run migrate               # NOT `pnpm exec knex migrate:latest` — needs --knexfile, the npm script already passes it
pnpm run seed                  # may fail harmlessly if interview_answers already exist referencing seed questions (known bug: seed does a blind delete-all, not idempotent) — safe to skip if it does
pnpm dev                       # API server
```
Second terminal: `cd apps/api && pnpm workers`
Third terminal: `cd apps/mobile && pnpm exec tsc --noEmit && expo start -c`

## Standing conventions to keep following

- **Never run `git add`/`git commit`/`git push` from the sandbox** — always give the user exact commands to run locally in PowerShell. The sandbox has repeatedly hit `.git/index.lock` issues; running git from here isn't safe.
- **Verify in-sandbox with esbuild** (syntax-level) for quick checks; always tell the user the real `tsc --noEmit` / `pnpm test` commands to run locally for actual confidence.
- **Docs should stay honest** — explicitly distinguish "what's built today" from "what's designed but not built." Several docs in `docs/` were rewritten this session specifically to fix places where they'd drifted into describing aspirational behavior as real.
- **Flag gaps proactively** rather than silently fixing or ignoring them. Known open gaps not yet acted on: admin-succession (no backup if the family administrator becomes unreachable), data export (no user data portability), the seed-script idempotency bug noted above, camera-roll batch sync UI, tap-to-tag face UI.
- User prefers concise, direct responses — avoid over-explaining finished work.
