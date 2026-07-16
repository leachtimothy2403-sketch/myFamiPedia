import { useEffect, useState } from "react";
import { getFamilyGroupId, getPersonId } from "./session";

interface SessionIds {
  personId: string | null;
  familyGroupId: string | null;
  loading: boolean;
}

// SecureStore reads are async (unlike web's synchronous localStorage), so
// every screen that needs personId/familyGroupId would otherwise repeat the
// same useEffect/useState dance — centralized here instead.
export function useSessionIds(): SessionIds {
  const [state, setState] = useState<SessionIds>({ personId: null, familyGroupId: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPersonId(), getFamilyGroupId()]).then(([personId, familyGroupId]) => {
      if (cancelled) return;
      setState({ personId, familyGroupId, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
