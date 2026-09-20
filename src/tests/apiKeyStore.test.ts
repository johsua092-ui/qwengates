/**
 * Regression tests for the SaaS API-key store + quota enforcement.
 *
 * Covers the surface an operator exposes to themselves: multi-key CRUD,
 * request/token quotas, per-key RPM, expiry, enable/disable and usage reset.
 * Runs against an isolated DB dir so the real one is untouched.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DB_DIR = mkdtempSync(join(tmpdir(), 'qg-keys-test-'));
process.env.QWENGATE_DB_DIR = TMP_DB_DIR;

import {
  authenticateApiKey,
  closeApiKeyStore,
  createApiKey,
  deleteApiKey,
  extractBearerToken,
  getApiKeyById,
  listApiKeys,
  recordApiKeyUsage,
  resetApiKeyUsage,
  updateApiKey,
} from '../services/apiKeyStore.ts';

afterAll(() => {
  closeApiKeyStore();
  try {
    rmSync(TMP_DB_DIR, { recursive: true, force: true });
  } catch {}
});

/** Create a key and flatten it so tests read naturally. */
function makeKey(overrides: Record<string, unknown> = {}) {
  const { key, secret } = createApiKey({ name: 'test-key', ...overrides });
  return { key, secret };
}

/** Record one request with token split, mirroring a real completion. */
function use(keyId: string, prompt = 0, completion = 0) {
  recordApiKeyUsage(keyId, prompt, completion);
}

// ── create ───────────────────────────────────────────────────────────
describe('createApiKey', () => {
  test('creates a key with a one-time secret', () => {
    const { key, secret } = makeKey({ name: 'create-me' });
    expect(secret).toBeTruthy();
    expect(secret.length).toBeGreaterThan(20);
    expect(key.name).toBe('create-me');
    expect(key.enabled).toBe(true);
    expect(key.requestCount).toBe(0);
    expect(key.totalTokens).toBe(0);
    expect(key.expired).toBe(false);
    expect(key.blocked).toBe(false);
  });

  test('secret is not retrievable after creation', () => {
    const { key, secret } = makeKey({ name: 'secret-check' });
    const fetched = getApiKeyById(key.id);
    expect(JSON.stringify(fetched)).not.toContain(secret);
    expect(listApiKeys().some((k: unknown) => JSON.stringify(k).includes(secret))).toBe(false);
  });

  test('two keys have different secrets and ids', () => {
    const a = makeKey({ name: 'a' });
    const b = makeKey({ name: 'b' });
    expect(a.secret).not.toBe(b.secret);
    expect(a.key.id).not.toBe(b.key.id);
  });
});

// ── authenticate ─────────────────────────────────────────────────────
describe('authenticateApiKey', () => {
  test('valid secret authenticates', () => {
    const { secret } = makeKey({ name: 'auth-ok' });
    expect(authenticateApiKey(secret).ok).toBe(true);
  });

  test('wrong secret rejected with 401', () => {
    makeKey({ name: 'auth-bad' });
    const result = authenticateApiKey('qg_definitely-not-real');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe('invalid_key');
    }
  });

  test('empty secret rejected differently from invalid key', () => {
    const result = authenticateApiKey('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('missing_key');
  });

  test('unknown but well-formed key rejected', () => {
    const result = authenticateApiKey('qg_' + 'x'.repeat(40));
    expect(result.ok).toBe(false);
  });
});

// ── request quota ────────────────────────────────────────────────────
describe('request quota', () => {
  test('blocks once maxRequests is reached', () => {
    const { key, secret } = makeKey({ name: 'req-quota', maxRequests: 2 });

    expect(authenticateApiKey(secret).ok).toBe(true);
    use(key.id, 1, 1);

    expect(authenticateApiKey(secret).ok).toBe(true);
    use(key.id, 1, 1);

    const third = authenticateApiKey(secret);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.status).toBe(429);
      expect(third.code).toBe('quota_requests');
    }
    expect(getApiKeyById(key.id)?.requestCount).toBe(2);
  });

  test('unlimited when maxRequests is null', () => {
    const { key, secret } = makeKey({ name: 'req-unlimited', maxRequests: null });
    for (let i = 0; i < 5; i++) use(key.id, 1, 0);
    expect(authenticateApiKey(secret).ok).toBe(true);
  });

  test('view reports blocked=true when quota is spent', () => {
    const { key } = makeKey({ name: 'req-blocked-view', maxRequests: 1 });
    use(key.id, 0, 0);
    const view = getApiKeyById(key.id);
    expect(view?.blocked).toBe(true);
    expect(view?.requestCount).toBe(1);
  });
});

