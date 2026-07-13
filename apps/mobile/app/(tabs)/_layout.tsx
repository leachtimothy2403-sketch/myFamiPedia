import { Tabs } from "expo-router";

// Four tabs: Home, Tree (Explore folded in — see tree.tsx notes), Share your
// story (renamed from "Record a conversation"), Account.
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: true }}>
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="tree" options={{ title: "Tree" }} />
      <Tabs.Screen name="share-story" options={{ title: "Share your story" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}
