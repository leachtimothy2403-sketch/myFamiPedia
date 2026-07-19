import type { RegisterInput, LoginInput, MagicLinkRequestInput } from "./schemas/auth.schemas";
import type { CreateMemoryInput, ReactToMemoryInput } from "./schemas/memory.schemas";
import type { SearchQueryInput } from "./schemas/search.schemas";
import type { Person, Relationship, RelationshipType } from "./types/person";
import type { Memory } from "./types/memory";
import { camelizeKeys } from "./lib/caseTransform";

// Token persistence differs by client (localStorage on web, SecureStore/
// AsyncStorage on mobile) — the consuming app supplies an implementation
// rather than this package assuming a browser or RN runtime.
export interface TokenStore {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  setTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void>;
  clearTokens(): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  async getAccessToken() { return this.accessToken; }
  async getRefreshToken() { return this.refreshToken; }
  async setTokens(tokens: { accessToken: string; refreshToken: string }) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
  }
  async clearTokens() { this.accessToken = null; this.refreshToken = null; }
}

export interface ApiClientOptions {
  baseUrl: string; // e.g. https://api.myfamipedia.com/api/v1
  tokenStore?: TokenStore;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

// Thin wrapper: typed convenience methods for the routes that matter most to
// both clients, plus a generic `request()` escape hatch for everything else
// in docs/api_structure.md so this file doesn't need one method per endpoint.
export class ApiClient {
  private baseUrl: string;
  private tokenStore: TokenStore;
  private refreshing: Promise<void> | null = null;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenStore = options.tokenStore ?? new InMemoryTokenStore();
  }

