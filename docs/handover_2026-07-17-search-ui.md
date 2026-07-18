# myFamiPedia — Handover addendum (2026-07-17, fifth session)

Continuation of today's earlier addenda. This one picks up the last open item from the original punch list: search UI, called out as "API supports keyword + semantic search; no frontend for it yet." It had one.

## What changed

**`packages/shared`** (affects both web and mobile, since both go through this):

* **`src/apiClient.ts`'s `search()` method — real bug fix.** It built the query string directly from `SearchQueryInput`'s camelCase keys (`dateFrom`, `dateTo`, `mediaType`). The API (`apps/api/src/routes/search.routes.ts`) reads plain snake_case query params off `req.query` directly — `date_from`, `date_to`, `media_type` — it doesn't go through the response-body `camelizeKeys` transform, since that only applies to what comes back, not what's sent. So those three filters were silently never applied. Separately, `URLSearchParams` coerces object values with `String()`, so every *unset* optional field (`person`, `dateFrom`, `dateTo`, `mediaType`, `contributor`) was being sent as the literal string `"undefined"` — e.g. a plain query with no person filter would've sent `person=undefined`, which the API would then try to filter by literally. Neither bug had ever surfaced because no frontend called `search()` until today. Fixed to build the query string with correct param names and only include fields that are actually set.
* **`src/lib/searchResults.ts` (new)** — `normalizeSearchResults()`. The two search modes return genuinely different shapes (confirmed by reading `searchHandler` in full): keyword mode returns whole `memories.*` rows plus `rank`; semantic mode returns a pre-normalized `{ resultType, id, preview, eventDate, similarity }` union across memories *and* photos, with no contributor id in that query at all. This flattens both into one shape so neither frontend's results list has to branch on which mode ran — and, importantly, doesn't fabricate a `contributorId` for semantic results, since that mode's query genuinely never selects one.
* **`src/index.ts`** — exports the above.

**Web:**

* **`src/routes/search/index.tsx` (new)** — search box, keyword/semantic toggle (defaults to keyword, since semantic depends on a live embeddings API call succeeding and keyword doesn't), media-type filter, results list. Registered at `/search` in `App.tsx`, linked from the tree page's header.
* **`src/routes/explore/person.tsx`** — same `"me"`-placeholder bug as everything else fixed today, one more instance: `useFamilyTree("me")`. Checked the actual route this hits (`GET /family-groups/:id/tree`) — unlike most of today's other fixes, this one doesn't even 403 cleanly; it queries Postgres with `req.params.id` directly with no auth check first, so a literal `"me"` against a UUID column would throw an invalid-input-syntax database error. Fixed the same way.

**Mobile:**

* **`app/(tabs)/search.tsx` (new)** — same feature, RN idioms (TextInput/TouchableOpacity/FlatList), same `normalizeSearchResults()` from the shared package so both platforms interpret the API's two result shapes identically. Registered as a fifth tab in `app/(tabs)/_layout.tsx` (Home, Tree, **Search**, Share your story, Account).

## Verification

* **Real `tsc` build of `packages/shared`**, including the new `searchResults.ts` and the edited `apiClient.ts` — clean, exit 0, declarations emitted.
* **`esbuild` syntax checks** on all seven changed/new files (both search screens, `App.tsx`, `explore/person.tsx`, the mobile tab layout, plus the two shared-package files) — all clean, exit 0.
* **Manual verification of the two-shapes claim**: read `searchHandler` in `apps/api/src/routes/search.routes.ts` end to end (not skimmed) to confirm keyword mode's `.select("memories.*")` vs semantic mode's explicit `trx.raw("'memory' AS result_type")`/`trx.raw("... AS preview")` column list — the normalizer's field mapping matches what each mode's SQL actually selects.
* **Not verified**: a real `tsc` pass against actual React Router / React Native type declarations, same sandbox limitation as every other change today. Worth including in the same local verification pass as the other pending changes:

```powershell
cd C:\Users\leach\myfamipedia
npx pnpm@9.15.9 --filter @myfamipedia/web exec tsc --noEmit
npx pnpm@9.15.9 --filter @myfamipedia/mobile exec tsc --noEmit
```

(The mobile one only makes sense after the SDK 54 upgrade in the other addendum is installed — see that doc.)

## What to test

* Web: `/search` (or the new "Search" link in the tree page header) — try a keyword search for something you know exists in a memory's text, confirm results appear with the right date/type; switch to Semantic and confirm it either works or fails with the "needs a working embeddings API" message rather than crashing (the embeddings service is a stub per earlier handovers, so semantic mode may legitimately not work yet — that's expected, not a bug in this UI). Try the media-type filter. `/explore/person` should now load the real family list instead of erroring.
* Mobile: new Search tab, same checks.

## Git — commands for Tim to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia
git status
git add packages/shared/src/apiClient.ts packages/shared/src/lib/searchResults.ts packages/shared/src/index.ts apps/web/src/routes/search/index.tsx apps/web/src/App.tsx apps/web/src/routes/tree/index.tsx apps/web/src/routes/explore/person.tsx apps/mobile/app/"(tabs)"/search.tsx apps/mobile/app/"(tabs)"/_layout.tsx docs/handover_2026-07-17-search-ui.md
git commit -m "Build search UI (web + mobile), fix apiClient.search() query bug, fix explore/person 'me' bug"
git push
```

Same `(tabs)` quoting note as the settings-fixes addendum — PowerShell needs it quoted or `git add` errors on the parentheses. No dependency changes in this commit, so no lockfile step (unlike the SDK 54 upgrade commit, which does need one — see that addendum).

## Where things stand after today

Everything from the original punch list has now been touched except photos/face-detection (blocked on R2 + Rekognition credentials — your call when you're ready) and the `few-days`/`few_days` schema mismatch (flagged, not fixed, in the settings addendum). Today, in order: mobile person profile screen, settings screens (privacy/voice/subscription/notifications, all had the same `"me"` bug), the Expo SDK 51→54 upgrade to unblock your testing, and now search. The SDK upgrade is the one item that genuinely needs your hands before trusting any of the rest on mobile — everything else here is web-only or was verified independently of that upgrade.
