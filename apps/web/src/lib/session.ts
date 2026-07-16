import type { TokenStore } from "@myfamipedia/shared";

// localStorage-backed TokenStore — web's counterpart to mobile's
// SecureStore-backed store (apps/mobile/lib/session.ts). Per the artifacts
// policy for this codebase generally we avoid localStorage in throwaway
// artifacts, but this is a real deployed app with its own origin, not a
// sandboxed preview artifact, so localStorage is the right tool here.
const ACCESS_KEY = "myfamipedia.accessToken";
const REFRESH_KEY = "myfamipedia.refreshToken";

export const localStorageTokenStore: TokenStore = {
  async getAccessToken() {
    return localStorage.getItem(ACCESS_KEY);
  },
  async getRefreshToken() {
    return localStorage.getItem(REFRESH_KEY);
  },
  async setTokens({ accessToken, refreshToken }) {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  async clearTokens() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export function hasSession(): boolean {
  return localStorage.getItem(REFRESH_KEY) !== null;
}

// The API never gained a dedicated "/auth/me" endpoint, and login (unlike
// register) doesn't echo the person back in its response body — but
// personId/familyGroupId are already sitting in the JWT payload the API
// issues (auth.routes.ts's issueTokens), so decoding it client-side avoids
// an extra round-trip or an API change. This is a plain base64 decode, not a
// signature check — fine for reading UI-routing claims, since the server
// re-verifies the token on every real request regardless.
function decodeJwtPayload<T = unknown>(token: string): T | null {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

interface SessionClaims {
  userId: string;
  personId: string;
  familyGroupId: string;
}

function currentClaims(): SessionClaims | null {
  const token = localStorage.getItem(REFRESH_KEY);
  if (!token) return null;
  return decodeJwtPayload<SessionClaims>(token);
}

export function getPersonId(): string | null {
  return currentClaims()?.personId ?? null;
}

export function getFamilyGroupId(): string | null {
  return currentClaims()?.familyGroupId ?? null;
}

export function clearSession(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}