  async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string } = {}
  ): Promise<T> {
    const { method = "GET", body, auth = true, idempotencyKey } = init;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    if (auth) {
      const token = await this.tokenStore.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && auth) {
      await this.tryRefresh();
      const token = await this.tokenStore.getAccessToken();
      if (token) {
        const retry = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: { ...headers, Authorization: `Bearer ${token}` },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return this.parse<T>(retry);
      }
    }
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    // Server errors are shaped { error: message } (see apps/api's errorHandler),
    // not { message: ... } — this was reading the wrong key, so every thrown
    // ApiError across both clients showed a generic status text ("Not Found")
    // instead of the real server message. body is still preserved either way.
    if (!res.ok) throw new ApiError(res.status, data?.error ?? data?.message ?? res.statusText, data);
    return data === undefined ? (data as T) : camelizeKeys<T>(data);
  }

  // Single in-flight refresh, shared across concurrent 401s.
  private async tryRefresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const refreshToken = await this.tokenStore.getRefreshToken();
        if (!refreshToken) return;
        try {
          const data = await this.request<{ accessToken: string; refreshToken: string }>(
            "/auth/refresh",
            { method: "POST", body: { refreshToken }, auth: false }
          );
          await this.tokenStore.setTokens(data);
        } catch {
          await this.tokenStore.clearTokens();
        }
      })();
      try {
        await this.refreshing;
      } finally {
        this.refreshing = null;
      }
    } else {
      await this.refreshing;
    }
  }

  // --- Auth ---
  async register(input: RegisterInput) {
    const data = await this.request<{ accessToken: string; refreshToken: string }>(
      "/auth/register",
      { method: "POST", body: input, auth: false }
    );
    await this.tokenStore.setTokens(data);
    return data;
  }

  async login(input: LoginInput) {
    const data = await this.request<{ accessToken: string; refreshToken: string }>(
      "/auth/login",
      { method: "POST", body: input, auth: false }
    );
    await this.tokenStore.setTokens(data);
    return data;
  }

  async requestMagicLink(input: MagicLinkRequestInput) {
    return this.request<void>("/auth/magic-link/request", { method: "POST", body: input, auth: false });
  }

  async logout() {
    await this.request<void>("/auth/logout", { method: "POST" });
    await this.tokenStore.clearTokens();
  }

  // --- Tree / persons ---
  async getFamilyTree(familyGroupId: string) {
    return this.request<{ persons: Person[]; relationships: Relationship[] }>(
      `/family-groups/${familyGroupId}/tree`
    );
  }

  async getPerson(personId: string) {
    return this.request<Person>(`/persons/${personId}`);
  }

  // "Add family member" — living branch. There is no plain POST /persons
  // route; a living person is always created together with the invitation
  // that will eventually let them log in (apps/api's invitations.routes.ts).
  // Returns a shareableLink when neither inviteeEmail nor inviteePhone is
  // given, per that route's documented MVP fallback.
  async inviteFamilyMember(input: {
    name: string;
    relationshipType: RelationshipType;
    relatedToPersonId: string;
    inviteeEmail?: string | null;
    inviteePhone?: string | null;
  }) {
    return this.request<{ person: Person; invitation: unknown; shareableLink?: string }>("/invitations", {
      method: "POST",
      body: input,
    });
  }

  // "Add family member" — deceased branch (Section 4). No invitation step:
  // "no one to invite" (docs/data_model.md). deathDate is required by the
  // route itself, not just recommended.
  async addDeceasedProfile(input: {
    name: string;
    relationshipType: RelationshipType;
    relatedToPersonId: string;
    birthDate?: string | null;
    deathDate: string;
    profileData?: Record<string, unknown>;
  }) {
    return this.request<Person>("/persons/deceased", { method: "POST", body: input });
  }

  // --- Memories ---
  async createMemory(input: CreateMemoryInput) {
    return this.request<Memory>("/memories", { method: "POST", body: input });
  }

  async reactToMemory(memoryId: string, input: ReactToMemoryInput) {
    return this.request(`/memories/${memoryId}/react`, { method: "POST", body: input });
  }

  async deleteMemory(memoryId: string) {
    return this.request<void>(`/memories/${memoryId}`, { method: "DELETE" });
  }

  async retractMemory(memoryId: string) {
    return this.request(`/memories/${memoryId}/retract`, { method: "POST" });
  }

  async restoreMemory(memoryId: string) {
    return this.request(`/memories/${memoryId}/restore`, { method: "POST" });
  }

  // --- Search ---
  // apps/api's search.routes.ts reads plain snake_case query params
  // (date_from, date_to, media_type) straight off req.query — it doesn't go
  // through camelizeKeys the way responses do, since that's a response-body
  // transform. Building URLSearchParams directly from SearchQueryInput's
  // camelCase keys silently sent the wrong param names for those three
  // fields, and stringified any unset optional field (person, dateFrom,
  // dateTo, mediaType, contributor) into the literal string "undefined"
  // (URLSearchParams coerces object values with String()). Neither bug
  // surfaced before now — no frontend called search() until this session.
  async search(query: SearchQueryInput) {
    const params = new URLSearchParams();
    params.set("q", query.q);
    params.set("mode", query.mode);
    if (query.person) params.set("person", query.person);
    if (query.dateFrom) params.set("date_from", query.dateFrom);
    if (query.dateTo) params.set("date_to", query.dateTo);
    if (query.mediaType) params.set("media_type", query.mediaType);
    if (query.contributor) params.set("contributor", query.contributor);
    return this.request<{ items: unknown[] }>(`/search?${params.toString()}`);
  }

  // --- Uploads (presigned R2, see docs/api_structure.md cross-cutting notes) ---
  async presignUpload(input: { contentType: string; context: "memory" | "photo" | "voice" }) {
    return this.request<{ uploadUrl: string; uploadId: string; r2Key: string }>(
      "/uploads/presign",
      { method: "POST", body: input }
    );
  }

  async completeUpload(uploadId: string) {
    return this.request(`/uploads/${uploadId}/complete`, { method: "POST" });
  }

  // --- Camera-roll sync (the "proactive" path, docs/media_pipeline.md) ---
  // Batch registration only — each photo's bytes must already be PUT to R2
  // via a presignUpload({ context: "photo" }) URL before its r2Key is passed
  // here. Unlike completeUpload, this always runs the full detection +
  // scene-classification + embedding pipeline and one family-wide clustering
  // pass per call, since (unlike the pull path) nothing yet knows which of
  // these photos are worth surfacing as a memory.
  async syncCameraRoll(photos: { r2Key: string; takenAt?: string; location?: { lat: number; lng: number } }[]) {
    return this.request<{ items: { id: string }[] }>("/collection/camera-roll/sync", {
      method: "POST",
      body: { photos },
    });
  }
}
