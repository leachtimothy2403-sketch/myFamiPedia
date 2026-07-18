# myFamiPedia — Handover addendum (2026-07-17, fourth session)

Continuation of the three earlier addenda from today. You hit a real blocker mid-testing: your Expo Go client is SDK 54, the project was pinned to SDK 51, and Expo Go only ever supports one SDK at a time — there's no config fix for that, it's Expo Go's own policy. You asked for the SDK 54 upgrade. This is a materially bigger, riskier change than everything else done today (settings fixes, mobile profile screen): it touches `react`, `react-native`, and `expo-router` across multiple major versions each. I want to be direct about that rather than bury it in a changelog.

## What changed

`apps/mobile/package.json` — every Expo-managed dependency bumped to the exact version Expo's own SDK 54 compatibility matrix specifies (fetched live from `https://raw.githubusercontent.com/expo/expo/sdk-54/packages/expo/bundledNativeModules.json`, not guessed):

| Package | Was (SDK 51) | Now (SDK 54) |
|---|---|---|
| expo | ~51.0.28 | ~54.0.36 |
| expo-background-fetch | ~12.0.1 | ~14.0.9 |
| expo-camera | ~15.0.14 | ~17.0.10 |
| expo-image-picker | ~15.0.7 | ~17.0.11 |
| expo-linking | ~6.3.1 | ~8.0.12 |
| expo-router | ~3.5.21 | ~6.0.24 |
| expo-secure-store | ~13.0.2 | ~15.0.8 |
| expo-status-bar | ~1.12.1 | ~3.0.9 |
| expo-task-manager | ~11.8.2 | ~14.0.9 |
| react | 18.2.0 | 19.1.0 |
| react-native | 0.74.5 | 0.81.5 |
| react-native-safe-area-context | 4.10.5 | ~5.6.0 |
| react-native-screens | 3.31.1 | ~4.16.0 |
| @types/react (dev) | ~18.2.79 | ~19.2.0 |

New dependencies added, not previously present:

* **`react-native-gesture-handler` `~2.28.0`**, **`react-native-reanimated` `~4.1.1`**, **`react-native-worklets` `0.5.1`**, **`@react-navigation/drawer` `^7.5.0`** — `expo-router@~6.0.24`'s own `peerDependencies` now list these as required (expo-router 6 bundles support for drawer navigation and gesture-based interactions that earlier versions didn't). None of this project's actual screens use a drawer or reanimated animations today, but expo-router's internals may still import from these at module-load time, so a missing peer isn't a warning you can safely ignore — it risks a hard crash on app start. Added at the exact versions SDK 54 bundles.

`@babel/core` and `typescript` dev dependency ranges were left untouched — their existing caret ranges (`^7.24.0`, `^5.5.3`) already permit the versions SDK 54 needs, so there was nothing to bump.

**Not changed:** `apps/web` (completely separate stack, Vite/React Router, not affected by an Expo SDK version), `babel.config.js` (still just `babel-preset-expo`, confirmed this still works unmodified for reanimated v4 — the migration guide explicitly says not to touch it), `app.json` (see below).

## Why app.json wasn't touched

Two things you'd reasonably expect to need a config change turned out not to:

* **New Architecture** — SDK 53+ defaults to New Architecture *on*, with no field required in `app.json` to get that default. The project's `app.json` had no `newArchEnabled` field before and still doesn't — that now means "use SDK 54's default" (on) rather than "use SDK 51's default" (off). This is a real behavior change, just not one expressed as a diff anywhere. All of this project's native dependencies are Expo-maintained and New-Architecture-ready as of SDK 54, which lowers the risk, but it's still the single biggest unknown in this upgrade since it changes how the JS/native bridge works under the hood.
* **Edge-to-edge (Android)** — SDK 54 forces edge-to-edge on for all apps targeting Android 16; there's no opt-out toggle to configure either way, so there's nothing to add or remove in `app.json` for it.

## Risk assessment — what's actually exercised vs. just declared

Before touching anything I checked what this codebase actually imports, not just what's declared in `package.json`, since that changes the real risk a lot:

