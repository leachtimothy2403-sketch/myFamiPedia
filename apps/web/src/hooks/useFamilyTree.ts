import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/apiClient";

export function useFamilyTree(familyGroupId: string) {
  return useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId),
  });
}
