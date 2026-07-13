import { ApiClient } from "@myfamipedia/shared";
import { localStorageTokenStore } from "./session";

const baseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1";

export const apiClient = new ApiClient({ baseUrl, tokenStore: localStorageTokenStore });
