// @ts-nocheck
/**
 * @file authorization-matrix.ts
 * @description Canonical API Authorization Matrix for TruthBounty V2 backend.
 *
 * DESIGN INVARIANTS
 * ─────────────────
 * 1. Chain-derived state (Optimism/EVM contracts + canonical events) is authoritative.
 *    The API NEVER invents, mutates, or overrides protocol truth.
 * 2. Authorization fails CLOSED — any uncertainty (missing user, missing role,
 *    misconfigured guard, degraded dependency) must deny access, never silently permit.
 * 3. Two independent identity planes:
 *    - App-User plane  : wallet-authenticated users tracked in Prisma (SQLite/PostgreSQL).
 *      Roles: contributor | moderator | admin  (UserRole enum from Prisma schema)
 *    - Admin plane     : operator principals tracked in TypeORM admin_users table.
 *      Roles: super_admin > administrator > security_analyst = governance_operator > moderator > auditor
 * 4. TypeORM is the ONLY ORM for domain persistence (PostgreSQL). Prisma manages the
 *    auth-adjacent user/wallet models (SQLite in dev, PostgreSQL-compatible in prod).
 *    No second domain ORM is introduced.
 * 5. This file is the machine-readable source of truth for route-level authorization.
 *    Any change to guards or decorators must be reflected here.
 *
 * ROUTE AUTHORIZATION TABLE
 * ──────────────────────────────────────────────────────────────────────────────────
 * Notation:
 *   PUBLIC    — no authentication required
 *   AUTHN     — valid JWT required (any authenticated user)
 *   ROLE(x)   — JWT + Prisma UserRole ∈ x  (app-user plane)
 *   ADMIN(x)  — JWT + AdminGuard (DB lookup) + AdminRoleHierarchy ≥ x  (admin plane)
 *   SERVICE   — x-service-api-key header (service-to-service only)
 *
 * ┌─────────────────────────────────────────────────┬──────────────────────────────────────────┐
 * │ Route                                           │ Authorization                            │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ POST   /auth/challenge                          │ PUBLIC + rate-limited                    │
 * │ POST   /auth/login                              │ PUBLIC + rate-limited                    │
 * │ POST   /auth/refresh                            │ PUBLIC + rate-limited                    │
 * │ GET    /auth/health                             │ PUBLIC                                   │
 * │ POST   /auth/logout                             │ AUTHN                                    │
 * │ GET    /auth/profile                            │ AUTHN                                    │
 * │ DELETE /auth/sessions/:address                  │ AUTHN + AdminOnly (env-list gate)        │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /claims/latest                           │ PUBLIC                                   │
 * │ GET    /claims/user/:wallet                     │ PUBLIC                                   │
 * │ GET    /claims/:id                              │ PUBLIC                                   │
 * │ POST   /claims                                  │ AUTHN (any authenticated user)           │
 * │ POST   /claims/:claimId/evidence                │ AUTHN (any authenticated user)           │
 * │ PUT    /claims/evidence/:evidenceId             │ AUTHN (any authenticated user)           │
 * │ GET    /claims/:claimId/evidence                │ PUBLIC                                   │
 * │ GET    /claims/:claimId/evidence/latest         │ PUBLIC                                   │
 * │ GET    /claims/evidence/:evidenceId             │ PUBLIC                                   │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ POST   /disputes                                │ AUTHN (any authenticated user)           │
 * │ PATCH  /disputes/:id/start-review               │ ROLE(moderator,admin)                    │
 * │ PATCH  /disputes/:id/resolve                    │ ROLE(moderator,admin)                    │
 * │ PATCH  /disputes/:id/reject                     │ ROLE(moderator,admin)                    │
 * │ GET    /disputes/claim/:claimId                 │ PUBLIC                                   │
 * │ GET    /disputes/expired                        │ PUBLIC                                   │
 * │ GET    /disputes                                │ PUBLIC                                   │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /rewards                                 │ PUBLIC                                   │
 * │ GET    /rewards/:id                             │ PUBLIC                                   │
 * │ POST   /rewards                                 │ ROLE(admin)                              │
 * │ PATCH  /rewards/:id                             │ ROLE(admin)                              │
 * │ DELETE /rewards/:id                             │ ROLE(admin)                              │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /staking/projects/:claimId/entitlement   │ PUBLIC                                   │
 * │ GET    /staking/projects/:claimId/stake         │ PUBLIC                                   │
 * │ POST   /staking/projects/:claimId/locks         │ AUTHN (any authenticated user)           │
 * │ POST   /staking/projects/:claimId/withdrawals   │ AUTHN (any authenticated user)           │
 * │ POST   /staking/projects/:claimId/reconcile     │ ROLE(admin)                              │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /governance/proposals                    │ PUBLIC                                   │
 * │ GET    /governance/proposals/active             │ PUBLIC                                   │
 * │ GET    /governance/proposals/:id                │ PUBLIC                                   │
 * │ GET    /governance/proposals/:id/votes          │ PUBLIC                                   │
 * │ GET    /governance/stats                        │ PUBLIC                                   │
 * │ POST   /governance/proposals                    │ AUTHN (any authenticated user)           │
 * │ POST   /governance/proposals/:id/votes          │ AUTHN (any authenticated user)           │
 * │ PATCH  /governance/proposals/:id/activate       │ ROLE(moderator,admin)                    │
 * │ PATCH  /governance/proposals/:id/execute        │ ROLE(admin)                              │
 * │ PATCH  /governance/proposals/:id/cancel         │ ROLE(moderator,admin)                    │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ POST   /identity/users                          │ AUTHN (any authenticated user)           │
 * │ GET    /identity/users/:id                      │ PUBLIC                                   │
 * │ POST   /identity/users/:id/wallets              │ AUTHN (any authenticated user)           │
 * │ DELETE /identity/users/:id/wallets/:chain/:addr │ AUTHN (any authenticated user)           │
 * │ POST   /identity/users/:id/verify-worldcoin     │ AUTHN (any authenticated user)           │
 * │ GET    /identity/users/:id/sybil-score          │ PUBLIC                                   │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /audit/*                                 │ ADMIN(auditor)                           │
 * │ POST   /audit/export                            │ ADMIN(auditor)                           │
 * │ POST   /audit/legal-hold/*                      │ ADMIN(administrator)                     │
 * │ PATCH  /audit/legal-hold/:id/remove             │ ADMIN(administrator)                     │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /analytics/*                             │ ROLE(moderator,admin) or ADMIN(auditor)  │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /metrics                                 │ Bearer METRICS_TOKEN                     │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /admin/jobs/metrics                      │ ADMIN(auditor)                           │
 * │ GET    /admin/jobs/metrics/:queue               │ ADMIN(auditor)                           │
 * │ POST   /admin/jobs/enqueue                      │ ADMIN(administrator)                     │
 * │ POST   /admin/jobs/retry/:queue                 │ ADMIN(administrator)                     │
 * │ POST   /admin/jobs/cancel/:queue                │ ADMIN(administrator)                     │
 * │ POST   /admin/jobs/pause/:queue                 │ ADMIN(administrator)                     │
 * │ POST   /admin/jobs/resume/:queue                │ ADMIN(administrator)                     │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /v2/events/*                             │ PUBLIC (read-only chain projections)     │
 * │ GET    /v2/evidence/*                           │ PUBLIC (read-only chain projections)     │
 * │ GET    /v2/verification/*                       │ PUBLIC (read-only chain projections)     │
 * │ GET    /v2/disputes/*                           │ PUBLIC (read-only chain projections)     │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ POST   /admin/auth/login                        │ PUBLIC (returns admin identity only)     │
 * │ All other /admin/* routes                       │ ADMIN(varies, see AdminController)       │
 * └─────────────────────────────────────────────────┴──────────────────────────────────────────┘
 *
 * FAILURE-CLOSED INVARIANTS
 * ─────────────────────────
 * • Missing JWT on a guarded route  → 401 Unauthorized
 * • Valid JWT but insufficient role → 403 Forbidden
 * • Admin DB lookup fails or admin is inactive → 403 Forbidden
 * • Service key missing or mismatched → 401 Unauthorized
 * • Any guard throws unexpectedly → NestJS exception filter returns 5xx; never silently permits
 *
 * NON-GOALS (protocol boundary)
 * ──────────────────────────────
 * • This matrix does NOT grant the API authority to settle rewards, resolve disputes,
 *   mutate governance outcomes, or override smart-contract events.
 * • All such state is reproduced deterministically from canonical Optimism/EVM events.
 * • No Stellar, Soroban, Freighter, or alternate-chain paths are introduced.
 */