* **`expo-router`** — used everywhere (`router.push/replace/back`, `Tabs`, `Stack`, `Slot`, `Redirect`, `useLocalSearchParams`). I specifically checked for `router.navigate(...)`, since its behavior changed between expo-router v3 and v4 (it now behaves like `.push()` instead of the old smart-back-navigation) — **not used anywhere in this codebase**, confirmed via grep, so that particular breaking change doesn't apply here.
* **`expo-secure-store`** — used in `lib/session.ts` for plain `getItemAsync`/`setItemAsync`/`deleteItemAsync`. Simple, stable API surface across 13→15.
* **`expo-camera`, `expo-image-picker`, `expo-background-fetch`, `expo-task-manager`** — grepped the whole app: **zero actual imports**. `interview/session/[sessionId].tsx` has a comment describing a planned camera feature, but the function is an empty stub — nothing currently calls into any of these four packages, so their major-version jumps (each spans multiple majors) carry close to zero functional risk to existing code, whatever their own breaking changes were.

So the real exposure is almost entirely "does expo-router 6 still route the same way expo-router 3 did for `push`/`replace`/`back`/`Tabs`/`Stack`" — which, per the expo-router changelog, it does; the documented breaking changes for that jump don't touch the APIs this app actually calls.

## What I could not verify — same limitation as every session today, bigger stakes this time

Everything above is real (fetched from Expo's own compatibility manifest and npm registry, not recalled from memory), and the risk analysis is grounded in what this codebase actually does. But none of it has been installed or run. This sandbox's per-command time limit means a `pnpm install` of the full Expo/RN dependency tree has never completed here (documented in the mobile-profile handover from last night), and there's obviously no real device or simulator available to me either way. **This change is unusually high-value to actually run before trusting it** — much more so than the smaller UI fixes from earlier today.

### Required next step (not optional this time)

```powershell
cd C:\Users\leach\myfamipedia
npx pnpm@9.15.9 install
npx pnpm@9.15.9 --filter @myfamipedia/mobile exec expo install --fix
```

That second command is Expo's own official dependency-resolution tool — it re-checks every installed package against the SDK 54 compatibility matrix and corrects anything I got wrong or missed (e.g., if `@expo/metro-runtime` or some other transitive peer turns out to need pinning as a direct dependency, `expo install --fix` will add it; my hand-edit shouldn't need it, since `expo` and `expo-router` both already declare it as their own dependency, but this is the safety net rather than my guess). It's idempotent — if everything above is already correct, it does nothing.

Then:

```powershell
npx pnpm@9.15.9 dev:mobile
```

remembering the version pin (bare `npx pnpm` grabbed v11 earlier today and broke script resolution — see the earlier addendum).

### What to actually test

* App loads at all in Expo Go on both iOS and Android without a red-screen crash on start (this is the big one — it'll immediately surface if the gesture-handler/reanimated/drawer peer additions were insufficient).
* Login → Tree → tap a person → profile screen (exercises `useLocalSearchParams`, `router.push`, the whole screen tree built out today).
* Account → Voice settings, Account → Collection settings (today's other fixes — exercises `useSessionIds`, mutations).
* Log out → log back in (exercises `Redirect`/`Slot` in the root layout, `expo-secure-store`).

If Expo Go still refuses the project after this, check the version number it reports — if it's asking for something other than 54.x, Expo Go itself may have moved on to SDK 55 (already in beta as of this session) since you took the screenshot; the same upgrade approach applies, just targeting whatever `bundledNativeModules.json` says for the newer tag.

## Git — commands for Tim to run (PowerShell)

Do the `pnpm install` / `expo install --fix` / smoke-test above **before** committing — if `expo install --fix` changes anything, you want that in the same commit, not a follow-up fire drill.

```powershell
cd C:\Users\leach\myfamipedia
git status
git add apps/mobile/package.json pnpm-lock.yaml docs/handover_2026-07-17-expo-sdk54-upgrade.md
git commit -m "Upgrade apps/mobile to Expo SDK 54 (expo-router 3->6, RN 0.74->0.81, React 18->19)"
git push
```

Note `pnpm-lock.yaml` is included this time — unlike every other change today, this one does add/change dependencies, so the lockfile *must* be committed in the same commit, or CI's `pnpm install --frozen-lockfile` step will fail (this is exactly the mistake flagged as a process note in the very first handover from this project).

## Suggested next step

Test the above first — this needs your hands and a real device/simulator before anything else gets built on top of it. Once confirmed working, the standing open items are unchanged: search UI (in progress separately this session — see `docs/handover_2026-07-17-search-ui.md` if that's landed by the time you read this), photos/face-detection (needs R2 + Rekognition credentials), and the `few-days`/`few_days` schema mismatch flagged in the settings-fixes addendum.
