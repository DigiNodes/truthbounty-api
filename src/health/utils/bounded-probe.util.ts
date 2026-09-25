/**
 * Bounded probe helpers for health/readiness checks.
 *
 * Every dependency probe must be time-boxed (a hung connection must not hang
 * the readiness endpoint) and must never leak raw driver/error text, which
 * can contain connection strings, credentials, or internal hostnames.
 */

export class ProbeTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Probe "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'ProbeTimeoutError';
  }
}

/**
 * Race a probe against a timeout. Fails closed: a probe that neither
 * resolves nor rejects within `timeoutMs` is treated as unhealthy.
 */
export async function withTimeout<T>(
  name: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(name, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export type FailureReasonCode =
  | 'TIMEOUT'
  | 'CONNECTION_ERROR'
  | 'THRESHOLD_EXCEEDED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

const SECRET_LIKE_PATTERNS: RegExp[] = [
  // scheme://user:pass@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@[^\s]+/gi,
  // key=value pairs commonly holding secrets
  /\b(password|passwd|pwd|secret|token|apikey|api_key|authorization)\s*[=:]\s*\S+/gi,
  // bare connection strings
  /\bpostgres(?:ql)?:\/\/\S+/gi,
  /\bredis:\/\/\S+/gi,
];

const MAX_REASON_LENGTH = 160;

/**
 * Reduce an error to a short, secret-free reason code + message safe for a
 * public health endpoint. Never returns raw driver/stack output.
 */
export function classifyFailure(error: unknown): {
  reasonCode: FailureReasonCode;
  reason: string;
} {
  if (error instanceof ProbeTimeoutError) {
    return { reasonCode: 'TIMEOUT', reason: 'Dependency check exceeded time budget' };
  }

  const message = error instanceof Error ? error.message : String(error ?? 'Unknown failure');
  let sanitized = message;
  for (const pattern of SECRET_LIKE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted]');
  }
  sanitized = sanitized.slice(0, MAX_REASON_LENGTH);

  const lower = message.toLowerCase();
  let reasonCode: FailureReasonCode = 'UNKNOWN';
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('not initialized') ||
    lower.includes('not connected')
  ) {
    reasonCode = 'CONNECTION_ERROR';
  } else if (lower.includes('threshold') || lower.includes('exceeds') || lower.includes('degraded')) {
    reasonCode = 'THRESHOLD_EXCEEDED';
  } else if (lower.includes('unavailable')) {
    reasonCode = 'UNAVAILABLE';
  }

  return { reasonCode, reason: sanitized || 'Unknown failure' };
}
