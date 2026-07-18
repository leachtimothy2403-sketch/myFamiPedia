import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";
import { useSessionIds } from "../../lib/useSessionIds";

type QuestionFrequency = "never" | "few_days" | "weekly" | "daily";

const FREQUENCY_LABEL: Record<QuestionFrequency, string> = {
  never: "Never",
  few_days: "Every few days",
  weekly: "Weekly",
  daily: "Daily",
};

function OptionRow<T extends string | number>({
  options,
  labelFor,
  selected,
  onSelect,
}: {
  options: T[];
  labelFor: (value: T) => string;
  selected: T | null | undefined;
  onSelect: (value: T) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {options.map((opt) => (
        <TouchableOpacity
          key={String(opt)}
          onPress={() => onSelect(opt)}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: selected === opt ? "#1a73e8" : "#ddd",
            backgroundColor: selected === opt ? "#e8f0fe" : "white",
          }}
        >
          <Text style={{ color: selected === opt ? "#1a73e8" : "#333", fontSize: 13 }}>{labelFor(opt)}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// Was a static placeholder ("render here"). Privacy tier (1/2/3, self-only,
// never admin-writable) + question-stream frequency — both endpoints 403 if
// called with anything other than the caller's own person id
// (apps/api's collection.routes.ts), so this waits on useSessionIds()
// rather than guessing, same as web's now-fixed settings/privacy.tsx.
export default function CollectionSettingsScreen() {
  const { personId, loading: sessionLoading } = useSessionIds();
  const queryClient = useQueryClient();

  const { data: tierData, isLoading: tierLoading } = useQuery({
    queryKey: ["privacy-tier", personId],
    queryFn: () => apiClient.request<{ privacyTier: 1 | 2 | 3 | null }>(`/persons/${personId}/privacy-tier`),
    enabled: Boolean(personId),
  });
  const setTier = useMutation({
    mutationFn: (tier: 1 | 2 | 3) =>
      apiClient.request(`/persons/${personId}/privacy-tier`, { method: "PATCH", body: { privacyTier: tier } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["privacy-tier", personId] }),
  });

  const { data: freqData, isLoading: freqLoading } = useQuery({
    queryKey: ["question-frequency", personId],
    queryFn: () =>
      apiClient.request<{ questionFrequency: QuestionFrequency }>(`/persons/${personId}/question-frequency`),
    enabled: Boolean(personId),
  });
  const setFrequency = useMutation({
    mutationFn: (freq: QuestionFrequency) =>
      apiClient.request(`/persons/${personId}/question-frequency`, {
        method: "PATCH",
        body: { questionFrequency: freq },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["question-frequency", personId] }),
  });

  if (sessionLoading || tierLoading || freqLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 20 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Automatic collection</Text>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 15, fontWeight: "600" }}>Privacy tier</Text>
        <Text style={{ fontSize: 13, color: "#666" }}>Current: {tierData?.privacyTier ?? "—"}</Text>
        <OptionRow
          options={[1, 2, 3]}
          labelFor={(tier) => `Tier ${tier}`}
          selected={tierData?.privacyTier ?? undefined}
          onSelect={(tier) => setTier.mutate(tier as 1 | 2 | 3)}
        />
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 15, fontWeight: "600" }}>Question frequency</Text>
        <Text style={{ fontSize: 13, color: "#666" }}>How often we ask you questions to help build memories.</Text>
        <OptionRow
          options={["never", "few_days", "weekly", "daily"] as QuestionFrequency[]}
          labelFor={(freq) => FREQUENCY_LABEL[freq]}
          selected={freqData?.questionFrequency}
          onSelect={(freq) => setFrequency.mutate(freq)}
        />
      </View>
    </View>
  );
}
