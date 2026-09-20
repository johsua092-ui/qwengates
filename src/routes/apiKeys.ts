/**
 * Admin CRUD API for managed API keys.
 *
 * Self-service surface behind the dashboard: create, list, edit, delete and
 * reset keys. Every route is gated by the dashboard session (or the legacy
 * API_KEY bearer token) so only an authenticated operator can manage keys.
 *
 * A created key's plaintext secret is returned exactly once — only its SHA-256
 * hash is stored, so it can never be recovered afterwards.
 */

import type { Context, Hono } from 'hono';
import {
  type CreateApiKeyInput,
  createApiKey,
  deleteApiKey,
  extractBearerToken,
  getApiKeyById,
  listApiKeys,
  resetApiKeyUsage,
  type UpdateApiKeyInput,
  updateApiKey,
} from '../services/apiKeyStore.ts';
import { config } from '../services/configService.ts';
import { isAuthenticated } from '../services/dashboardAuth.ts';
import { safeCompare } from '../utils/auth.ts';

/**
 * Gate for key-management endpoints.
 *
 * Fail-CLOSED: a request must carry a valid browser session OR a bearer token
 * that actually matches the configured API_KEY. Note this deliberately does NOT
 * use `checkApiKeyAuth`, which returns "authorized" when API_KEY is unset —
 * correct for a localhost-only dashboard, but wrong for an endpoint that can
 * mint credentials. Unset API_KEY simply means the bearer path is unusable.
 */
function requireAdmin(c: Context, next: () => Promise<void>) {
  if (isAuthenticated(c)) return next();

  const configured = config.get('API_KEY');
  const presented = extractBearerToken(c.req.header('authorization'));
  if (configured && presented && safeCompare(presented, configured)) return next();

  return c.json({ error: 'Unauthorized' }, 401);
}

/**
 * Parse an optional integer limit from arbitrary JSON input.
 *
 * Accepts `null`, `''`, and `undefined` as "no limit". Rejects anything that is
 * not a non-negative integer so typos surface as 400 instead of a silent 0
 * (which would block the key entirely).
 */
function parseLimit(raw: unknown, field: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { ok: false, error: `${field} harus angka bulat >= 0, atau kosong buat unlimited` };
  }
  return { ok: true, value: n };
}

/** Parse an optional epoch-ms expiry from a date string, ISO string, or number. */
function parseExpiry(raw: unknown, field: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: `${field} harus tanggal yang valid` };
    return { ok: true, value: raw };
  }
  const text = String(raw).trim();
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return { ok: false, error: `${field} bukan tanggal yang valid` };
  return { ok: true, value: ms };
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate and normalize a create payload. */
function parseCreate(body: any): ParseResult<CreateApiKeyInput> {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'name wajib diisi' };
  if (name.length > 120) return { ok: false, error: 'name maksimal 120 karakter' };

  const rpm = parseLimit(body?.rpm, 'rpm');
  if (!rpm.ok) return rpm;
  const maxRequests = parseLimit(body?.maxRequests, 'maxRequests');
  if (!maxRequests.ok) return maxRequests;
  const maxTokens = parseLimit(body?.maxTokens, 'maxTokens');
  if (!maxTokens.ok) return maxTokens;
  const expiresAt = parseExpiry(body?.expiresAt, 'expiresAt');
  if (!expiresAt.ok) return expiresAt;

  return {
    ok: true,
    value: {
      name,
      rpm: rpm.value,
      maxRequests: maxRequests.value,
      maxTokens: maxTokens.value,
      expiresAt: expiresAt.value,
    },
  };
}

/** Validate and normalize an update payload; only present fields are applied. */
function parseUpdate(body: any): ParseResult<UpdateApiKeyInput> {
  const patch: UpdateApiKeyInput = {};

  if (body && 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, error: 'name nggak boleh kosong' };
    if (name.length > 120) return { ok: false, error: 'name maksimal 120 karakter' };
    patch.name = name;
  }

  for (const [field, key] of [
    ['rpm', 'rpm'],
    ['maxRequests', 'maxRequests'],
    ['maxTokens', 'maxTokens'],
  ] as const) {
    if (body && field in body) {
      const parsed = parseLimit(body[field], field);
      if (!parsed.ok) return parsed;
      (patch as any)[key] = parsed.value;
    }
  }

  if (body && 'expiresAt' in body) {
    const parsed = parseExpiry(body.expiresAt, 'expiresAt');
    if (!parsed.ok) return parsed;
    patch.expiresAt = parsed.value;
  }

  if (body && 'enabled' in body) {
    if (typeof body.enabled !== 'boolean') return { ok: false, error: 'enabled harus boolean' };
    patch.enabled = body.enabled;
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: 'nggak ada field yang diubah' };
  return { ok: true, value: patch };
}

/** Register the key-management routes on the app. */
export function registerApiKeyRoutes(app: Hono): void {
  // List all keys, with usage and derived status.
  app.get(
    '/api/keys',
    async (c, next) => requireAdmin(c, next),
    (c) => {
      return c.json({ keys: listApiKeys() });
    },
  );

  // Create a key. The plaintext `secret` is returned only in this response.
  app.post(
    '/api/keys',
    async (c, next) => requireAdmin(c, next),
    async (c) => {
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'body harus JSON' }, 400);
      }

      const parsed = parseCreate(body);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);

      try {
        const { key, secret } = createApiKey(parsed.value);
        return c.json({ key, secret }, 201);
      } catch (err: any) {
        return c.json({ error: err?.message || 'gagal bikin key' }, 500);
      }
    },
  );

  // Read a single key.
  app.get(
    '/api/keys/:id',
    async (c, next) => requireAdmin(c, next),
    (c) => {
      const key = getApiKeyById(c.req.param('id'));
      if (!key) return c.json({ error: 'key nggak ketemu' }, 404);
      return c.json({ key });
    },
  );

  // Update limits, expiry, name, or enabled state.
  app.patch(
    '/api/keys/:id',
    async (c, next) => requireAdmin(c, next),
    async (c) => {
      const id = c.req.param('id');
      if (!getApiKeyById(id)) return c.json({ error: 'key nggak ketemu' }, 404);

      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'body harus JSON' }, 400);
      }

      const parsed = parseUpdate(body);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);

      try {
        const key = updateApiKey(id, parsed.value);
        if (!key) return c.json({ error: 'key nggak ketemu' }, 404);
        return c.json({ key });
      } catch (err: any) {
        return c.json({ error: err?.message || 'gagal update key' }, 500);
      }
    },
  );

  // Reset the request/token counters. The key itself stays live.
  app.post(
    '/api/keys/:id/reset',
    async (c, next) => requireAdmin(c, next),
    (c) => {
      const key = resetApiKeyUsage(c.req.param('id'));
      if (!key) return c.json({ error: 'key nggak ketemu' }, 404);
      return c.json({ key });
    },
  );

  // Delete a key permanently.
  app.delete(
    '/api/keys/:id',
    async (c, next) => requireAdmin(c, next),
    (c) => {
      const removed = deleteApiKey(c.req.param('id'));
      if (!removed) return c.json({ error: 'key nggak ketemu' }, 404);
      return c.json({ ok: true });
    },
  );
}
