import { useEffect, useState } from "react";
import { Redirect, Slot, SplashScreen } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../lib/queryClient";
import { hasSession } from "../lib/session";

SplashScreen.preventAutoHideAsync();

// Root stack: session check -> (auth) or (tabs). invite/[token] is
// intentionally outside both groups — see mobile_app_structure.md's
// navigation notes on universal-link deep linking pre-login.
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
    <QueryClientProvider client={queryClient}>
      {!authed ? <Redirect href="/login" /> : null}
      <Slot />
    </QueryClientProvider>
  );
}
