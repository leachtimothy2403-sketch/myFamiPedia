import { useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient } from "../../lib/apiClient";

// Public accept/decline landing (no auth) — shares logic with the mobile
// equivalent (app/invite/[token].tsx).
export default function InviteLandingRoute() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<"idle" | "accepted" | "declined">("idle");

  async function accept() {
    await apiClient.request(`/invitations/${token}/accept`, { method: "POST", auth: false });
    setStatus("accepted");
  }
  async function decline() {
    await apiClient.request(`/invitations/${token}/decline`, { method: "POST", auth: false });
    setStatus("declined");
  }

  return (
    <div style={{ maxWidth: 480, margin: "80px auto" }}>
      <h1>You've been invited to join a family tree</h1>
      {status === "idle" && (
        <>
          <button onClick={accept}>Accept</button>
          <button onClick={decline}>Decline</button>
        </>
      )}
      {status === "accepted" && <p>Welcome — create your account to continue.</p>}
      {status === "declined" && <p>No problem. You can be re-invited later.</p>}
    </div>
  );
}
