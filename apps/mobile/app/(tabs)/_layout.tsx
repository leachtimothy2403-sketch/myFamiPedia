import { Tabs } from "expo-router";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";

// Five tabs: Home, Tree (Explore folded in — see tree.tsx notes), Search
// (memory content search — distinct from the by-name/by-decade grouping
// already in the Tree tab; added this session, web's counterpart is
// routes/search/index.tsx), Share (tab bar label shortened from "Share your
// story" — it was truncating on real device widths; header title keeps the
// fuller "Share your story" via `title`, only `tabBarLabel` is shortened),
// Account. Tab bar previously had no icons at all (default placeholder
// triangles), just text labels.
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: true }}>
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="tree"
        options={{
          title: "Tree",
          tabBarIcon: ({ color, size }) => <MaterialIcons name="account-tree" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: ({ color, size }) => <Ionicons name="search-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="share-story"
        options={{
          title: "Share your story",
          tabBarLabel: "Share",
          // Was a microphone, but this tab covers three starting points —
          // free-form talking, Q&A, and photo-prompted — not just voice
          // recording, so a conversation-bubble reads more accurately than
          // an icon that implies audio-only.
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbox-ellipses-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
