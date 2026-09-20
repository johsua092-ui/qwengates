/**
 * Multi-key API key store, backed by SQLite.
 *
 * Uses `node:sqlite` (available in both Node >=22 and Bun) so no dependency is
 * added and the gateway keeps working under `bun start` and `start:node`.
 *
 * Design notes:
 *  - Secrets are NEVER stored. Only a SHA-256 hash plus a display prefix, so a
 *    leaked/qwengate.db does not hand over working keys.
 *  - Lookups are by hash, which is indexed — the plaintext never hits the DB.
 *  - Counters are incremented in the same transaction as the usage record so a
 *    crash cannot "forget" usage and let a key overshoot its quota.
 *  - Rate limiting is per-minute using a fixed 60s window stored on the row;
 *    this is intentionally simple and dependency-free. It resets lazily on
 *    read, so no timer or background job is required.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ApiKeyAuthResult, ApiKeyView, StoredApiKey } from '../types/apiKey.ts';
import { projectPath } from '../utils/paths.ts';

const DB_FILE = projectPath('.qwen', 'qwengate.db');

/** Window used for the per-minute rate limit. */
const RPM_WINDOW_MS = 60_000;

let db: DatabaseSync | null = null;

/** Per-minute counters, kept in a separate table so resets are a single write. */
interface RateRow {
  key_id: string;
  window_start: number;
  count: number;
}

