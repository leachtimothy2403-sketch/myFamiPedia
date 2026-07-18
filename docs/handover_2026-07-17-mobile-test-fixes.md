# myFamiPedia — Handover addendum (2026-07-17, sixth session)

Picks up directly from your manual test pass on the phone. Triaged your results into: confirmed bugs (all fixed below), working-as-designed items (noted, no change needed), and two gaps you approved building ("Yes lets build both, they are important for mobile experience" — add-family-member UI and notification preferences on mobile).

## Your test results, triaged

* **Register/login, tree loads** — OK, no action.
* **"I dont see a way to add a new family member from the app"** — confirmed gap, built (see below).
* **Person profile, Add a memory, Edit** — OK, no action.
* **"Tapping [react] doesnt produce any change"** — confirmed bug, fixed this afternoon in the settings-fixes round already (`ReactionBar` on both platforms now shows a checkmark + disables after a successful tap). If you're still seeing no change after pulling today's other changes, it's likely stale JS in Expo Go's cache — restart with `expo start -c`.
* **"Ask input field is located in the top of the phone, too far up... (throughout app)"** — this is the safe-area/header bug, fixed below. It wasn't specific to Ask; every screen outside the tab bar and login had zero safe-area handling.
* **Collection settings, Search (keyword/semantic/media-type filter)** — OK, no action.
* **Voice settings: "autoplay voice clips" toggle, Pause, Revoke visible** — working as designed; consent management just had no link to reach it, fixed below.
* **"Notifications... No checkbox, just shows 'nothing new'"** — that screen is the notification *inbox* (a feed of past notifications, correctly showing empty). What you were actually looking for — the ability to turn notification types on/off — never existed on mobile at all. Built below as a separate screen.
* **Interview "My own story" — unclear what "tap start answering" does** — investigated; this screen works correctly (it's a Q&A flow — tapping a question opens a recorder), no bug found. Flagging in case you want a walkthrough/tooltip added later, but that's a UX polish item, not a defect.
* **Account → Manage your memories** — OK, no action.

## What changed

**Root cause fix — this was the big one:**

* **`app/_layout.tsx`** — the root layout was a bare `<Slot/>` with no navigator and no `SafeAreaProvider` anywhere in the app. Every route outside `(tabs)` and `(auth)` — person profile, voice, interview, collection, admin, memory, notifications, invite, and now family-member — had zero header, zero back button, and zero safe-area inset handling, which is exactly why Ask (and everything else) rendered up under the status bar/notch. Replaced with `<SafeAreaProvider>` wrapping a `<Stack>` that auto-registers all file-based routes with default headers and back buttons; `(auth)` and `(tabs)` keep `headerShown: false` since they manage their own chrome.

**Reaction feedback** (fixed earlier today, noted here for completeness — see `docs/handover_2026-07-17-mobile-profile.md`'s predecessor round if you want the diff): `apps/web/src/components/shared/ReactionBar.tsx` and the inline reaction bar in `apps/mobile/app/person/[id]/index.tsx` both now track local sent/error state and show a checkmark once a reaction posts successfully.

**Voice consent link:**

* **`app/voice/[personId]/settings.tsx`** — added a "Manage consent" button to `/voice/${personId}/consent`. That screen already existed and worked; it just had no way to reach it from anywhere in the app.

**New: add-family-member on mobile**

* **`app/family-member/new.tsx` (new)** — ports `apps/web/src/components/tree/AddFamilyMemberPanel.tsx`'s logic to RN. Name, relationship (pill picker: child/parent/spouse/sibling/other, phrased from the new person's point of view — "New person is my ___"), relative-to picker (defaults to yourself), a living/deceased toggle. Living branch invites via `apiClient.inviteFamilyMember()` (shows a shareable link if the API returns one); deceased branch calls `apiClient.addDeceasedProfile()` and collects birth/death dates instead of contact info. Invalidates the `["family-tree", familyGroupId]` query on success so the tree tab reflects the addition immediately.
* **`app/(tabs)/tree.tsx`** — added a "+ Add family member" button above the person list, navigating to the new screen. Web's tree page already had this; mobile never did.

**Bug found while scoping the above, fixed on both platforms — deceased-profile creation was broken everywhere:**

* `POST /persons/deceased` hard-requires `relationshipType` and `relatedToPersonId` (confirmed by reading the handler in `apps/api/src/routes/persons.routes.ts`: `if (!name || !deathDate || !relationshipType || !relatedToPersonId) return res.status(400)...`). Neither `apps/web/src/routes/admin/deceased-profile/new.tsx` nor `apps/mobile/app/admin/deceased-profile/new.tsx` ever collected or sent those two fields — every submission through either screen would have 400'd. This predates today's session; you hadn't hit it because neither screen is linked from any UI on either platform (confirmed via grep — orphaned routes, reachable only by typing the URL/deep link directly). Fixed both to collect relationship type and relative-to person, matching the pattern the tree page's own add-family-member panel already used correctly.

**New: notification preferences on mobile**

* **`app/notifications/settings.tsx` (new)** — mirrors the web version fixed earlier today (`apps/web/src/routes/settings/notifications.tsx`): `GET /notifications/settings` → list of `{notificationType, enabled}` → each `Switch` fires `PATCH /notifications/settings` with `{notificationType, enabled}` on toggle, cache invalidated on success. This is distinct from `app/notifications/index.tsx`, which is the notification *inbox* (a feed) and was working correctly — that screen wasn't touched.
* **`app/(tabs)/account.tsx`** — added a "Notification preferences" button next to the existing "Notifications" (inbox) button, linking to the new screen.

## Verification

* **`esbuild` syntax checks** on all six changed/new files this round (`family-member/new.tsx`, `(tabs)/tree.tsx`, both `admin/deceased-profile/new.tsx` files, `notifications/settings.tsx`, `(tabs)/account.tsx`) — all clean, exit 0.
* **API contract cross-check**: confirmed `apiClient.inviteFamilyMember()`, `apiClient.addDeceasedProfile()`, `apiClient.getFamilyTree()`, and `apiClient.request()` all already exist in `packages/shared/src/apiClient.ts` with the signatures used — no new client methods needed, these screens just call existing ones.
* **`app/_layout.tsx`** verified against `expo-router`'s documented `<Stack>` behavior for nested route groups (`(auth)`, `(tabs)` as screen names) — matches the pattern already used correctly inside `(tabs)/_layout.tsx` for its own child screens.
* **Not verified**: a real `tsc` pass against actual React Native/Expo type declarations (same sandbox limitation noted in every prior addendum today — full dependency install doesn't complete within this sandbox's time limits). Run locally once your `pnpm install` from the SDK 54 upgrade is in place:

```powershell
cd C:\Users\leach\myfamipedia
npx pnpm@9.15.9 --filter @myfamipedia/mobile exec tsc --noEmit
npx pnpm@9.15.9 --filter @myfamipedia/web exec tsc --noEmit
```

## What to test

* Force-close and reopen the app (or `expo start -c`) so the new root layout takes effect. Confirm Ask, person profile, voice, interview, and collection screens now show a proper header/back button and content isn't tucked under the status bar.
* Tap a reaction button — should show a checkmark and disable, not just sit there.
* Voice settings → "Manage consent" should now navigate somewhere instead of being a dead end.
* Tree tab → "+ Add family member" → fill in a living relative with just a name and relation, submit, confirm they appear in the tree. Try a deceased one too (needs a death date).
* Account → "Notification preferences" (new, separate from "Notifications") → toggle a switch, confirm it sticks after leaving and coming back.
* If you ever navigate directly to the deceased-profile admin screens on either platform, confirm submitting now works instead of silently failing.

## Git — commands for Tim to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia
git status
git add apps/mobile/app/_layout.tsx apps/mobile/app/voice/"[personId]"/settings.tsx apps/mobile/app/family-member/new.tsx apps/mobile/app/"(tabs)"/tree.tsx apps/mobile/app/"(tabs)"/account.tsx apps/mobile/app/notifications/settings.tsx apps/mobile/app/admin/deceased-profile/new.tsx apps/web/src/routes/admin/deceased-profile/new.tsx docs/handover_2026-07-17-mobile-test-fixes.md
git commit -m "Fix safe-area/header bug app-wide, add mobile add-family-member and notification-preference screens, fix broken deceased-profile creation on both platforms"
git push
```

Note the `[personId]` and `(tabs)` bracket/paren folder names both need quoting in PowerShell or `git add` errors — same issue as prior addenda. No dependency changes in this commit, so no lockfile step needed (separate from the SDK 54 upgrade commit, which does need one — see that addendum if you haven't run it yet).

## Where things stand after today

Every item from your manual test pass has now been triaged: five real bugs fixed (safe-area/headers, reactions, voice consent link, missing add-family-member, broken deceased-profile creation on both platforms), two features you asked for built (add-family-member and notification preferences on mobile), and two items confirmed working-as-designed (voice settings toggles, interview flow — the latter could use a UX tooltip later but isn't broken). Combined with the earlier rounds today (mobile profile screen, settings "me" bugs, search UI, Expo SDK 51→54 upgrade), this closes out everything currently open except: photos/face-detection (blocked on R2 + Rekognition credentials), the `few-days`/`few_days` schema mismatch (flagged only, not fixed — low risk, noted in the settings addendum), and getting a real `tsc`/full install pass run locally once you're back at your machine.
