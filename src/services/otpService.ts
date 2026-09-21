/**
 * Local OTP Service
 * In-memory storage & retriever for email verification codes (catch-all / webhook).
 * Pure local — zero 3rd party dependencies.
 */

export interface OtpEntry {
  email: string;
  otp: string;
  receivedAt: number;
  expiresAt: number;
  source?: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const otpMap = new Map<string, OtpEntry>();

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Extract 6-digit (or 4-8 digit) OTP code from email text or subject.
 */
export function extractOtpFromText(text: string): string | null {
  if (!text) return null;

  // Patterns common in Qwen / Alibaba verification emails:
  // e.g. "Your verification code is: 123456", "验证码：123456", "code: 123456"
  const patterns = [
    /(?:verification\s*code|security\s*code|code|验证码)[^\d]{0,20}(\b\d{6}\b)/i,
    /(?:is|为)[^\d]{0,10}(\b\d{6}\b)/i,
    /\b(\d{6})\b/, // Fallback: any 6-digit standalone number
    /\b(\d{4,8})\b/, // Fallback: 4 to 8 digit code
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Store an OTP for a given email address.
 */
export function storeOtp(email: string, otp: string, source = 'webhook', ttlMs = DEFAULT_TTL_MS): OtpEntry {
  const norm = normalizeEmail(email);
  const now = Date.now();
  const entry: OtpEntry = {
    email: norm,
    otp: otp.trim(),
    receivedAt: now,
    expiresAt: now + ttlMs,
    source,
  };

  otpMap.set(norm, entry);
  cleanupExpired();
  return entry;
}

/**
 * Get stored OTP for an email (if not expired).
 */
export function getOtp(email: string): string | null {
  const norm = normalizeEmail(email);
  const entry = otpMap.get(norm);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    otpMap.delete(norm);
    return null;
  }

  return entry.otp;
}

/**
 * Clear stored OTP for an email.
 */
export function clearOtp(email: string): boolean {
  const norm = normalizeEmail(email);
  return otpMap.delete(norm);
}

/**
 * Wait / long-poll for OTP to arrive for an email.
 */
export async function waitForOtp(
  email: string,
  timeoutMs = 60000,
  pollIntervalMs = 1500,
): Promise<string | null> {
  const norm = normalizeEmail(email);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const otp = getOtp(norm);
    if (otp) return otp;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return null;
}

/**
 * Get all active OTP entries (for debugging/admin).
 */
export function getAllActiveOtps(): OtpEntry[] {
  cleanupExpired();
  return Array.from(otpMap.values());
}

/**
 * Cleanup expired OTP entries.
 */
function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, entry] of otpMap.entries()) {
    if (now > entry.expiresAt) {
      otpMap.delete(key);
    }
  }
}
