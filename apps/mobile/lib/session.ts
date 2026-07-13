import * as SecureStore from "expo-secure-store";
import type { TokenStore } from "@myfamipedia/shared";

// SecureStore-backed TokenStore for the shared ApiClient — mobile's
// counterpart to web's localStorage-backed store (apps/web/src/lib/session.ts).
const ACCESS_KEY = "myfamipedia.accessToken";
const REFRESH_KEY = "myfamipedia.refreshToken";

export const secureStoreTokenStore: TokenStore = {
  async getAccessToken() {
    return SecureStore.getItemAsync(ACCESS_KEY);
  },
  async getRefreshToken() {
    return SecureStore.getItemAsync(REFRESH_KEY);
  },
  async setTokens({ accessToken, refreshToken }) {
    await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
    await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
  },
  async clearTokens() {
    await SecureStore.deleteItemAsync(ACCESS_KEY);
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  },
};

export async function hasSession(): Promise<boolean> {
  return (await secureStoreTokenStore.getRefreshToken()) !== null;
}
