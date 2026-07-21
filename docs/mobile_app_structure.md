# myFamiPedia — Mobile App Structure (Expo Router)

```
app/
  _layout.tsx                          # root stack, session check -> (auth) or (tabs)
  (auth)/
    _layout.tsx
    login.tsx
    register.tsx
  invite/
    [token].tsx                        # public deep link, accept/decline landing
  (tabs)/
    _layout.tsx                        # bottom tab bar (4 tabs)
    index.tsx                          # Home: memory feed (section 9)
    tree.tsx                           # family tree structure/graph canvas only (By person / By decade removed 2026-07-20)
    share-story.tsx                    # entry point into life-story sessions (section 3), renamed from "record"
    account.tsx                        # own profile + settings hub
  person/
    [id]/
      index.tsx                        # profile: header, tags, timeline, memories, connections
      ask.tsx                          # Ask feature panel
      edit.tsx                         # self or administrator-only edit
  memory/
    [id].tsx                           # single memory detail + reactions
  collection/
    review.tsx                         # Section 2 proposal queue (3 proposals, 2-tap accept/reject)
    manage.tsx                         # browse/manage already-added memories; delete affordance TBD, see note below
    settings.tsx                       # privacy tier (1/2/3) + question frequency
  interview/
    session/
      [sessionId].tsx                  # active recording flow, question-by-question or photo-prompted; camera/library button stays live throughout, not just pre-session
  voice/
    [personId]/
      consent.tsx                      # 4-moment flow, modal stack (preview/decision/confirm)
      settings.tsx                     # ongoing control: pause/revoke, autoplay toggle
  notifications/
    index.tsx
  admin/
    moderation-queue.tsx
    deceased-profile/
      new.tsx                          # section 4 entry point
```

## Navigation notes

- Root `_layout.tsx` redirects based on auth state (Expo Router's `Redirect` + a session hook backed by SecureStore-persisted tokens).
- `invite/[token]` sits outside both `(auth)` and `(tabs)` groups since it must work whether or not the opener already has an account — it's the one screen reachable pre-login via universal link (`https://app.myfamipedia.com/invite/:token`) or custom scheme (`myfamipedia://invite/:token`).
- Consent flow (`voice/[personId]/consent`), interview session, and collection review are presented as modals (`Stack.Screen options={{ presentation: 'modal' }}`) rather than tab screens — each is a focused, interruption-worthy task, consistent with "20 minutes max" interview sessions and "under two minutes" review cards.

## Tree tab (structure only)

`tree.tsx` is the family-tree structure/graph canvas (`TreeCanvas`, pan/zoom) and nothing else as of 2026-07-20 — the **By person** (searchable flat list) and **By decade** (birth-decade grouped list) modes that used to sit alongside it via a segmented control were removed at Tim's request; too many overlapping ways to browse the same tree data. Person lookup now lives in Search. `lib/treeGrouping.ts`'s `groupByDecade`/`groupByGeneration` helpers were left in place (unused) rather than deleted, in case a future feature wants them.

## Share your story (renamed from Record a conversation)

One screen (`(tabs)/share-story.tsx`), progressive reveal — no more "Get started" hop. "Whose story is this?" (My own story / Record someone else) sits right under the header; choosing "someone else" reveals a picker of the family tree's profiles (same data source as the tree/person screens). Once a subject is resolved, the three starting-point choices appear in place below: open-ended, Q&A, or photo-prompted. All three push straight to `session/[sessionId].tsx`.

Q&A calls `GET /interview-questions/next?personId=` rather than always taking the first curated question — it works through the shared bank in `sort_order` first, then (once exhausted for that person) a Claude-generated follow-up built from their prior transcripts/memories (migration 022, `docs/section2_pipeline.md` section 4's pattern reused for the live session, not just the async push). Needs `ANTHROPIC_API_KEY` set to generate follow-ups, and transcripts only exist once `OPENAI_API_KEY` is set and answers have actually been transcribed — with neither configured, Q&A just cycles the curated bank, which still works.

Within a session, a photo can serve as a conversation starter, a mid-conversation illustration, or an after-the-fact attachment: a camera-capture button (physical photo digitization, `photos.source='physical_scan'`) sits alongside the usual library picker, and it stays reachable the whole time recording is active — not just before the session starts. Someone can snap or pick a photo the instant a memory comes up mid-sentence without pausing the conversation. Capture during an active recording must go through an in-app camera view rather than launching the OS camera app, since handing off to a system camera would suspend the app and cut the audio (see voice pipeline doc for the timing mechanics — mid-answer photos land in `interview_answer_photos` and get promoted to `memory_photos` once the answer is transcribed). Same underlying pipeline either way: upload → face-match → embed, just three different entry points into it.

## Memory review and management

`collection/review.tsx` (the Section 2 proposal queue) is joined by `collection/manage.tsx` — a persistent entry point (icon on the Home tab header, not just reachable via notification) for browsing memories already in the archive. The "N memories to review" notification deep-links straight into `review.tsx`; the "manage your memories" row on Account links into `manage.tsx`.

Delete behavior in `manage.tsx` is resolved (see data model doc for the full policy): each row shows one of two actions depending on the memory's state. Unlinked, unreacted, non-voice memories get a straightforward "delete" with a confirmation tap. Anything linked to another profile or already reacted-to gets "retract" instead — content disappears from the family's view but nothing is actually destroyed, and undoing it later requires the original contributor, not an administrator. Posthumous-profile contributions don't get either action here; they route to the existing flag/moderation flow. Voice-recorded memories only ever show "retract," never "delete," regardless of link/reaction state.

## State management

- **Server state:** React Query (or TanStack Query) for all API data — profiles, memories, tree, search results. Matches the myMigo pattern and gives free caching/retry for the flaky-network mobile case.
- **Local/session state:** lightweight store (Zustand or Jotai) for in-progress recording state, current consent-flow step, offline queue of pending camera-roll manifest uploads.
- **Idempotency:** background sync writes (camera-roll manifest, question answers) generate a client-side UUID as `Idempotency-Key` before the request is attempted, so retry-after-failure never double-submits.

## Background collection

`expo-task-manager` + `expo-background-fetch` register the periodic camera-roll scan, with the caveat that iOS background fetch timing is opportunistic, not guaranteed — the practical trigger is "on app foreground" plus best-effort background runs, not a strict cron. Push notifications (Expo Push Service) are the reliable channel for review/prompt cadence regardless of whether background fetch actually ran.

## Shared code with web

Recommend a small shared package (`packages/shared`, pnpm/yarn workspace) holding: API client (`fetch` wrapper + React Query hooks), TypeScript types matching the Postgres schema, and Zod validation schemas — reused by both this Expo app and the React web app (task 11) so a schema change updates both clients from one source. This isn't in the product doc explicitly; it's a standard engineering default for the myMigo-style two-client pattern and worth adopting now rather than retrofitting later.
