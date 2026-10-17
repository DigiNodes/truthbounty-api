import { getRuntimeEnvironment } from '../../config/runtime-config';
export const PUBLIC_STATUS_OPTIONS = Symbol('PUBLIC_STATUS_OPTIONS');

export interface PublicStatusOptions {
  /** Server-side and client cache lifetime of one projection. */
  cacheTtlSeconds: number;
  /** Observations older than this are reported as `stale`. */
  staleAfterSeconds: number;
  /** Optional web frontend URL to probe. Never included in any response. */
  webHealthUrl: string | null;
  webProbeTimeoutMs: number;
  /** Requests allowed per client IP per window. */
  rateLimit: number;
  rateLimitWindowSeconds: number;
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadPublicStatusOptions(
  env: NodeJS.ProcessEnv = getRuntimeEnvironment(),
): PublicStatusOptions {
  return {
    cacheTtlSeconds: positiveInt(
      env.PUBLIC_STATUS_CACHE_TTL_SECONDS,
      15,
      'PUBLIC_STATUS_CACHE_TTL_SECONDS',
    ),
    staleAfterSeconds: positiveInt(
      env.PUBLIC_STATUS_STALE_AFTER_SECONDS,
      120,
      'PUBLIC_STATUS_STALE_AFTER_SECONDS',
    ),
    webHealthUrl: env.PUBLIC_STATUS_WEB_HEALTH_URL || null,
    webProbeTimeoutMs: positiveInt(
      env.PUBLIC_STATUS_WEB_PROBE_TIMEOUT_MS,
      2000,
      'PUBLIC_STATUS_WEB_PROBE_TIMEOUT_MS',
    ),
    rateLimit: positiveInt(
      env.PUBLIC_STATUS_RATE_LIMIT,
      60,
      'PUBLIC_STATUS_RATE_LIMIT',
    ),
    rateLimitWindowSeconds: positiveInt(
      env.PUBLIC_STATUS_RATE_WINDOW_SECONDS,
      60,
      'PUBLIC_STATUS_RATE_WINDOW_SECONDS',
    ),
  };
}
