import { useQuery } from "@tanstack/react-query";
import type { VoiceModel } from "@myfamipedia/shared";
import { apiClient } from "../lib/apiClient";

export function useVoiceModel(personId: string) {
  return useQuery({
    queryKey: ["voice-model", personId],
    queryFn: () => apiClient.request<VoiceModel>(`/persons/${personId}/voice-model`),
  });
}
