# API Authorization Matrix — V2 Backend (issue #458 / V2-BE-104)

## Design Principles

TruthBounty's API is a **deterministic indexing, projection, authentication, and delivery layer**. It must never invent, mutate, or override protocol truth. Smart contracts and finalized canonical Optimism/EVM events remain authoritative for all protocol state.

The authorization layer follows these invariants:

1. **Fail closed** — any uncertainty in identity, role, signature, or configuration results in denial, never silent permit.
2. **Two independent identity planes** — the app-user plane (Prisma/wallet-based) and the admin-operator plane (TypeORM `admin_users` table) are kept separate with distinct guards, keys, and hierarchy models.
3. **TypeORM only for domain persistence** — Prisma manages auth-adjacent user/wallet models; no second domain ORM is introduced.
4. **Optimism/EVM only** — no Stellar, Soroban, Freighter, or alternate-chain runtime paths.
5. **No protocol authority** — the backend never issues settlement, rewards, treasury, governance, claim, or dispute mutations that would override canonical chain state.

---

## Identity Planes

### App-User Plane (Prisma `UserRole`)

Authenticated via wallet-signature → JWT. Role is stored in the Prisma `User.role` field.

| Role | Description |
|------|------------|
| `contributor` | Default. Can read public data and submit claims, evidence, votes, disputes. |
| `moderator` | Can perform state transitions on disputes and governance proposals. |
| `admin` | Full app-user privileges including reward management, reconcile, proposal execution. |

### Admin-Operator Plane (TypeORM `AdminRole`)

A separate DB-backed identity (`admin_users` table). Requires `AdminGuard` (DB lookup) + `RolesGuard` (hierarchy check). Roles are ordered numerically.

| Role | Hierarchy Score | Capabilities |
|------|---------------|------------|
| `super_admin` | 100 | All admin capabilities |
| `administrator` | 80 | All below + maintenance, emergency, legal holds |
| `security_analyst` | 60 | Security events, incidents, moderation |
| `governance_operator` | 60 | Governance administration |
| `moderator` | 50 | Moderation queue, reports |
| `auditor` | 30 | Read-only audit logs, reports |

---

## Guard Stack

Every request passes through guards in this order:

```
Request
  
  ├─ GlobalAuthGuard (APP_GUARD)
  |    Requires JWT for all POST/PATCH/PUT/DELETE
  |    GET methods public by default
  |    @Public() decorator bypasses this guard
  
  ├─ WalletThrottlerGuard (APP_GUARD)
      Rate-limits by wallet address
  
  ├─ [Route-level guards applied via @UseGuards()]
  |    ├─ JwtAuthGuard         — enforces valid JWT
  |    ├─ RolesGuard (auth/)   — enforces app-user Prisma role
  |    ├─ AdminGuard (admin/)  — DB lookup in admin_users
  |    ├─ RolesGuard (admin/)  — hierarchy check on request.admin
  |    └─ ServiceAuthGuard     — X-service-api-key header
  |
  └─ Controller handler
```

---

## Route Authorization Table

Notation:
- `PUBLIC` — no authentication required
- `AUTHN` — valid JWT and authenticated user required
- `ROLE(x)` — JWT + Prisma `UserRole` ∈ x (app-user plane)
- `ADMIN(x)` — JWT + DB-backed AdminGuard + AdminRole hierarchy ≥ x (admin plane)
- `SERVICE` — `x-service-api-key` header (service-to-service)

### Auth

| Method | Route | Authorization |
|-------|-------|--------------|
| POST | `/auth/challenge` | PUBLIC + rate-limited |
| POST | `/auth/login` | PUBLIC + rate-limited |
| POST | `/auth/refresh` | PUBLIC + rate-limited |
| GET | `/auth/health` | PUBLIC |
| POST | `/auth/logout` | AUTHN |
| GET | `/auth/profile` | AUTHN |
| DELETE | `/auth/sessions/:address` | AUTHN + AdminOnly (env-list gate) |

