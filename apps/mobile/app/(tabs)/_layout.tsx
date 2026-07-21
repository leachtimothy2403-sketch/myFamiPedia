import { Tabs } from "expo-router";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";

// Five tabs: Home, Tree (structure view only as of 2026-07-20 — by-person
// and by-decade browsing were removed from this tab, see tree.tsx), Search
// (memory content search; added this session, web's counterpart is
// routes/search/index.tsx), Share (2026-07-21 — this file's route is now a
// flat hub with three big buttons: Share a memory / Tell your story / Photos
// to review, replacing what used to be the interview-flow screen directly;
// title changed from "Share your story" to plain "Share" since it covers
// more than storytelling now — see share-story.tsx's own comment), Account.
// Tab bar previously had no icons at all (default placeholder triangles),
// just text labels.
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
          title: "Share",
          // Was a microphone, but this tab covers more than voice recording
          // (a text memory, a guided interview, or a photo review), so a
          // conversation-bubble reads more accurately than an icon that
          // implies audio-only.
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