/* eslint-disable */
/**
 * App-user roles matching the Prisma `UserRole` enum (contributor | moderator | admin).
 * Also kept in sync with TypeORM `UserRole` (USER ≡ contributor, MODERATOR ≡ moderator, ADMIN/SUPER_ADMIN ≡ admin).
 */
export type AppUserRole = 'contributor' | 'moderator' | 'admin';

/** All valid AppUserRole values. */
export const APP_USER_ROLES: readonly AppUserRole[] = [
  'contributor',
  'moderator',
  'admin',
] as const;

/**
 * Helper: returns true if the candidate string is a known AppUserRole.
 */
export function isAppUserRole(value: unknown): value is AppUserRole {
  return (
    typeof value === 'string' &&
    (APP_USER_ROLES as readonly string[]).includes(value)
  );
}

/**
 * REALTIME CONFIGURATION & TOPIC AUTHORIZATION
 * ────────────────────────────────────────────
 * Machine-readable schema for realtime stream configuration and per-principal
 * topic authorization. Fails closed on stale, ambiguous, missing, or
 * unauthorized state. Topic names are validated against a strict pattern to
 * prevent Redis/WebSocket pattern injection (globs, wildcards, channel
 * separators, control characters).
 *
 * Canonical contracts/finalized events remain authoritative; realtime streams
 * are read-only projections and MUST NOT mutate protocol truth.
 */

