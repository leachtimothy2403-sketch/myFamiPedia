import { useEffect, useState } from "react";
import { Redirect, Stack, SplashScreen } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { queryClient } from "../lib/queryClient";
import { hasSession } from "../lib/session";

SplashScreen.preventAutoHideAsync();

// Root stack: session check -> (auth) or (tabs). invite/[token] is
// intentionally outside both groups — see mobile_app_structure.md's
// navigation notes on universal-link deep linking pre-login.
//
// Was a bare <Slot/> with no SafeAreaProvider anywhere in the tree. (auth)
// and (tabs) manage their own chrome (Stack/Tabs headers, hidden below to
// avoid a double header) — but every other route (person/, voice/,
// interview/, collection/, admin/, memory/, notifications/, invite/) has no
// _layout.tsx of its own, so under a bare <Slot/> those screens rendered
// with zero navigator chrome: no header, no back button, and no safe-area
// handling, so content started at y=0 and sat under the status bar/notch on
// a real device. Switching to <Stack> gives every one of those routes a
// real header + back button for free via Expo Router's file-based
// auto-registration (only (auth)/(tabs) need an explicit override here,
// since only they need their inner header hidden). SafeAreaProvider
// (react-native-safe-area-context, already a dependency for
// react-native-screens' sake) is what makes safe-area-aware layout
// possible at all — it was never actually mounted.
export default function RootLayout() {
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    hasSession().then((ok) => {
      setAuthed(ok);
      setChecked(true);
      SplashScreen.hideAsync();
    });
  }, []);

  if (!checked) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          {!authed ? <Redirect href="/login" /> : null}
          {/* headerBackButtonDisplayMode: "minimal" — the back button was
              showing "(tabs)" as its label (React Navigation defaults the
              back button's text to the PREVIOUS screen's title, and the
              (tabs) group has none since it manages its own chrome). This
              shows just the chevron everywhere instead of guessing a title
              for a route group that was never meant to have one. */}
          <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

            {/* Everything below just needed a human title instead of the raw
                file-based route path Expo Router shows by default (e.g.
                "person/[id]/index"). person/[id]/index and person/[id]/ask
                set their own dynamic title (the person's name) from within
                the screen itself via <Stack.Screen options={{title}}/>,
                since only they have the loaded person's name at render time. */}
            <Stack.Screen name="person/[id]/edit" options={{ title: "Edit profile" }} />
            <Stack.Screen name="voice/[personId]/settings" options={{ title: "Voice settings" }} />
            <Stack.Screen name="voice/[personId]/consent" options={{ title: "Voice consent" }} />
            {/* interview/new and interview/[personId]/new are gone — that
                three-screen hop is now one screen, share/tell-your-story.tsx
                (2026-07-21 — moved out of (tabs)/share-story.tsx, which is
                now the flat Share hub). share/compose.tsx sets its own
                dynamic title inline like person/[id]/index.tsx does, so only
                tell-your-story needs a static title here. */}
            <Stack.Screen name="share/tell-your-story" options={{ title: "Tell your story" }} />
            <Stack.Screen name="interview/session/[sessionId]" options={{ title: "Interview" }} />
            <Stack.Screen name="collection/review" options={{ title: "Review memories" }} />
            <Stack.Screen name="collection/manage" options={{ title: "Manage collection" }} />
            <Stack.Screen name="collection/add-photo" options={{ title: "Add a photo" }} />
            <Stack.Screen name="collection/compose" options={{ title: "Add details" }} />
            <Stack.Screen name="collection/camera-roll-sync" options={{ title: "Sync camera roll" }} />
            <Stack.Screen name="collection/settings" options={{ title: "Collection settings" }} />
            <Stack.Screen name="admin/moderation-queue" options={{ title: "Moderation queue" }} />
            <Stack.Screen name="admin/deceased-profile/new" options={{ title: "Add a deceased profile" }} />
            <Stack.Screen name="memory/[id]" options={{ title: "Memory" }} />
            <Stack.Screen name="notifications/index" options={{ title: "Notifications" }} />
            <Stack.Screen name="notifications/settings" options={{ title: "Notification preferences" }} />
            <Stack.Screen name="invite/[token]" options={{ title: "Invitation" }} />
            <Stack.Screen name="family-member/new" options={{ title: "Add family member" }} />
            {/* family/administrator.tsx sets its own title inline (matches
                the person/[id]/index.tsx / share/compose.tsx convention) —
                listed here only so this comment block stays the one place
                that documents every route under app/, not because it needs
                an options override. 2026-07-22: GET /family/administrator +
                POST /family/administrator/transfer were API-only until now. */}
            <Stack.Screen name="family/administrator" />
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
