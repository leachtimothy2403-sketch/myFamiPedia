import { Redirect } from "expo-router";

// Superseded — the sandbox this session runs in can't delete files on the
// mounted drive (same junction/permissions limitation noted elsewhere in
// this project), so this is emptied to a redirect rather than removed
// outright. The "whose story is this" picker and the three-choice screen it
// used to link to ([personId]/new.tsx, also emptied) are now one screen:
// share/tell-your-story.tsx (2026-07-21 — moved out of (tabs)/share-story.tsx,
// which is now the flat Share hub, not the interview flow directly). Nothing
// in the app links here anymore; this only catches a stale deep link or
// cached route.
export default function InterviewSubjectPickerScreen() {
  return <Redirect href="/share/tell-your-story" />;
}
