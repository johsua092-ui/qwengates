/**
 * Dashboard password login (minimal SaaS gate).
 *
 * One shared password, exchanged for a signed HttpOnly session cookie. No users
 * table, no OAuth — this is the first gate, not the final auth system.
 *
 * Resolution order for the password (first non-empty wins):
 *   1. `DASHBOARD_PASSWORD` from config/env — an operator override that always
 *      wins, so a forgotten Settings password can be recovered from the env.
 *   2. The password saved from the Settings page.
 *   3. The built-in fallback `changeme`.
 *
 * Stored passwords are scrypt-hashed with a per-password salt, so a leaked
 * `qwengate.db` does not hand over the dashboard. Comparison is constant-time.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectPath } from '../utils/paths.ts';
import { config } from './configService.ts';

/** Fallback password used when neither env nor Settings provides one. */
export const FALLBACK_PASSWORD = 'changeme';

/** Cookie name holding the session token. */
export const SESSION_COOKIE = 'qg_session';

/** Path of the login page. */
export const LOGIN_PATH = '/login';

const DB_FILE = projectPath('.qwen', 'qwengate.db');

/** scrypt cost parameters. N=16384 is the Node default and is fast enough here. */
const SCRYPT_KEYLEN = 64;

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

/** Test seam: close and forget the handle so a fresh DB can be opened. */
export function closeDashboardAuthStore(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Password hashing ───────────────────────────────────────────────

/** Hash a password as `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time verification against a stored `scrypt$salt$hash` string. */
function verifyHashed(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── Settings-backed password ───────────────────────────────────────

const PASSWORD_KEY = 'dashboard_password_hash';

/** Read the stored hash, or null when Settings has never set a password. */
function readStoredHash(): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM dashboard_settings WHERE key = ?').get(PASSWORD_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Which password source is currently authoritative.
 * Useful for the Settings UI so it can tell the operator that their saved
 * password is being shadowed by an env override.
 */
export function activePasswordSource(): 'env' | 'settings' | 'fallback' {
  if ((config.get('DASHBOARD_PASSWORD') || '').length > 0) return 'env';
  if (readStoredHash()) return 'settings';
  return 'fallback';
}

/** True when a password has been saved from the Settings page. */
export function hasStoredPassword(): boolean {
  return readStoredHash() !== null;
}

/**
 * Verify a submitted password against the active source.
 *
 * The env path uses a constant-time compare; the stored path uses scrypt.
 */
export function verifyPassword(submitted: string): boolean {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;

  const fromEnv = config.get('DASHBOARD_PASSWORD') || '';
  if (fromEnv.length > 0) {
    const a = Buffer.from(submitted);
    const b = Buffer.from(fromEnv);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  const stored = readStoredHash();
  if (stored) return verifyHashed(submitted, stored);

  // Fallback: still constant-time against the built-in default.
  const a = Buffer.from(submitted);
  const b = Buffer.from(FALLBACK_PASSWORD);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Change the Settings password.
 *
 * Requires the current password to match first, so a hijacked browser session
 * cannot silently lock the operator out. Also refuses when an env override is
 * active, because the change would have no effect — reporting that is better
 * than pretending it worked.
 */
export function changePassword(current: string, next: string): { ok: true } | { ok: false; status: 400 | 403; error: string } {
  if (activePasswordSource() === 'env') {
    return {
      ok: false,
      status: 403,
      error: 'Password lagi di-override sama DASHBOARD_PASSWORD di .env — hapus dulu kalau mau ganti dari sini',
    };
  }
  if (!verifyPassword(current)) {
    return { ok: false, status: 403, error: 'Password lama salah' };
  }
  if (typeof next !== 'string' || next.length < 4) {
    return { ok: false, status: 400, error: 'Password baru minimal 4 karakter' };
  }
  if (next.length > 200) {
    return { ok: false, status: 400, error: 'Password baru maksimal 200 karakter' };
  }

  try {
    getDb()
      .prepare('INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(PASSWORD_KEY, hashPassword(next));
  } catch (err: any) {
    return { ok: false, status: 400, error: err?.message || 'gagal nyimpen password' };
  }
  return { ok: true };
}

// ── Sessions ───────────────────────────────────────────────────────

/**
 * Signing secret for session cookies.
 *
 * Prefers `DASHBOARD_SESSION_SECRET`; otherwise a stable secret is derived from
 * machine-local material so tokens survive a restart without inventing a config
 * value the operator never asked for.
 */
function sessionSecret(): string {
  const configured = config.get('DASHBOARD_SESSION_SECRET') || '';
  if (configured) return configured;
  return createHash('sha256')
    .update(`qwen-gate-session:${process.env.HOME ?? ''}`)
    .digest('hex');
}

function sessionTtlMs(): number {
  const raw = Number.parseInt(config.get('DASHBOARD_SESSION_TTL_MS') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 7 * 24 * 60 * 60 * 1000;
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

/**
 * Create a signed session token: `<expiry>.<hmac>`.
 * `expiry` is an epoch-ms timestamp, so validation needs no server state.
 */
export function createSessionToken(now = Date.now()): string {
  const expiry = now + sessionTtlMs();
  return `${expiry}.${sign(String(expiry))}`;
}

/** Verify a session token's signature and expiry. */
export function verifySessionToken(token: string): boolean {
  if (typeof token !== 'string') return false;
  const idx = token.indexOf('.');
  if (idx <= 0) return false;

  const expiryText = token.slice(0, idx);
  const provided = token.slice(idx + 1);
  const expiry = Number.parseInt(expiryText, 10);
  if (!Number.isFinite(expiry)) return false;

  const expected = sign(expiryText);
  if (provided.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return false;
  } catch {
    return false;
  }
  return expiry > Date.now();
}

/** Read a cookie value out of a raw `Cookie:` header. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** True when the request carries a valid session cookie. */
export function isAuthenticated(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
  return token ? verifySessionToken(token) : false;
}

/** Build the `Set-Cookie` value that starts a session. */
export function sessionCookie(token: string): string {
  const maxAge = Math.floor(sessionTtlMs() / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Build the `Set-Cookie` value that ends a session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Hono middleware: require a valid session for a page route.
 *
 * Redirects browsers to the login page rather than returning JSON, since these
 * are navigations.
 */
export function requireSessionPage() {
  return async (c: any, next: () => Promise<void>) => {
    if (isAuthenticated(c)) return next();
    return c.redirect(LOGIN_PATH);
  };
}
