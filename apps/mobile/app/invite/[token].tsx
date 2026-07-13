import { useState } from "react";
import { View, Text, Button } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiClient } from "../../lib/apiClient";

// Public accept/decline landing — reachable pre-login via universal link
// (https://app.myfamipedia.com/invite/:token) or custom scheme
// (myfamipedia://invite/:token). Deliberately outside (auth) and (tabs).
export default function InviteLandingScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
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
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>You've been invited to join a family tree</Text>
      {status === "idle" && (
        <>
          <Button title="Accept" onPress={accept} />
          <Button title="Decline" onPress={decline} />
        </>
      )}
      {status === "accepted" && <Text>Welcome — create your account to continue.</Text>}
      {status === "declined" && <Text>No problem. You can be re-invited later.</Text>}
    </View>
  );
}
