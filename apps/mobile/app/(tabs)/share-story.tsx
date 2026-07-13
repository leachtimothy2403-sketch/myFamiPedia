import { View, Text, Button } from "react-native";
import { router } from "expo-router";

// Renamed from "Record a conversation" — this is about recording the user's
// own life history through questions, not literally recording a live
// conversation. Tapping the tab goes straight into interview/new.tsx, which
// defaults the subject to self and offers a "record for someone else" control.
export default function ShareStoryScreen() {
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Share your story</Text>
      <Text>Answer questions about your own life, or record someone else's.</Text>
      <Button title="Get started" onPress={() => router.push("/interview/new")} />
    </View>
  );
}
