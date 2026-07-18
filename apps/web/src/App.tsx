import { Navigate, Route, Routes } from "react-router-dom";
import { hasSession } from "./lib/session";

import LoginRoute from "./routes/login";
import RegisterRoute from "./routes/register";
import InviteLandingRoute from "./routes/invite/[token]";
import TreeRoute from "./routes/tree/index";
import PersonProfileRoute from "./routes/person/[id]/index";
import PersonAskRoute from "./routes/person/[id]/ask";
import PersonEditRoute from "./routes/person/[id]/edit";
import ExplorePersonRoute from "./routes/explore/person";
import ExploreDecadeRoute from "./routes/explore/decade/[decade]";
import SearchRoute from "./routes/search/index";
import ModerationQueueRoute from "./routes/admin/moderation-queue";
import NewDeceasedProfileRoute from "./routes/admin/deceased-profile/new";
import PrivacySettingsRoute from "./routes/settings/privacy";
import VoiceSettingsRoute from "./routes/settings/voice";
import NotificationSettingsRoute from "./routes/settings/notifications";
import SubscriptionSettingsRoute from "./routes/settings/subscription";

// Auth guard: any active family member with a linked users row can view the
// full app (password or magic-link) — see docs/web_app_structure.md, "Who can
// use the web app". Route protection here is a UX nicety; the real
// enforcement is server-side RLS, same as every other client.
function RequireAuth({ children }: { children: JSX.Element }) {
  return hasSession() ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/register" element={<RegisterRoute />} />
      <Route path="/invite/:token" element={<InviteLandingRoute />} />

      <Route path="/tree" element={<RequireAuth><TreeRoute /></RequireAuth>} />
      <Route path="/person/:id" element={<RequireAuth><PersonProfileRoute /></RequireAuth>} />
      <Route path="/person/:id/ask" element={<RequireAuth><PersonAskRoute /></RequireAuth>} />
      <Route path="/person/:id/edit" element={<RequireAuth><PersonEditRoute /></RequireAuth>} />

      <Route path="/explore/person" element={<RequireAuth><ExplorePersonRoute /></RequireAuth>} />
      <Route path="/explore/decade/:decade" element={<RequireAuth><ExploreDecadeRoute /></RequireAuth>} />
      <Route path="/search" element={<RequireAuth><SearchRoute /></RequireAuth>} />

      <Route path="/admin/moderation-queue" element={<RequireAuth><ModerationQueueRoute /></RequireAuth>} />
      <Route path="/admin/deceased-profile/new" element={<RequireAuth><NewDeceasedProfileRoute /></RequireAuth>} />

      <Route path="/settings/privacy" element={<RequireAuth><PrivacySettingsRoute /></RequireAuth>} />
      <Route path="/settings/voice" element={<RequireAuth><VoiceSettingsRoute /></RequireAuth>} />
      <Route path="/settings/notifications" element={<RequireAuth><NotificationSettingsRoute /></RequireAuth>} />
      <Route path="/settings/subscription" element={<RequireAuth><SubscriptionSettingsRoute /></RequireAuth>} />

      <Route path="*" element={<Navigate to={hasSession() ? "/tree" : "/login"} replace />} />
    </Routes>
  );
}