// ── token quota ──────────────────────────────────────────────────────
describe('token quota', () => {
  test('blocks once maxTokens is reached', () => {
    const { key, secret } = makeKey({ name: 'tok-quota', maxTokens: 100 });
    use(key.id, 60, 50);

    const after = authenticateApiKey(secret);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe('quota_tokens');
    expect(getApiKeyById(key.id)?.totalTokens).toBe(110);
  });

  test('still allowed while under maxTokens', () => {
    const { key, secret } = makeKey({ name: 'tok-under', maxTokens: 100 });
    use(key.id, 30, 20);
    expect(authenticateApiKey(secret).ok).toBe(true);
  });

  test('prompt and completion both count', () => {
    const { key } = makeKey({ name: 'tok-both', maxTokens: null });
    use(key.id, 10, 15);
    const view = getApiKeyById(key.id);
    expect(view?.totalTokens).toBe(25);
  });
});

// ── expiry ───────────────────────────────────────────────────────────
describe('expiry', () => {
  test('expired key is rejected with 403', () => {
    const { key, secret } = makeKey({ name: 'expired', expiresAt: Date.now() - 1000 });
    const result = authenticateApiKey(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe('key_expired');
    }
    expect(getApiKeyById(key.id)?.expired).toBe(true);
  });

  test('future expiry is accepted', () => {
    const { secret } = makeKey({ name: 'not-yet', expiresAt: Date.now() + 60_000 });
    expect(authenticateApiKey(secret).ok).toBe(true);
  });

  test('null expiry never expires', () => {
    const { secret } = makeKey({ name: 'forever', expiresAt: null });
    expect(authenticateApiKey(secret).ok).toBe(true);
  });
});

// ── enable/disable ───────────────────────────────────────────────────
describe('enabled flag', () => {
  test('disabled key is rejected with 403', () => {
    const { key, secret } = makeKey({ name: 'disable-me' });
    updateApiKey(key.id, { enabled: false });
    const result = authenticateApiKey(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe('key_disabled');
    }
  });

  test('re-enabled key works again', () => {
    const { key, secret } = makeKey({ name: 'reenable-me' });
    updateApiKey(key.id, { enabled: false });
    updateApiKey(key.id, { enabled: true });
    expect(authenticateApiKey(secret).ok).toBe(true);
  });
});

// ── RPM ──────────────────────────────────────────────────────────────
describe('per-key RPM', () => {
  test('rate limits after rpm requests in the window', () => {
    const { key, secret } = makeKey({ name: 'rpm-key', rpm: 3 });
    for (let i = 0; i < 3; i++) {
      expect(authenticateApiKey(secret).ok).toBe(true);
      use(key.id, 0, 0);
    }
    const limited = authenticateApiKey(secret);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.status).toBe(429);
      expect(limited.code.startsWith('rate_limited_')).toBe(true);
    }
  });

  test('null rpm means unlimited even at high volume', () => {
    const { key, secret } = makeKey({ name: 'rpm-unlimited', rpm: null });
    for (let i = 0; i < 10; i++) {
      expect(authenticateApiKey(secret).ok).toBe(true);
      use(key.id, 0, 0);
    }
  });

  test('raising rpm unblocks a rate-limited key', () => {
    const { key, secret } = makeKey({ name: 'rpm-raise', rpm: 1 });
    authenticateApiKey(secret);
    use(key.id, 0, 0);
    expect(authenticateApiKey(secret).ok).toBe(false);

    updateApiKey(key.id, { rpm: 100 });
    expect(authenticateApiKey(secret).ok).toBe(true);
  });
});

