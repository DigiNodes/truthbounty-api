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
|---|---|
| `contributor` | Default. Can read public data and submit claims, evidence, votes, disputes. |
| `moderator` | Can perform state transitions on disputes and governance proposals. |
| `admin` | Full app-user privileges including reward management, reconcile, proposal execution. |

### Admin-Operator Plane (TypeORM `AdminRole`)

A separate DB-backed identity (`admin_users` table). Requires `AdminGuard` (DB lookup) + `RolesGuard` (hierarchy check). Roles are ordered numerically.

| Role | Hierarchy Score | Capabilities |
|---|---|---|
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
  │
  ├─ GlobalAuthGuard (APP_GUARD)
  │    Requires JWT for all POST/PATCH/PUT/DELETE
  │    GET methods public by default
  │    @Public() decorator bypasses this guard
  │
  ├─ WalletThrottlerGuard (APP_GUARD)
  │    Rate-limits by wallet address
  │
  ├─ [Route-level guards applied via @UseGuards()]
  │    ├─ JwtAuthGuard         — enforces valid JWT
  │    ├─ RolesGuard (auth/)   — enforces app-user Prisma role
  │    ├─ AdminGuard (admin/)  — DB lookup in admin_users
  │    ├─ RolesGuard (admin/)  — hierarchy check on request.admin
  │    └─ ServiceAuthGuard     — x-service-api-key header
  │
  └─ Controller handler
```

---

## Route Authorization Table

Notation:
- `PUBLIC` — no authentication required
- `AUTHN` — valid JWT required (any authenticated user)
- `ROLE(x)` — JWT + Prisma `UserRole` ∈ x (app-user plane)
- `ADMIN(x)` — JWT + DB-backed AdminGuard + AdminRoleHierarchy ≥ x (admin plane)
- `SERVICE` — `x-service-api-key` header (service-to-service)

### Auth

| Method | Route | Authorization |
|---|---|---|
| POST | `/auth/challenge` | PUBLIC + rate-limited |
| POST | `/auth/login` | PUBLIC + rate-limited |
| POST | `/auth/refresh` | PUBLIC + rate-limited |
| GET | `/auth/health` | PUBLIC |
| POST | `/auth/logout` | AUTHN |
| GET | `/auth/profile` | AUTHN |
| DELETE | `/auth/sessions/:address` | AUTHN + AdminOnly (env-list gate) |

### Claims

| Method | Route | Authorization |
|---|---|---|
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
|---|---|---|
| GET | `/disputes` | PUBLIC |
| GET | `/disputes/expired` | PUBLIC |
| GET | `/disputes/claim/:claimId` | PUBLIC |
| POST | `/disputes` | AUTHN |
| PATCH | `/disputes/:id/start-review` | ROLE(moderator, admin) |
| PATCH | `/disputes/:id/resolve` | ROLE(moderator, admin) |
| PATCH | `/disputes/:id/reject` | ROLE(moderator, admin) |

### Rewards

| Method | Route | Authorization |
|---|---|---|
| GET | `/rewards` | PUBLIC |
| GET | `/rewards/:id` | PUBLIC |
| POST | `/rewards` | ROLE(admin) |
| PATCH | `/rewards/:id` | ROLE(admin) |
| DELETE | `/rewards/:id` | ROLE(admin) |

### Staking

| Method | Route | Authorization |
|---|---|---|
| GET | `/staking/projects/:claimId/entitlement` | PUBLIC |
| GET | `/staking/projects/:claimId/stake` | PUBLIC |
| POST | `/staking/projects/:claimId/locks` | AUTHN |
| POST | `/staking/projects/:claimId/withdrawals` | AUTHN |
| POST | `/staking/projects/:claimId/reconcile` | ROLE(admin) |

### Governance

| Method | Route | Authorization |
|---|---|---|
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
|---|---|---|
| GET | `/identity/users/:id` | PUBLIC |
| GET | `/identity/users/:id/sybil-score` | PUBLIC |
| POST | `/identity/users` | AUTHN |
| POST | `/identity/users/:id/wallets` | AUTHN |
| DELETE | `/identity/users/:id/wallets/:chain/:address` | AUTHN |
| POST | `/identity/users/:id/verify-worldcoin` | AUTHN |

### Audit

| Method | Route | Authorization |
|---|---|---|
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
|---|---|---|
| GET | `/v2/events/*` | PUBLIC |
| GET | `/v2/evidence/*` | PUBLIC |
| GET | `/v2/verification/*` | PUBLIC |
| GET | `/v2/disputes/*` | PUBLIC |

### Admin (operator plane)

| Method | Route | Authorization |
|---|---|---|
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
|---|---|---|
| GET | `/metrics` | Bearer `METRICS_TOKEN` header |

---

## Failure Modes

| Condition | Response |
|---|---|
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

All failure modes throw exceptions — no silent fallback to fabricated or permissive state.

---

## Implementation Files

| File | Purpose |
|---|---|
| `src/auth/authorization-matrix.ts` | Canonical machine-readable matrix + type helpers |
| `src/auth/guards/roles.guard.ts` | App-user plane role enforcement |
| `src/auth/guards/admin.guard.ts` | Env-list admin gate (used by auth controller) |
| `src/admin/guards/admin.guard.ts` | DB-backed admin identity gate |
| `src/admin/guards/roles.guard.ts` | Admin-plane hierarchy enforcement |
| `src/auth/global-auth.guard.ts` | Global JWT guard (APP_GUARD) |
| `src/auth/guards/service-auth.guard.ts` | Service-to-service key guard |
| `src/migrations/1790000000000-AddUserRoleToUsers.ts` | TypeORM migration: role column on `users` table |

---

## Non-Goals

- Changing smart-contract protocol rules
- Adding alternative-chain runtime support (Stellar, Soroban, Freighter)
- Replacing TypeORM or creating a second domain persistence architecture
- Granting the API authority to settle rewards, resolve disputes, or mutate governance outcomes

---

## Reviewer Checklist

- [ ] All new guards verified fail-closed (throw, never return false)
- [ ] `@Roles()` keys distinct between app-user plane (`'roles'`) and admin plane (`'admin_roles'`)
- [ ] No route exposes security events or admin activity to unauthenticated callers
- [ ] Migration `up()` is idempotent (IF NOT EXISTS)
- [ ] Migration `down()` cleanly reverses all changes
- [ ] All tests pass in CI without skips
- [ ] No secrets, live credentials, or production mocks committed
