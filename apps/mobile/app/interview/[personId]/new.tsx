import { Redirect } from "expo-router";

// Superseded — see app/interview/new.tsx's comment. The three starting-point
// choices this screen used to show now live directly on
// share/tell-your-story.tsx after picking who the session is for.
export default function InterviewQuestionPickerScreen() {
  return <Redirect href="/share/tell-your-story" />;
}
