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
