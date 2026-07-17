import { Redirect } from "expo-router";

// Superseded — the sandbox this session runs in can't delete files on the
// mounted drive (same junction/permissions limitation noted elsewhere in
// this project), so this is emptied to a redirect rather than removed
// outright. The "whose story is this" picker and the three-choice screen it
// used to link to ([personId]/new.tsx, also emptied) are now one screen:
// (tabs)/share-story.tsx. Nothing in the app links here anymore; this only
// catches a stale deep link or cached route.
export default function InterviewSubjectPickerScreen() {
  return <Redirect href="/(tabs)/share-story" />;
}
