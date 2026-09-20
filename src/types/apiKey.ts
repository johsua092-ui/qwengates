/**
 * API key domain types.
 *
 * A key is a first-class entity (not just a shared secret): it has a name,
 * an optional expiry, and its own request/token quotas and rate limit.
 */

/** How the key's two counters are enforced. `null` = no limit. */
export interface ApiKeyLimits {
  /** Requests allowed per minute. `null` = unlimited. */
  rpm: number | null;
  /** Total requests allowed for the lifetime of the key. `null` = unlimited. */
  maxRequests: number | null;
  /** Total tokens (prompt + completion) allowed. `null` = unlimited. */
  maxTokens: number | null;
}

/** A key as stored on disk. Never leaves the server with `hash` populated. */
export interface StoredApiKey extends ApiKeyLimits {
  id: string;
  name: string;
  /** SHA-256 of the secret. The plaintext secret is never persisted. */
  hash: string;
  /** First characters of the key, for display in the dashboard. */
  prefix: string;
  /** Epoch ms when the key stops working. `null` = never expires. */
  expiresAt: number | null;
  /** Disabled keys are rejected with the same error as unknown ones. */
  enabled: boolean;
  createdAt: number;
  /** Last successful use, epoch ms. */
  lastUsedAt: number | null;
  // ── Live counters ────────────────────────────────────────────
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
}

/** A key plus its usage, as returned by the admin API. */
export interface ApiKeyView extends Omit<StoredApiKey, 'hash'> {
  totalTokens: number;
  /** True when the key is past its expiry. */
  expired: boolean;
  /** True when any quota is exhausted or the key is disabled. */
  blocked: boolean;
}

/** Result of authenticating an incoming request. */
export type ApiKeyAuthResult = { ok: true; key: ApiKeyView } | { ok: false; status: 401 | 403 | 429; reason: string; code: string };
