import { useState } from "react";
import { View, Text, TextInput, Button } from "react-native";
import { router } from "expo-router";
import { apiClient } from "../../lib/apiClient";

// Password or magic-link, same /auth/* endpoints the web app uses.
export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onLogin() {
    try {
      await apiClient.login({ email, password });
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    }
  }

  async function onMagicLink() {
    try {
      await apiClient.requestMagicLink({ email });
      setError("Check your email for a sign-in link.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send link");
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "600" }}>myFamiPedia</Text>
      <TextInput
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      {error ? <Text>{error}</Text> : null}
      <Button title="Log in" onPress={onLogin} />
      <Button title="Send me a magic link instead" onPress={onMagicLink} />
      <Button title="Create an account" onPress={() => router.push("/register")} />
    </View>
  );
}
