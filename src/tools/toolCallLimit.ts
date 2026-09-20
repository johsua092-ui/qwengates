/**
 * Parsing for MAX_TOOL_CALLS_PER_RESPONSE.
 *
 * The env value is deliberately permissive because it is hand-edited:
 *
 *   "5"                       -> 5    (explicit cap)
 *   "0"                       -> null (unlimited; 0 is the documented off-switch)
 *   "unlimited"/"none"/"infinity" -> null (explicit aliases)
 *   ""/"abc"/"-1"/"2.5"       -> fallback (never silently reinterpret a typo)
 *
 * Returning `null` means "no limit". Callers treat that as off, so a malformed
 * value can never accidentally disable or clamp tool calling.
 */
const UNLIMITED_ALIASES = new Set(['unlimited', 'none', 'infinity']);

export function parseToolCallLimit(raw: string | undefined | null, fallback: number): number | null {
  if (raw === undefined || raw === null) return fallback;

  const trimmed = raw.trim();
  if (trimmed === '') return fallback;

  if (UNLIMITED_ALIASES.has(trimmed.toLowerCase())) return null;

  // Strict integer only: reject "2.5", "5px", "1e3" rather than truncating them.
  if (!/^-?\d+$/.test(trimmed)) return fallback;

  const value = Number.parseInt(trimmed, 10);

  // 0 is the documented off-switch ("unlimited").
  if (value === 0) return null;

  // Negative values are a typo, not a cap and not an off-switch — fall back.
  if (value < 0) return fallback;

  return value;
}
