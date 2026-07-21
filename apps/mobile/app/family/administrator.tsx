import { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { Stack } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Person } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

// 2026-07-22 — GET /family/administrator and POST /family/administrator/transfer
// were fully built and tested (11 tests, tests/routes/administrator.test.ts)
// but API-only until now, per the testing checklist. Reachable from Account
// ("Family administrator" row). Direct, unilateral transfer, no nomination/
// confirmation handshake — matches the API exactly (docs/family_administrator_and_privacy_model.md
// section 1 explicitly parked a backup/successor nomination flow as a
// separate, un-built feature; this screen doesn't invent one).
export default function FamilyAdministratorScreen() {
  const { personId, familyGroupId } = useSessionIds();
  const queryClient = useQueryClient();
  const [transferringTo, setTransferringTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: adminData, isLoading: adminLoading } = useQuery({
    queryKey: ["family-administrator"],
    queryFn: () => apiClient.request<{ administrator: { personId: string; name: string } | null }>("/family/administrator"),
  });

  const { data: tree } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });

  const administrator = adminData?.administrator ?? null;
  const isCurrentAdmin = Boolean(administrator && personId && administrator.personId === personId);
  const candidates: Person[] = (tree?.persons ?? []).filter(
    (p) => p.status === "active" && p.id !== administrator?.personId
  );

  async function transferTo(target: Person) {
    setError(null);
    setTransferringTo(target.id);
    try {
      await apiClient.request("/family/administrator/transfer", { method: "POST", body: { toPersonId: target.id } });
      await queryClient.invalidateQueries({ queryKey: ["family-administrator"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't transfer — try again.");
    } finally {
      setTransferringTo(null);
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <Stack.Screen options={{ title: "Family administrator" }} />

      {adminLoading ? (
        <ActivityIndicator />
      ) : (
        <View style={{ backgroundColor: "#fafafa", borderRadius: 12, padding: 16 }}>
          <Text style={{ fontSize: 15, color: "#666" }}>Current administrator</Text>
          <Text style={{ fontSize: 18, fontWeight: "700", marginTop: 4 }}>
            {administrator ? administrator.name : "None set"}
            {isCurrentAdmin ? " (you)" : ""}
          </Text>
        </View>
      )}

      {isCurrentAdmin ? (
        <View style={{ gap: 8 }}>
          <Text style={{ fontWeight: "600", fontSize: 16 }}>Transfer to someone else</Text>
          <Text style={{ color: "#666", fontSize: 14 }}>
            This is immediate — you'll no longer be the administrator once you transfer. Only an active family member can
            receive it.
          </Text>
          {candidates.length === 0 ? (
            <Text style={{ color: "#888" }}>No other active family members to transfer to yet.</Text>
          ) : (
            <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 8 }}>
              {candidates.map((p, i) => (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => transferTo(p)}
                  disabled={Boolean(transferringTo)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingVertical: 14,
                    paddingHorizontal: 14,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: "#eee",
                    opacity: transferringTo && transferringTo !== p.id ? 0.5 : 1,
                  }}
                >
                  <Text style={{ fontSize: 16 }}>{p.name}</Text>
                  <Text style={{ color: "#1a73e8", fontWeight: "600" }}>
                    {transferringTo === p.id ? "Transferring…" : "Transfer"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      ) : (
        <Text style={{ color: "#666" }}>
          Only the current administrator can transfer this role to someone else.
        </Text>
      )}

      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
