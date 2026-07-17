# myFamiPedia — Handover addendum (2026-07-17, overnight session)

Continuation of `docs/handover_2026-07-17.md` (same day, later session, run unattended overnight per Tim's request). That doc's "Suggested next step" listed four options; this session did option (a): wire up mobile's person profile screen to match web's.

## What changed

Three files in `apps/mobile/app/person/[id]/`, all rewritten from stub to full implementation, mirroring `apps/web/src/routes/person/[id]/*.tsx` and its `components/profile/*` (mobile has no `components/` split yet — everything's still inline per screen file, consistent with how `app/(tabs)/tree.tsx` does it):

* **`index.tsx`** — full profile: header (name, status badge, lifespan, AI summary), life timeline (dated memories), add-memory form (text + optional date + private toggle), memories feed (with reactions — "This touched me" / "I remember this too"), connections panel (relationships resolved to names, tappable), links to Ask/Edit. Reuses the same `["family-tree", familyGroupId]` query the tree tab populates, so it's usually a cache hit when navigated to from there.
* **`edit.tsx`** — now pre-fills and saves `birthDate`/`deathDate` alongside `name` (previously name-only). Dates are plain `YYYY-MM-DD` `TextInput`s rather than a native date picker — no new dependency for one field, matching mobile's existing minimal-dependency approach.
* **`ask.tsx`** — added proper error handling (the ask endpoint is a genuine server-side stub — `notImplemented(...)` in `apps/api/src/routes/persons.routes.ts:140` — so errors are surfaced plainly rather than left as an unhandled rejection, same pattern as web's `AskPanel`).

No new dependencies, no `package.json` changes, no shared-package or API changes. Mobile's tree tab already covers navigation into these screens (tapping a person row does `router.push(/person/${id})`), so this closes the loop mobile was missing: mobile's core loop (register → tree → add people → view/edit a full profile → add memories) now matches web's, except mobile still doesn't do photos/voice (same deferred-on-purpose scope as web, per the R2/Rekognition credential gap noted in the prior handover).

## Verification (and a sandbox limitation worth knowing about)

This session's sandbox had the same stale-mount issue the prior handover warned about, but worse than described: reads of recently-written files through the bash shell's mount came back truncated/stale **repeatedly**, not just "shortly after" a write — even minutes later and after the `Write` tool had already confirmed success. Root-caused as read staleness, not write failure: the `Read` tool (host path) always returned correct, current content; only `bash` (FUSE mount path) showed stale data. Every file used for verification was therefore typed out fresh via bash heredoc from `Read`-tool-confirmed content into a `/tmp` scratch dir, never copied from the mount — this is slower but was the only reliable path this session. If a future session hits the same thing, don't trust `cat`/`rsync` output from the mounted repo path for anything just written; re-`Read` and heredoc instead.

Separately — and this is new — a full `pnpm install` of `apps/mobile`'s dependency tree (Expo + React Native pull ~900 transitive packages) would not complete inside this environment's 45-second-per-command ceiling, even across many retries with a persistent store cache (each retry made partial progress but never finished; package *resolution* alone seemed to consume most of a 45s window every time, independent of how much was already cached). This is a sandbox/tooling constraint, not a problem with the code.

Given that ceiling, verification for this session's changes was done in three ways instead of one full `tsc` pass on the whole mobile app:

1. **`packages/shared` built clean with real `tsc`** (`tsc -p tsconfig.json`, exit 0, `.d.ts` emitted) — confirms the `Person`/`Memory`/`Relationship`/`RelationshipType`/`ApiClient` shapes these new screens depend on are exactly what's actually in the repo (installs standalone fast since it only depends on `zod`).
2. **All three changed files passed `esbuild` syntax/transform checks** (exit 0, no errors) — confirms valid TS/JSX syntax, balanced braces, no typos in structure.
3. **Manual cross-reference of every field and method used against the real, freshly-read source** — every `Person`/`Memory`/`Relationship` field referenced (`name`, `status`, `birthDate`, `deathDate`, `aiSummary`, `content`, `mediaUrl`, `eventDate`, `provenanceType`, `provenanceLabel`, `personAId`, `personBId`, `relationshipType`) exists on the real type with the expected shape; every `apiClient` call (`getPerson`, `getFamilyTree`, `createMemory`, `reactToMemory`, and the raw `request()` calls to `/persons/:id/memories`, `/persons/:id/timeline`, `PATCH /persons/:id`, `POST /persons/:id/ask`) matches a route that actually exists in `apps/api/src/routes/persons.routes.ts` (confirmed via `grep` — line numbers: tree `:15`, get `:35`, patch `:52`, timeline `:97`, memories `:116`, ask `:140`) and a schema that actually validates that payload shape (`updatePersonSchema`, `createMemorySchema`, `reactToMemorySchema` in `packages/shared/src/schemas/`).

What this **didn't** verify: a real Metro/Expo bundle, or React Native's actual `.d.ts` types (e.g. whether `Switch`'s props are used exactly right, or `SectionList`-adjacent RN quirks) — that needs `pnpm install` to actually finish, which needs either more time than a single command window allows, or running it directly on Tim's machine where it isn't sandboxed. **Recommend Tim run `npx pnpm install` and `pnpm --filter @myfamipedia/mobile exec tsc --noEmit` once locally before or right after pulling this** — it should be fast on a normal connection/machine; this is just a sandbox artifact, not a predicted problem.

## Git — commands for Tim to run (PowerShell, not this sandbox)

Per the standing rule in the prior handover: git must never be run from this sandbox against the real repo (it leaves lock files Tim's local git then can't clear). These three files were edited directly via the file-editing tool, not the sandbox shell, so there's no lock-file risk this time — but the commit itself still needs to happen locally.

```powershell
cd C:\Users\leach\myfamipedia
git status
git add apps/mobile/app/person/[id]/index.tsx apps/mobile/app/person/[id]/edit.tsx apps/mobile/app/person/[id]/ask.tsx docs/handover_2026-07-17-mobile-profile.md
git commit -m "Mobile: full person profile screen (timeline, memories, connections, reactions), edit dates, ask error handling"
git push
```

No `pnpm install`/lockfile step needed first (no dependency changes), but it's still worth running `npx pnpm install && pnpm --filter @myfamipedia/mobile exec tsc --noEmit` locally first, per the verification note above, before pushing — cheap insurance given this session couldn't finish that check itself.

## Suggested next step

Same three options the prior handover left open, still open: (b) settings/voice/privacy screens on either platform, (c) R2 + Rekognition credentials so photos and auto-collection can go live, or (d) something else. Mobile and web now have equivalent core loops (register → tree → add people → full profile → memories); the next gap on mobile specifically, if continuing platform parity, would be surfacing search (web also doesn't have a search UI yet either, per the prior handover, so this is equally missing on both).
