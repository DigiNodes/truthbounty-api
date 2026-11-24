import { createHmac } from 'node:crypto';
import {
  AbuseObservationKind,
  AbuseSurface,
} from './abuse-signals.types';

/**
 * Observation helpers (PREWAVE-BE-086, #681).
 *
 * Two jobs: reduce an arbitrary request to a **low-cardinality route group**
 * (so breadth scoring means "many different things" rather than "many
 * different ids"), and produce salted fingerprints for the few places a
 * payload needs to be compared without being read.
 */

/** Segments that identify a resource rather than a surface. */
const ID_SEGMENT =
  /^(?:0x[a-fA-F0-9]+|\d+|[0-9a-fA-F]{8}-[0-9a-fA-F-]{8,}|\d{4,})$/;

/**
 * Collapses a path into at most two non-identifying segments.
 *
 * `/claims/8f2c.../evidence/12` becomes `claims/evidence`. Anything
 * unrecognized collapses to `root`, so a scanner walking random URLs cannot
 * inflate breadth by inventing paths.
 */
export function routeGroupFor(path: string | undefined | null): string {
  if (typeof path !== 'string' || path === '') return 'root';
  const segments = path
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment !== '' && !ID_SEGMENT.test(segment));
  const group = segments.slice(0, 2).join('/');
  return group === '' ? 'root' : group;
}

/** Maps a route group to the abuse surface that owns it. */
export function surfaceFor(routeGroup: string): AbuseSurface {
  const root = routeGroup.split('/')[0];
  switch (root) {
    case 'auth':
    case 'identity':
      return AbuseSurface.AUTH;
    case 'claims':
    case 'disputes':
    case 'evidence':
    case 'governance':
      return AbuseSurface.CLAIMS;
    case 'support':
      return AbuseSurface.SUPPORT;
    case 'webhooks':
      return AbuseSurface.WEBHOOK;
    case 'realtime':
    case 'stream':
    case 'ai-assistant':
      return AbuseSurface.STREAM;
    case 'search':
      return AbuseSurface.SEARCH;
    case 'admin':
      return AbuseSurface.ADMIN;
    default:
      return AbuseSurface.HTTP;
  }
}

/**
 * Routes that are infrastructure rather than traffic, and must not be able to
 * contribute to a scraping signal. Kept small and explicit so a new route is
 * scored by default rather than silently ignored.
 */
const NON_SUBJECT_ROUTE_GROUPS = new Set([
  'health',
  'metrics',
  'status',
  'admin/queues',
]);

/** Whether an observation from this route group should be scored at all. */
export function isScoredRoute(routeGroup: string): boolean {
  return !NON_SUBJECT_ROUTE_GROUPS.has(routeGroup);
}

/** HTTP method to observation kind. */
export function observationKindFor(
  method: string | undefined,
  routeGroup: string,
  statusCode?: number,
): AbuseObservationKind {
  const upper = (method ?? 'GET').toUpperCase();
  if (routeGroup.split('/')[0] === 'auth' && statusCode && statusCode >= 400) {
    return AbuseObservationKind.AUTH_FAILURE;
  }
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') {
    return AbuseObservationKind.READ;
  }
  if (routeGroup.startsWith('webhooks')) {
    return AbuseObservationKind.WEBHOOK_ENDPOINT_WRITE;
  }
  return AbuseObservationKind.WRITE;
}

/** Salted digest of a value, for comparison without retention. */
export function fingerprint(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex');
}

/**
 * Observation class for an HTTP request.
 *
 * A status code is folded into `outcome` and, for auth routes, into the
 * observation kind, so credential stuffing is visible without inspecting any
 * credential material.
 */
export function observationFromRequest(
  routeGroup: string,
  method: string | undefined,
  statusCode: number | undefined,
  occurredAt: number,
): {
  kind: AbuseObservationKind;
  surface: AbuseSurface;
  routeGroup: string;
  method: string;
  occurredAt: number;
  outcome: 'success' | 'failure';
} {
  const surface = surfaceFor(routeGroup);
  const outcome =
    statusCode !== undefined && statusCode >= 400 ? 'failure' : 'success';
  let kind = observationKindFor(method, routeGroup, statusCode);
  if (surface === AbuseSurface.AUTH && outcome === 'failure') {
    kind = AbuseObservationKind.AUTH_FAILURE;
  }
  if (surface === AbuseSurface.AUTH && outcome === 'success') {
    kind = AbuseObservationKind.AUTH_SUCCESS;
  }
  return {
    kind,
    surface,
    routeGroup,
    method: (method ?? 'GET').toUpperCase(),
    occurredAt,
    outcome,
  };
}