// ── reset usage ──────────────────────────────────────────────────────
describe('resetApiKeyUsage', () => {
  test('zeroes counters and revives a quota-blocked key', () => {
    const { key, secret } = makeKey({ name: 'reset-me', maxRequests: 1 });
    use(key.id, 5, 5);
    expect(authenticateApiKey(secret).ok).toBe(false);

    resetApiKeyUsage(key.id);

    const after = getApiKeyById(key.id);
    expect(after?.requestCount).toBe(0);
    expect(after?.totalTokens).toBe(0);
    expect(after?.blocked).toBe(false);
    expect(authenticateApiKey(secret).ok).toBe(true);
  });

  test('key stays alive after reset', () => {
    const { key, secret } = makeKey({ name: 'still-alive' });
    use(key.id, 0, 0);
    resetApiKeyUsage(key.id);
    expect(authenticateApiKey(secret).ok).toBe(true);
    expect(getApiKeyById(key.id)).toBeTruthy();
  });

  test('reset does not touch other keys', () => {
    const a = makeKey({ name: 'reset-a', maxRequests: 1 });
    const b = makeKey({ name: 'reset-b', maxRequests: 1 });
    use(a.key.id, 0, 0);
    use(b.key.id, 0, 0);

    resetApiKeyUsage(a.key.id);

    expect(getApiKeyById(a.key.id)?.requestCount).toBe(0);
    expect(getApiKeyById(b.key.id)?.requestCount).toBe(1);
  });
});

// ── update ───────────────────────────────────────────────────────────
describe('updateApiKey', () => {
  test('can raise limits to unblock', () => {
    const { key, secret } = makeKey({ name: 'raise-limit', maxRequests: 1 });
    use(key.id, 0, 0);
    expect(authenticateApiKey(secret).ok).toBe(false);

    updateApiKey(key.id, { maxRequests: 10 });
    expect(authenticateApiKey(secret).ok).toBe(true);
  });

  test('can change rpm / name / expiry', () => {
    const { key } = makeKey({ name: 'edit-me' });
    const future = Date.now() + 86_400_000;
    updateApiKey(key.id, { name: 'edited', rpm: 42, maxTokens: 5000, expiresAt: future });

    const after = getApiKeyById(key.id);
    expect(after?.name).toBe('edited');
    expect(after?.rpm).toBe(42);
    expect(after?.maxTokens).toBe(5000);
    expect(after?.expiresAt).toBe(future);
  });

  test('can clear limits back to unlimited', () => {
    const { key } = makeKey({ name: 'clear-limits', rpm: 5, maxRequests: 5, maxTokens: 5 });
    updateApiKey(key.id, { rpm: null, maxRequests: null, maxTokens: null });
    const after = getApiKeyById(key.id);
    expect(after?.rpm).toBeNull();
    expect(after?.maxRequests).toBeNull();
    expect(after?.maxTokens).toBeNull();
    expect(after?.blocked).toBe(false);
  });

  test('unknown id returns null', () => {
    expect(updateApiKey('no-such-id', { name: 'x' })).toBeNull();
  });
});

// ── delete ───────────────────────────────────────────────────────────
describe('deleteApiKey', () => {
  test('deleted key can no longer authenticate', () => {
    const { key, secret } = makeKey({ name: 'delete-me' });
    expect(authenticateApiKey(secret).ok).toBe(true);

    expect(deleteApiKey(key.id)).toBe(true);

    expect(authenticateApiKey(secret).ok).toBe(false);
    expect(getApiKeyById(key.id)).toBeNull();
  });

  test('deleting one key leaves others working', () => {
    const a = makeKey({ name: 'keep-me' });
    const b = makeKey({ name: 'remove-me' });
    deleteApiKey(b.key.id);
    expect(authenticateApiKey(a.secret).ok).toBe(true);
  });

  test('deleting a missing key reports false', () => {
    expect(deleteApiKey('no-such-id')).toBe(false);
  });
});

// ── list ─────────────────────────────────────────────────────────────
describe('listApiKeys', () => {
  test('never exposes hash or secret material', () => {
    const { secret } = makeKey({ name: 'no-leak' });
    const payload = JSON.stringify(listApiKeys());
    expect(payload).not.toContain(secret);
    expect(payload).not.toContain('"hash"');
  });

  test('returns every key created', () => {
    const before = listApiKeys().length;
    makeKey({ name: 'count-1' });
    makeKey({ name: 'count-2' });
    expect(listApiKeys().length).toBe(before + 2);
  });
});

// ── bearer parsing ───────────────────────────────────────────────────
describe('extractBearerToken', () => {
  test('parses a well-formed header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  test('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
  });

  test('returns null for malformed input', () => {
    expect(extractBearerToken('abc123')).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});
