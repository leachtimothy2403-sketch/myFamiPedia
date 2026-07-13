import { useState } from "react";
import { View, Text, TextInput, Button } from "react-native";
import { router } from "expo-router";
import { apiClient } from "../../lib/apiClient";

export default function RegisterScreen() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onRegister() {
    try {
      await apiClient.register({ name, email, password, language: "en" });
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "600" }}>Create your family's space</Text>
      <TextInput placeholder="Your name" value={name} onChangeText={setName} />
      <TextInput
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      {error ? <Text>{error}</Text> : null}
      <Button title="Create account" onPress={onRegister} />
    </View>
  );
}
