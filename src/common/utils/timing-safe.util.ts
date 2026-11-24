import { timingSafeEqual } from 'crypto';

/**
 * Canonical generic message for authentication failures.
 * External responses must use this to preserve constant-shape behaviour
 * and avoid user/secret enumeration via distinct messages, codes, or timing.
 */
export const AUTH_GENERIC_FAILURE_MESSAGE = 'Invalid credentials';

/**
 * Compare two buffers in constant time without leaking length via timing
 * or throwing on length mismatch.
 */
export function timingSafeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Dummy comparison of equal-length buffers so a length mismatch
    // costs roughly the same as a full comparison (no early-return oracle).
    try {
      timingSafeEqual(a, a);
    } catch {
      // Fall through — dummy work only.
    }
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Timing-safe UTF-8 string comparison (e.g. challenge messages, nonces).
 */
export function timingSafeEqualUtf8(a: string, b: string): boolean {
  return timingSafeEqualBytes(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Timing-safe hex comparison (e.g. sha256 token hashes).
 * Falls back to UTF-8 comparison for non-hex input without throwing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const hexPattern = /^[0-9a-fA-F]*$/;
  if (!hexPattern.test(a) || !hexPattern.test(b)) {
    return timingSafeEqualUtf8(a, b);
  }
  // Hex strings decode to half the length; still guard length first.
  if (a.length !== b.length) {
    timingSafeEqualUtf8(a, a);
    return false;
  }
  try {
    return timingSafeEqualBytes(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Timing-safe EVM address comparison (case-insensitive, EIP-55 agnostic).
 * Addresses are public identifiers, but constant-time comparison keeps
 * login and wallet-link paths uniform and free of short-circuit oracles.
 */
export function constantTimeAddressEqual(a: string, b: string): boolean {
  return timingSafeEqualUtf8(a.toLowerCase(), b.toLowerCase());
}