/** Supported realtime release identifiers. Anything else is stale → fail closed. */
export const SUPPORTED_REALTIME_RELEASES: readonly string[] = [
  'wave-9',
] as const;

/** Allowed stream origins. Unknown origins are rejected. */
export const ALLOWED_STREAM_ORIGINS: readonly string[] = [
  'optimism-mainnet',
  'optimism-sepolia',
] as const;

/** Public-data topic namespace prefixes (payloads safe for unauthenticated subscribers). */
export const PUBLIC_TOPIC_PREFIXES: readonly string[] = [
  'public.events.',
  'public.evidence.',
  'public.verification.',
  'public.disputes.',
] as const;

/** Protected topic namespace prefixes (require authenticated principal + capability). */
export const PROTECTED_TOPIC_PREFIXES: readonly string[] = [
  'protected.claims.',
  'protected.rewards.',
  'protected.governance.',
  'protected.identity.',
  'protected.audit.',
] as const;

/**
 * Strict topic name pattern. Rejects Redis glob metacharacters (`*`, `?`, `[`, `]`),
 * WebSocket wildcard escalation (`#`, `+`), channel separators (`:`, `/`), and
 * control/whitespace characters. Only lowercase alphanumerics, dots, and hyphens.
 */
export const TOPIC_NAME_PATTERN = /^[a-z0-9][a-z0-9.\-]{0,127}$/;

/** Realtime configuration schema. */
export interface RealtimeConfig {
  /** Stream origin identifier — must be in ALLOWED_STREAM_ORIGINS. */
  origin: string;
  /** Supported release identifier — must be in SUPPORTED_REALTIME_RELEASES. */
  release: string;
  /** Chain ID bound to this stream (chain-derived data MUST be bound to chain ID). */
  chainId: number;
  /** Deployment block for the bound contract set. */
  deploymentBlock: number;
  /** Artifact checksum (hex) of the deployed contract bundle. */
  artifactChecksum: string;
  /** Retention window in seconds. Must be > 0 and <= MAX_RETENTION_SECONDS. */
  retentionSeconds: number;
  /** Heartbeat interval in milliseconds. Must be > 0 and <= MAX_HEARTBEAT_MS. */
  heartbeatMs: number;
  /** Maximum payload size in bytes. Must be > 0 and <= MAX_PAYLOAD_BYTES. */
  maxPayloadBytes: number;
}

export const MAX_RETENTION_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const MAX_HEARTBEAT_MS = 60_000;
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Result of config validation. Fails closed: any error denies readiness. */
export type RealtimeConfigValidation =
  | { ok: true; config: RealtimeConfig }
  | { ok: false; errors: readonly string[] };

/**
 * Validate a realtime configuration. Fails closed on any missing, stale,
 * ambiguous, or out-of-range field. Callers MUST treat `ok: false` as a
 * startup/readiness failure.
 */
