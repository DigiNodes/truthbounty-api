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
 * │ PATCH  /audit/legal-hold/*/remove               │ ADMIN(administrator)                     │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /analytics/*                             │ ROLE(moderator,admin) or ADMIN(auditor)  │
 * ├─────────────────────────────────────────────────┼──────────────────────────────────────────┤
 * │ GET    /metrics                                 │ Bearer METRICS_TOKEN                     │
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

/**
 * App-user roles matching the Prisma `UserRole` enum (contributor | moderator | admin).
 * Also kept in sync with TypeORM `UserRole` (USER ≡ contributor, MODERATOR ≡ moderator, ADMIN/SUPER_ADMIN ≡ admin).
 */
export type AppUserRole = 'contributor' | 'moderator' | 'admin';

/** All valid AppUserRole values. */
export const APP_USER_ROLES: readonly AppUserRole[] = ['contributor', 'moderator', 'admin'] as const;

/**
 * Helper: returns true if the candidate string is a known AppUserRole.
 */
export function isAppUserRole(value: unknown): value is AppUserRole {
  return typeof value === 'string' && (APP_USER_ROLES as readonly string[]).includes(value);
}
