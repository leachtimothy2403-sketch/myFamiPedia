import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../lib/apiClient";

export type QuestionFrequency = "never" | "few_days" | "weekly" | "daily";

// Self-only, never admin-writable — same convention as usePrivacyTier.ts
// (docs/api_structure.md, Section 2 table). Note the wire value is
// "few_days" (underscore) — that's what apps/api's DB check constraint
// (migration 012) and collection.routes.ts actually validate against, not
// the "few-days" (hyphen) in packages/shared/src/schemas/person.schemas.ts's
// questionFrequencySchema. That schema looks like a pre-existing mismatch
// with the real API contract; flagged rather than fixed here since it's a
// backend/shared-package change outside this pass's scope.
export function useQuestionFrequency(personId: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["question-frequency", personId],
    queryFn: () =>
      apiClient.request<{ questionFrequency: QuestionFrequency }>(`/persons/${personId}/question-frequency`),
    enabled: Boolean(personId),
  });
  const mutation = useMutation({
    mutationFn: (frequency: QuestionFrequency) =>
      apiClient.request(`/persons/${personId}/question-frequency`, {
        method: "PATCH",
        body: { questionFrequency: frequency },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["question-frequency", personId] }),
  });
  return { ...query, setFrequency: mutation.mutate };
}
