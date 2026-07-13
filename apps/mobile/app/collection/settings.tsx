import { View, Text } from "react-native";

// Privacy tier (1/2/3, self-only, never admin-writable) + question frequency
// (never/few-days/weekly/daily). See docs/api_structure.md, Section 2 table.
export default function CollectionSettingsScreen() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Automatic collection</Text>
      <Text>Privacy tier and question-stream frequency controls render here.</Text>
    </View>
  );
}