export function validateRealtimeConfig(
  input: unknown,
): RealtimeConfigValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const c = input as Record<string, unknown>;

  if (typeof c.origin !== 'string' || !ALLOWED_STREAM_ORIGINS.includes(c.origin)) {
    errors.push(`origin must be one of: ${ALLOWED_STREAM_ORIGINS.join(', ')}`);
  }
  if (
    typeof c.release !== 'string' ||
    !SUPPORTED_REALTIME_RELEASES.includes(c.release)
  ) {
    errors.push(
      `release must be one of: ${SUPPORTED_REALTIME_RELEASES.join(', ')}`,
    );
  }
  if (
    typeof c.chainId !== 'number' ||
    !Number.isInteger(c.chainId) ||
    c.chainId <= 0
  ) {
    errors.push('chainId must be a positive integer');
  }
  if (
    typeof c.deploymentBlock !== 'number' ||
    !Number.isInteger(c.deploymentBlock) ||
    c.deploymentBlock < 0
  ) {
    errors.push('deploymentBlock must be a non-negative integer');
  }
  if (
    typeof c.artifactChecksum !== 'string' ||
    !/^[0-9a-f]{64}$/.test(c.artifactChecksum)
  ) {
    errors.push('artifactChecksum must be a 64-char lowercase hex string');
  }
  if (
    typeof c.retentionSeconds !== 'number' ||
    !Number.isInteger(c.retentionSeconds) ||
    c.retentionSeconds <= 0 ||
    c.retentionSeconds > MAX_RETENTION_SECONDS
  ) {
    errors.push(`retentionSeconds must be in (0, ${MAX_RETENTION_SECONDS}]`);
  }
  if (
    typeof c.heartbeatMs !== 'number' ||
    !Number.isInteger(c.heartbeatMs) ||
    c.heartbeatMs <= 0 ||
    c.heartbeatMs > MAX_HEARTBEAT_MS
  ) {
    errors.push(`heartbeatMs must be in (0, ${MAX_HEARTBEAT_MS}]`);
  }
  if (
    typeof c.maxPayloadBytes !== 'number' ||
    !Number.isInteger(c.maxPayloadBytes) ||
    c.maxPayloadBytes <= 0 ||
    c.maxPayloadBytes > MAX_PAYLOAD_BYTES
  ) {
    errors.push(`maxPayloadBytes must be in (0, ${MAX_PAYLOAD_BYTES}]`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, config: c as unknown as RealtimeConfig };
}

/**
 * Returns true if the topic name is syntactically valid and free of
 * Redis/WebSocket pattern-injection metacharacters.
 */
export function isValidTopicName(topic: unknown): topic is string {
  return typeof topic === 'string' && TOPIC_NAME_PATTERN.test(topic);
}

/** Returns true if the topic belongs to the public-data namespace. */
export function isPublicTopic(topic: string): boolean {
  return PUBLIC_TOPIC_PREFIXES.some((p) => topic.startsWith(p));
}

/** Returns true if the topic belongs to the protected namespace. */
export function isProtectedTopic(topic: string): boolean {
  return PROTECTED_TOPIC_PREFIXES.some((p) => topic.startsWith(p));
}

/** Returns true if the release identifier is a supported realtime release. */
export function isSupportedRealtimeRelease(release: unknown): boolean {
  return (
    typeof release === 'string' &&
    SUPPORTED_REALTIME_RELEASES.includes(release)
  );
}

/** Principal attempting to subscribe to a realtime topic. */
export interface RealtimePrincipal {
  /** Stable principal id (wallet address or admin id). */
  id: string;
  /** True if the session is currently valid (not revoked/expired). */
  sessionActive: boolean;
  /** App-user role, if any (app-user plane). */
  appRole?: AppUserRole;
  /** Capabilities granted to this principal (e.g. 'audit:read'). */
  capabilities?: readonly string[];
}

/** Result of topic authorization. Fails closed. */
export type TopicAuthorization =
  | { ok: true; topic: string; visibility: 'public' | 'protected' }
  | { ok: false; reason: string };

/**
 * Authorize a principal's subscription to a topic. Fails closed on:
 *  - invalid topic name (pattern injection / wildcard escalation)
 *  - unknown topic namespace
 *  - revoked/inactive session
 *  - protected topic without sufficient capability
 * Public topics are subscribable without authentication.
 */
export function authorizeTopicSubscription(
  principal: RealtimePrincipal | null,
  topic: unknown,
): TopicAuthorization {
  if (!isValidTopicName(topic)) {
    return { ok: false, reason: 'invalid topic name' };
  }
  const isPublic = isPublicTopic(topic);
  const isProtected = isProtectedTopic(topic);
  if (!isPublic && !isProtected) {
    return { ok: false, reason: 'unknown topic' };
  }
  if (isPublic) {
    return { ok: true, topic, visibility: 'public' };
  }
  // Protected topic: require an active session and a matching capability.
  if (!principal || !principal.sessionActive) {
    return { ok: false, reason: 'revoked or missing session' };
  }
  const requiredCapability = `topic:${topic}`;
  const caps = principal.capabilities ?? [];
  const hasCap = caps.includes(requiredCapability);
  if (!hasCap) {
    return { ok: false, reason: 'insufficient capability' };
  }
  return { ok: true, topic, visibility: 'protected' };
}
