import { getRuntimeEnvironment } from '../../config/runtime-config';
export const PUBLIC_INCIDENT_OPTIONS = Symbol('PUBLIC_INCIDENT_OPTIONS');

export interface PublicIncidentOptions {
  /** Server-side and client cache lifetime of projection (seconds). */
  cacheTtlSeconds: number;
  /** Projections older than this threshold are labelled stale. */
  staleAfterSeconds: number;
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

export function loadPublicIncidentOptions(
  env: NodeJS.ProcessEnv = getRuntimeEnvironment(),
): PublicIncidentOptions {
  return {
    cacheTtlSeconds: positiveInt(
      env.PUBLIC_INCIDENTS_CACHE_TTL_SECONDS,
      15,
      'PUBLIC_INCIDENTS_CACHE_TTL_SECONDS',
    ),
    staleAfterSeconds: positiveInt(
      env.PUBLIC_INCIDENTS_STALE_AFTER_SECONDS,
      120,
      'PUBLIC_INCIDENTS_STALE_AFTER_SECONDS',
    ),
    rateLimit: positiveInt(
      env.PUBLIC_INCIDENTS_RATE_LIMIT,
      60,
      'PUBLIC_INCIDENTS_RATE_LIMIT',
    ),
    rateLimitWindowSeconds: positiveInt(
      env.PUBLIC_INCIDENTS_RATE_WINDOW_SECONDS,
      60,
      'PUBLIC_INCIDENTS_RATE_WINDOW_SECONDS',
    ),
  };
}