### Claims

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/claims/latest` | PUBLIC |
| GET | `/claims/user/:wallet` | PUBLIC |
| GET | `/claims/:id` | PUBLIC |
| GET | `/claims/:claimId/evidence` | PUBLIC |
| GET | `/claims/:claimId/evidence/latest` | PUBLIC |
| GET | `/claims/evidence/:evidenceId` | PUBLIC |
| POST | `/claims` | AUTHN |
| POST | `/claims/:claimId/evidence` | AUTHN |
| PUT | `/claims/evidence/:evidenceId` | AUTHN |

### Disputes

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/disputes` | PUBLIC |
| GET | `/disputes/expired` | PUBLIC |
| GET | `/disputes/claim/:claimId` | PUBLIC |
| POST | `/disputes` | AUTHN |
| PATCH | `/disputes/:id/start-review` | ROLE(moderator, admin) |
| PATCH | `/disputes/:id/resolve` | ROLE:moderator, admin) |
| PATCH | `/disputes/:id/reject` | ROLE:moderator, admin) |

### Rewards

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/rewards` | PUBLIC |
| GET | `/rewards/:id` | PUBLIC |
| POST | `/rewards` | ROLE(admin) |
| PATCH | `/rewards/:id` | ROLE(admin) |
| DELETE | `/rewards/:id` | ROLE(admin) |

### Staking

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/staking/projects/:claimId/entitlement` | PUBLIC |
| GET | `/staking/projects/:claimId/stake` | PUBLIC |
| POST | `/staking/projects/:claimId/locks` | AUTHN |
| POST | `/staking/projects/:claimId/withdrawals` | AUTHN |
| POST | `/staking/projects/:claimId/reconcile` | ROLE(admin) |

### Governance

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/governance/proposals` | PUBLIC |
| GET | `/governance/proposals/active` | PUBLIC |
| GET | `/governance/proposals/:id` | PUBLIC |
| GET | `/governance/proposals/:id/votes` | PUBLIC |
| GET | `/governance/stats` | PUBLIC |
| POST | `/governance/proposals` | AUTHN |
| POST | `/governance/proposals/:id/votes` | AUTHN |
| PATCH | `/governance/proposals/:id/activate` | ROLE(moderator, admin) |
| PATCH | `/governance/proposals/:id/cancel` | ROLE(moderator, admin) |
| PATCH | `/governance/proposals/:id/execute` | ROLE(admin) |

### Identity

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/identity/users/:id` | PUBLIC |
| GET | `/identity/users/:id/sybil-score` | PUBLIC |
| POST | `/identity/users` | AUTHN |
| POST | `/identity/users/:id/wallets` | AUTHN |
| DELETE | `/identity/users/:id/wallets/:chain/:address` | AUTHN |
| POST | `/identity/users/:id/verify-worldcoin` | AUTHN |

### Audit

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/audit` | ADMIN(auditor) |
| GET | `/audit/entity/:entityType/:entityId` | ADMIN(auditor) |
| GET | `/audit/user/:userId` | ADMIN(auditor) |
| GET | `/audit/action/:actionType` | ADMIN(auditor) |
| GET | `/audit/changes/:entityType/:entityId` | ADMIN(auditor) |
| GET | `/audit/summary` | ADMIN(auditor) |
| GET | `/audit/event/:eventId` | ADMIN(auditor) |
| GET | `/audit/correlation/:correlationId` | ADMIN(auditor) |
| GET | `/audit/stats/storage` | ADMIN(auditor) |
| GET | `/audit/retention` | ADMIN(auditor) |
| GET | `/audit/integrity/:id` | ADMIN(auditor) |
| GET | `/audit/metrics` | ADMIN(auditor) |
| POST | `/audit/export` | ADMIN(auditor) |
| GET | `/audit/reports` | ADMIN(auditor) |
| GET | `/audit/reports/daily` | ADMIN(auditor) |
| GET | `/audit/reports/categories` | ADMIN(auditor) |
| GET | `/audit/security/events` | ADMIN(security_analyst) |
| GET | `/audit/security/failed-logins` | ADMIN(security_analyst) |
| GET | `/audit/security/admin-activity` | ADMIN(security_analyst) |
| GET | `/audit/security/check/:userId` | ADMIN(security_analyst) |
| POST | `/audit/legal-hold/:entityType/:entityId` | ADMIN(administrator) |
| PATCH | `/audit/legal-hold/:entityType/:entityId/remove` | ADMIN(administrator) |

### V2 Chain Projections (read-only)

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/v2/events/*` | PUBLIC |
| GET | `/v2/evidence/*` | PUBLIC |
| GET | `/v2/verification/*` | PUBLIC |
| GET | `/v2/disputes/*` | PUBLIC |

