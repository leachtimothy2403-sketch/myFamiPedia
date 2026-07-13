import { ApiClient } from "@myfamipedia/shared";
import { secureStoreTokenStore } from "./session";

// EXPO_PUBLIC_* vars are inlined at build time by Expo — see .env.example at repo root.
const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

export const apiClient = new ApiClient({ baseUrl, tokenStore: secureStoreTokenStore });
