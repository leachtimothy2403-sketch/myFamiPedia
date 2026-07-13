import { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

type TreeMode = "structure" | "by-person" | "by-decade";

// Explore is folded into this tab: a segmented control switches between the
// pan/zoom graph (Structure), a searchable flat list (By person, also the
// quick-jump for large trees), and the decade card grid (By decade) — see
// "Tree tab" notes in mobile_app_structure.md. Fewer tabs, same functionality.
export default function TreeScreen() {
  const [mode, setMode] = useState<TreeMode>("structure");
  const { data: tree } = useQuery({
    queryKey: ["family-tree"],
    queryFn: () => apiClient.getFamilyTree("me"), // family_group_id resolved server-side from the auth token
  });

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-around", padding: 12 }}>
        {(["structure", "by-person", "by-decade"] as TreeMode[]).map((m) => (
          <TouchableOpacity key={m} onPress={() => setMode(m)}>
            <Text style={{ fontWeight: mode === m ? "700" : "400" }}>
              {m === "structure" ? "Structure" : m === "by-person" ? "By person" : "By decade"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={{ flex: 1, padding: 16 }}>
        {mode === "structure" && <Text>Pan/zoom tree canvas — {tree ? "loaded" : "loading…"}</Text>}
        {mode === "by-person" && <Text>Searchable flat list of every profile.</Text>}
        {mode === "by-decade" && <Text>Decade card grid, including the featured decade card.</Text>}
      </View>
    </View>
  );
}
