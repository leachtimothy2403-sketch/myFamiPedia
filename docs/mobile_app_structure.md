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
    tree.tsx                           # family tree, top segmented control: Structure / By person / By decade
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
    new.tsx                            # subject picker: defaults to self, "record for someone else" opens a dropdown of tree profiles
    [personId]/
      new.tsx                          # pick question set, or start from a photo (camera capture or library)
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

## Tree tab (Structure / By person / By decade)

Explore is no longer a separate tab — `tree.tsx` now carries a segmented control at the top with three modes: **Structure** (the pan/zoom graph canvas, unchanged), **By person** (a searchable flat list, doubling as quick-jump on trees too large to scan visually), **By decade** (the card grid, including the featured "the 1960s in our family" card). Fewer tabs, same functionality. The one thing to watch: the doc calls the decade view a differentiator, and it now sits one tap deeper than before — the featured decade card on the Home feed (see the mockup) is what keeps that discoverable without its own tab.

## Share your story (renamed from Record a conversation)

`interview/new.tsx` defaults the subject to the current user's own `person_id` — tapping the tab goes straight into "answer some questions about your own life," no picker required. A visible "record for someone else" control opens a dropdown of the family tree's profiles (same data source as the tree/person screens) for the facilitated-elder case the doc originally centered this feature on. Both paths converge on the same `[personId]/new.tsx` → `session/[sessionId].tsx` flow; only the pre-selected subject differs.

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
