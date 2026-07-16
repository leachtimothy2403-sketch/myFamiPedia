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

// personId/familyGroupId aren't returned by login (only register echoes the
// person back), but they're already sitting in the JWT payload the API
// issues (apps/api's auth.routes.ts issueTokens) — decoding it here avoids
// an extra round-trip or an API change. Web's counterpart
// (apps/web/src/lib/session.ts) uses the browser's atob; Hermes/React
// Native has no atob global, so this is a small dependency-free base64
// decoder rather than reaching for a new native package for one JWT read.
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(input: string): string {
  let str = input.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const char of str) {
    if (char === "=") break;
    const index = BASE64_CHARS.indexOf(char);
    if (index === -1) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

function decodeJwtPayload<T = unknown>(token: string): T | null {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(base64Decode(payload)) as T;
  } catch {
    return null;
  }
}

interface SessionClaims {
  userId: string;
  personId: string;
  familyGroupId: string;
}

async function currentClaims(): Promise<SessionClaims | null> {
  const token = await secureStoreTokenStore.getRefreshToken();
  if (!token) return null;
  return decodeJwtPayload<SessionClaims>(token);
}

export async function getPersonId(): Promise<string | null> {
  return (await currentClaims())?.personId ?? null;
}

export async function getFamilyGroupId(): Promise<string | null> {
  return (await currentClaims())?.familyGroupId ?? null;
}