### Public Status & Incidents (UX-BE-001, UX-BE-002)

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/status/public` | PUBLIC + rate-limited |
| GET | `/status/incidents` | PUBLIC + rate-limited |
| GET | `/status/incidents/:incidentId` | PUBLIC + rate-limited |


### Admin (operator plane)

| Method | Route | Authorization |
|-------|-------|--------------|
| POST | `/admin/auth/login` | PUBLIC (identity lookup only) |
| GET | `/admin/auth/profile` | ADMIN(auditor) |
| POST | `/admin/admins` | ADMIN(administrator) |
| GET | `/admin/admins` | ADMIN(auditor) |
| GET | `/admin/admins/:id` | ADMIN(auditor) |
| PATCH | `/admin/admins/:id/role` | ADMIN(administrator) |
| PATCH | `/admin/admins/:id/status` | ADMIN(administrator) |
| All `/admin/moderation/*` | varies | See ModerationController |
| All `/admin/incidents/*` | varies | See IncidentController |
| All `/admin/protocol/*` | varies | See ProtocolAdminController |

### Metrics

| Method | Route | Authorization |
|-------|-------|--------------|
| GET | `/metrics` | Bearer `METRICS_TOKEN` header |

---

## Failure Modes

| Condition | Response |
|---------|----------|
| Missing JWT on guarded route | 401 Unauthorized |
| Valid JWT, insufficient app-user role | 403 Forbidden |
| Valid JWT, wallet not in `admin_users` | 403 Forbidden |
| Valid JWT, admin found but `isActive=false` | 403 Forbidden |
| Admin role below required hierarchy | 403 Forbidden |
| Invalid/missing service API key | 401 Unauthorized |
| Prisma user record absent (no wallet linked) | 403 Forbidden on role-restricted routes |
| Role field missing or unrecognised | 403 Forbidden |
| JWT token blacklisted (jti in Redis) | 401 Unauthorized (via JwtStrategy) |
| Challenge expired or nonce already used | 401 Unauthorized (via AuthService) |
| Capability token audience mismatch | 403 Forbidden |
| Capability token scope/resource mismatch | 403 Forbidden |
| Capability token expired or not-yet-valid | 401 Unauthorized |
| Capability token replay (nonce reused) | 401 Unauthorized |
| Capability token revoked actor or token | 403 Forbidden |
| Capability token chain/release/deployment mismatch | 403 Forbidden |
| Capability token signature invalid | 401 Unauthorized |

All failure modes throw exceptions — no silent fallback to fabricated or permissive state.

---

## Capability Tokens (PREWAVE-BE-082)

Authentication alone grants no capability. Protected API mutations require a short-lived, least-privilege capability token in addition to a valid session.

### Token Claims (JWS)

| Claim | Purpose |
|-------|---------|
| `aud` | Audience must match the canonical audience for the route (e.g. `internal:operations`). |
| `sub` | Subject — the actor identity (app-user or admin-operator). |
| `cap` | Capability name (e.g. `operations.retry`). |
| `resource` | Resource scope (e.g. `operation:<queueId>`). |
| `nonce` | Single-use nonce, recorded in the replay store. |
| `iat/exp` | Issued at / expiry (short lived). |
| `chain` | Chain identifier (e.g. Optimism chain id). |
| `release` | Release identifier bound at issuance. |
| `deployment` | Deployment identifier bound at issuance. |
| `artifact` | Artifact provenance digest bound at issuance. |

Tokens are signed with the capability signing key and verified on every use. Signature verification is fail-closed: any algorithm, key, or signature mismatch results in 401.

### Request Headers

Protected operations require:

- `X-Authority-Capability: <token>` — the JWS capability token.
- `X-Authority-Expires-At: <iso-8601>` — client-declared expiry, must match the token `exp` and be in the future.

Mismatch or missing headers fail closed.

### Lifecycle

1. **Issuance** — authorized actor requests a capability for a specific capability/resource; server binds aud/sub/cap/resource/nonce/iat/exp/chain/release/deployment/artifact and signs.
2. **Use** — guard verifies signature, aud, sub, cap, resource, validity window, chain/release/deployment/artifact context, revocation state, and nonce unused.
3. **Replay** — nonce is consumed on first use; subsequent use returns 401. Replay store fails closed if Redis is unreachable.
4. **Revocation** — token ids or actors can be revoked; revocation store is checked on every use and fails closed.
5. **Expiry** — tokens are short-lived; expired or not-yet-valid tokens return 401.

### Auditing

Issuance and use are audited with audience, subject, capability, resource, nonce id, chain/release/deployment/artifact context, and outcome. Token bytes, signatures, and secrets must never be logged.

---

## Implementation Files

| File | Purpose |
|------|---------|
| `src/auth/authorization-matrix.ts` | Canonical machine-readable matrix + type helpers |
| `src/auth/guards/roles.guard.ts` | App-user plane role enforcement |
| `src/auth/guards/admin.guard.ts` | Env-list admin gate (used by auth controller) |
| `src/admin/guards/admin.guard.ts` | DB-backed admin identity gate |
| `src/admin/guards/roles.guard.ts` | Admin-plane hierarchy enforcement |
| `src/auth/global-auth.guard.ts` | Global JWT guard (APP_GUARD) |
| `src/auth/guards/service-auth.guard.ts` | Service-to-service key guard |
| `src/auth/capability/capability-token.service.ts` | Issue/verify/revoke short-lived capability tokens (JWS-signed, aud/sub/cap/resource/nonce/exp/iat/chain/release/deployment/artifact) |
| `src/auth/capability/capability.guard.ts` | Enforces `X-Authority-Capability` + `X-Authority-Expires-At` on protected operations |
| `src/auth/capability/capability-replay.store.ts` | Nonce replay store (Redis) fail-closed on unreachable state |
| `src/auth/capability/capability-revocation.store.ts` | Revocation store for actors and token ids |
| `src/auth/capability/capability-audit.service.ts` | Audits capability issuance/use without logging token bytes |
| `src/migrations/1790000000000-AddUserRoleToUsers.ts` | TypeORM migration: role column on `users` table |

---

## Protected Operations (UX-BE-004, #595)

Admin-plane routes under `/v1/operations`, guarded by `AdminGuard` + `RolesGuard`.
Retry submission additionally requires an `Idempotency-Key`, a precondition
token, and revalidated capability + expiry (fail closed).

| Method | Path | Roles | Extra requirements |
|-------|------|-------|------------------|
| `GET` x `/v1/operations/queue` | super_admin, administrator, security_analyst, auditor | — |
| `GET` | `/v1/operations/queue/:id` | super_admin, administrator, security_analyst, auditor | — |
| `GET` x `/v1/operations/queue/:id/retry-eligibility` | super_admin, administrator, security_analyst, auditor | — |
| `POST` x `/v1/operations/queue/:id/retry` | super_admin, administrator | `Idempotency-Key`, `X-Authority-Capability`, `X-Authority-Expires-At`, precondition token |
