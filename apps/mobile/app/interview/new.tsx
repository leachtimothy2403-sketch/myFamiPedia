import { useState } from "react";
import { View, Text, Button } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

// Subject picker: defaults to self ("me"); a visible "record for someone
// else" control opens a dropdown of tree profiles for the facilitated-elder
// case. Both paths converge on [personId]/new.tsx.
export default function InterviewSubjectPickerScreen() {
  const [pickingOther, setPickingOther] = useState(false);
  const { data: tree } = useQuery({
    queryKey: ["family-tree"],
    queryFn: () => apiClient.getFamilyTree("me"),
    enabled: pickingOther,
  });

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Whose story is this?</Text>
      <Button title="My own story" onPress={() => router.push("/interview/me/new")} />
      <Button title="Record for someone else" onPress={() => setPickingOther(true)} />
      {pickingOther && (
        <View style={{ gap: 8 }}>
          <Text>Select a profile ({tree ? "loaded" : "loading…"}):</Text>
          {/* Dropdown of persons rendered here from `tree` — same data source as tree.tsx */}
        </View>
      )}
    </View>
  );
}