function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      hash              TEXT NOT NULL UNIQUE,
      prefix            TEXT NOT NULL,
      rpm               INTEGER,
      max_requests      INTEGER,
      max_tokens        INTEGER,
      expires_at        INTEGER,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_at        INTEGER NOT NULL,
      last_used_at      INTEGER,
      request_count     INTEGER NOT NULL DEFAULT 0,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_key_rates (
      key_id       TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

/** Test seam: close and forget the handle so a fresh DB can be opened. */
export function closeApiKeyStore(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Number of managed keys on record. Used to decide whether auth is active. */
export function apiKeyStoreCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number };
  return Number(row.n);
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// ── Hashing / secrets ──────────────────────────────────────────────

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Generate a URL-safe secret. Prefixed with `qg_` so it is recognisable in
 * logs/config and easy to grep for in leak scanners.
 */
function generateSecret(): string {
  return `qg_${randomBytes(24).toString('base64url')}`;
}

/** Constant-time compare of two hex digests. */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Row mapping ────────────────────────────────────────────────────

function rowToStored(row: Record<string, unknown>): StoredApiKey {
  return {
    id: row.id as string,
    name: row.name as string,
    hash: row.hash as string,
    prefix: row.prefix as string,
    rpm: row.rpm === null ? null : Number(row.rpm),
    maxRequests: row.max_requests === null ? null : Number(row.max_requests),
    maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    requestCount: Number(row.request_count),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
  };
}

/** Public projection: strips the hash, adds derived usage/state flags. */
export function toView(k: StoredApiKey): ApiKeyView {
  const { hash: _hash, ...rest } = k;
  const totalTokens = k.promptTokens + k.completionTokens;
  const now = Date.now();
  const expired = k.expiresAt !== null && now >= k.expiresAt;
  const overRequests = k.maxRequests !== null && k.requestCount >= k.maxRequests;
  const overTokens = k.maxTokens !== null && totalTokens >= k.maxTokens;
  return {
    ...rest,
    totalTokens,
    expired,
    blocked: !k.enabled || expired || overRequests || overTokens,
  };
}

// ── CRUD ───────────────────────────────────────────────────────────

export interface CreateApiKeyInput {
  name: string;
  rpm?: number | null;
  maxRequests?: number | null;
  maxTokens?: number | null;
  /** Epoch ms, or `null` for no expiry. */
  expiresAt?: number | null;
}

/**
 * Create a key and return it together with its plaintext secret.
 *
 * This is the ONLY time the secret exists in plaintext — the caller must show
 * it to the user immediately; it cannot be recovered later.
 */
export function createApiKey(input: CreateApiKeyInput): { key: ApiKeyView; secret: string } {
  const d = getDb();
  const secret = generateSecret();
  const id = `key_${randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const prefix = secret.slice(0, 10);

  d.prepare(
    `INSERT INTO api_keys
       (id, name, hash, prefix, rpm, max_requests, max_tokens, expires_at, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    input.name,
    hashSecret(secret),
    prefix,
    input.rpm ?? null,
    input.maxRequests ?? null,
    input.maxTokens ?? null,
    input.expiresAt ?? null,
    now,
  );

  const row = d.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Record<string, unknown>;
  return { key: toView(rowToStored(row)), secret };
}

export function listApiKeys(): ApiKeyView[] {
  const rows = getDb().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map((r) => toView(rowToStored(r)));
}

export function getApiKeyById(id: string): ApiKeyView | null {
  const row = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toView(rowToStored(row)) : null;
}

export interface UpdateApiKeyInput {
  name?: string;
  rpm?: number | null;
  maxRequests?: number | null;
  maxTokens?: number | null;
  expiresAt?: number | null;
  enabled?: boolean;
}

export function updateApiKey(id: string, patch: UpdateApiKeyInput): ApiKeyView | null {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return null;

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  const put = (col: string, val: string | number | null) => {
    sets.push(`${col} = ?`);
    values.push(val);
  };

  if (patch.name !== undefined) put('name', patch.name);
  if (patch.rpm !== undefined) put('rpm', patch.rpm);
  if (patch.maxRequests !== undefined) put('max_requests', patch.maxRequests);
  if (patch.maxTokens !== undefined) put('max_tokens', patch.maxTokens);
  if (patch.expiresAt !== undefined) put('expires_at', patch.expiresAt);
  if (patch.enabled !== undefined) put('enabled', patch.enabled ? 1 : 0);

  if (sets.length > 0) {
    values.push(id);
    d.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  return getApiKeyById(id);
}

export function deleteApiKey(id: string): boolean {
  const d = getDb();
  const info = d.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  d.prepare('DELETE FROM api_key_rates WHERE key_id = ?').run(id);
  return Number(info.changes) > 0;
}

/**
 * Reset a key's counters so it can start a fresh period.
 * Usage history (if ever added) is deliberately untouched.
 */
export function resetApiKeyUsage(id: string): ApiKeyView | null {
  getDb()
    .prepare(
      `UPDATE api_keys
          SET request_count = 0, prompt_tokens = 0, completion_tokens = 0, last_used_at = NULL
        WHERE id = ?`,
    )
    .run(id);
  return getApiKeyById(id);
}

// ── Authentication ─────────────────────────────────────────────────

/**
 * Authenticate a presented secret and enforce expiry/quotas.
 *
 * Returns a discriminated result so the caller can send the right status:
 *   401 unknown/invalid key, 403 disabled/expired, 429 over quota.
 *
 * NOTE: `RPM` is checked here but CONSUMED by `recordApiKeyUsage`, so a request
 * is only counted once it actually reaches the model.
 */
export function authenticateApiKey(presented: string): ApiKeyAuthResult {
  if (!presented) return { ok: false, status: 401, reason: 'Missing API key', code: 'missing_key' };

  const d = getDb();
  const hash = hashSecret(presented);
  const row = d.prepare('SELECT * FROM api_keys WHERE hash = ?').get(hash) as Record<string, unknown> | undefined;

  if (!row) {
    // Do not reveal whether the key exists.
    return { ok: false, status: 401, reason: 'Invalid API key', code: 'invalid_key' };
  }

  const stored = rowToStored(row);
  // Defence in depth: the indexed lookup already matched, but a timing-safe
  // compare here keeps the code honest if the query ever changes.
  if (!hashesEqual(stored.hash, hash)) {
    return { ok: false, status: 401, reason: 'Invalid API key', code: 'invalid_key' };
  }

  if (!stored.enabled) {
    return { ok: false, status: 403, reason: 'API key is disabled', code: 'key_disabled' };
  }

  if (stored.expiresAt !== null && Date.now() >= stored.expiresAt) {
    return { ok: false, status: 403, reason: 'API key has expired', code: 'key_expired' };
  }

  const view = toView(stored);

  if (stored.maxRequests !== null && stored.requestCount >= stored.maxRequests) {
    return { ok: false, status: 429, reason: 'Request quota exhausted', code: 'quota_requests' };
  }

  const totalTokens = stored.promptTokens + stored.completionTokens;
  if (stored.maxTokens !== null && totalTokens >= stored.maxTokens) {
    return { ok: false, status: 429, reason: 'Token quota exhausted', code: 'quota_tokens' };
  }

  if (stored.rpm !== null) {
    const rate = d.prepare('SELECT * FROM api_key_rates WHERE key_id = ?').get(stored.id) as RateRow | undefined;
    const now = Date.now();
    if (rate && now - Number(rate.window_start) < RPM_WINDOW_MS && Number(rate.count) >= stored.rpm) {
      const retryAfter = Math.ceil((RPM_WINDOW_MS - (now - Number(rate.window_start))) / 1000);
      return {
        ok: false,
        status: 429,
        reason: `Rate limit exceeded: ${stored.rpm} requests per minute`,
        code: `rate_limited_${retryAfter}`,
      };
    }
  }

  return { ok: true, key: view };
}

/**
 * Record a completed request against a key: bumps the lifetime counters and the
 * minute-window counter in one transaction.
 */
export function recordApiKeyUsage(keyId: string, promptTokens: number, completionTokens: number): void {
  const d = getDb();
  const now = Date.now();
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(
      `UPDATE api_keys
          SET request_count     = request_count + 1,
              prompt_tokens     = prompt_tokens + ?,
              completion_tokens = completion_tokens + ?,
              last_used_at      = ?
        WHERE id = ?`,
    ).run(Math.max(0, Math.floor(promptTokens)), Math.max(0, Math.floor(completionTokens)), now, keyId);

    const rate = d.prepare('SELECT * FROM api_key_rates WHERE key_id = ?').get(keyId) as RateRow | undefined;
    if (!rate || now - Number(rate.window_start) >= RPM_WINDOW_MS) {
      d.prepare(
        `INSERT INTO api_key_rates (key_id, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key_id) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      ).run(keyId, now);
    } else {
      d.prepare('UPDATE api_key_rates SET count = count + 1 WHERE key_id = ?').run(keyId);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Remaining allowance for display; `null` where the limit is unlimited. */
export function getApiKeyUsage(keyId: string): {
  requestsRemaining: number | null;
  tokensRemaining: number | null;
} | null {
  const view = getApiKeyById(keyId);
  if (!view) return null;
  return {
    requestsRemaining: view.maxRequests === null ? null : Math.max(0, view.maxRequests - view.requestCount),
    tokensRemaining: view.maxTokens === null ? null : Math.max(0, view.maxTokens - view.totalTokens),
  };
}
