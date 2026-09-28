# V2 Administrative and Operator Endpoint Protection

**Issue:** V2-BE-105  
**Status:** Implemented  
**Date:** 2026-09-27

## Overview

This document describes the security hardening implemented for administrative and operator endpoints in the TruthBounty V2 backend API. The implementation strengthens authentication, authorization, and abuse resistance while maintaining the protocol boundary where deployed Optimism/EVM contracts and canonical chain events remain the sole source of protocol authority.

## Problem Context

TruthBounty treats deployed Optimism/EVM contracts and canonical chain events as protocol authority. The API is a deterministic indexing, projection, authentication, and delivery layer; it must never invent, mutate, or override protocol truth. This boundary must remain explicit under failures, retries, reorgs, migrations, and degraded dependencies.

Administrative and operator endpoints provide critical infrastructure control capabilities (job queue management, maintenance mode, incident response, audit access) that must be protected with fail-closed authorization to prevent unauthorized access or manipulation.

## Implementation Summary

### Jobs Controller Protection (`/admin/jobs/*`)

**Previous State:** Only protected by `JwtAuthGuard` (any authenticated user could access)

**New State:** Full admin-plane protection with role-based access control

#### Authorization Matrix

| Endpoint | Method | Required Admin Role | Purpose |
|----------|--------|---------------------|---------|
| `/admin/jobs/enqueue` | POST | super_admin, administrator | Enqueue background jobs |
| `/admin/jobs/retry/:queue` | POST | super_admin, administrator | Retry failed jobs in queue |
| `/admin/jobs/cancel/:queue` | POST | super_admin, administrator | Cancel queued job |
| `/admin/jobs/pause/:queue` | POST | super_admin, administrator | Pause job queue processing |
| `/admin/jobs/resume/:queue` | POST | super_admin, administrator | Resume job queue processing |
| `/admin/jobs/metrics/:queue` | GET | super_admin, administrator, security_analyst, auditor | Queue metrics (single) |
| `/admin/jobs/metrics` | GET | super_admin, administrator, security_analyst, auditor | Queue metrics (all) |

### Security Architecture

#### Dual-Plane Authorization Model

**Admin-Operator Plane** (TypeORM-based):
- Storage: `admin_users` table with hierarchical roles
- Authentication: Wallet signature → JWT → Database lookup
- Guards: `AdminGuard` + `RolesGuard`
- Hierarchy (numeric scoring):
  - `super_admin` (100) - Full system control
  - `administrator` (80) - Maintenance and operational control
  - `security_analyst` (60) - Security monitoring and incident response
  - `governance_operator` (60) - Governance administration
  - `moderator` (50) - Content moderation
  - `auditor` (30) - Read-only audit access

**App-User Plane** (Prisma-based):
- Storage: `User.role` field (`contributor` | `moderator` | `admin`)
- Authentication: Wallet signature → JWT
- Guards: `JwtAuthGuard` + `RolesGuard` (app-user variant)
- Used for protocol participant actions (claims, disputes, governance)

#### Guard Implementation

```typescript
@Controller('admin/jobs')
@UseGuards(AdminGuard, RolesGuard)  // Controller-level protection
@ApiBearerAuth()
export class JobsController {
  
  @Post('enqueue')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)  // Endpoint-level roles
  async enqueue(...) { }
  
  @Get('metrics')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, 
         AdminRole.SECURITY_ANALYST, AdminRole.AUDITOR)  // Read-only includes lower roles
  async getAllMetrics(...) { }
}
```

#### Authorization Flow

1. **Request arrives** with JWT Bearer token
2. **AdminGuard executes:**
   - Validates JWT (via Passport strategy)
   - Extracts wallet address from token
   - Queries `admin_users` table for matching active admin
   - Fails closed: 403 if no admin found or admin is inactive
   - Attaches `request.admin` with full admin entity
3. **RolesGuard executes:**
   - Reads `@Roles()` metadata from handler/controller
   - Compares `request.admin.role` hierarchy against required roles
   - Uses numeric hierarchy: admin must have score ≥ required role
   - Fails closed: 403 if insufficient hierarchy
4. **Handler executes** with verified admin context

### Fail-Closed Security Model

All guards implement fail-closed behavior:

- **Missing JWT** → 401 Unauthorized
- **Invalid JWT** → 401 Unauthorized  
- **Valid JWT but not an admin** → 403 Forbidden
- **Admin account inactive** → 403 Forbidden
- **Insufficient role hierarchy** → 403 Forbidden
- **Blacklisted token** → 401 Unauthorized
- **Guard throws unexpectedly** → 5xx error (never permits)

No silent fallbacks, no permissive defaults, no bypass mechanisms.

### Protocol Boundary Preservation

This implementation **does not** grant the backend authority over:
- Smart contract settlement logic
- Reward allocation rules
- Dispute resolution outcomes
- Governance execution
- Treasury management
- Claim state transitions driven by chain events

All protocol state remains reproducible from canonical Optimism/EVM events and versioned deployment artifacts. The API remains a deterministic indexing and projection layer.

### Abuse Resistance

**Rate Limiting:**
- Global `WalletThrottlerGuard` limits requests per wallet address
- Applied at APP_GUARD level

**Token Revocation:**
- JWT includes unique JTI (JWT ID)
- JTI stored in Redis blacklist on logout
- Validated on every request
- Enables immediate token revocation

**Timing-Safe Comparisons:**
- Service-to-service authentication uses `timingSafeEqualUtf8()`
- Prevents timing attacks on secret comparison

**Audit Trail:**
- All admin actions logged to audit subsystem
- Immutable audit log with legal hold support
- Exportable for compliance and forensics

## Files Modified

### Core Implementation
- `src/jobs/jobs.controller.ts` - Added `AdminGuard`, `RolesGuard`, and role decorators

### Documentation
- `src/auth/authorization-matrix.ts` - Updated with jobs endpoint authorization matrix
- `docs/V2_ADMIN_ENDPOINT_PROTECTION.md` - This document

## Security Invariants

1. **Chain-derived state is authoritative** - The API never invents protocol truth
2. **Authorization fails closed** - Any uncertainty denies access
3. **Two independent identity planes** - App-user and admin-operator separation
4. **TypeORM-only persistence** - No second ORM for domain state
5. **Observable failures** - No silent fallbacks; all failures are actionable

## Testing Requirements

The following test coverage is required (not implemented in this minimal fix):

### Unit Tests
- Valid admin with sufficient role can access each endpoint
- Valid admin with insufficient role receives 403
- Non-admin authenticated user receives 403
- Unauthenticated request receives 401
- Inactive admin account receives 403
- Role hierarchy enforcement (super_admin can access administrator-required endpoints)

### Integration Tests
- Full request lifecycle with PostgreSQL admin lookup
- Token blacklist validation via Redis
- Rate limiting enforcement
- Audit log generation for admin actions

### Security Tests
- Timing attack resistance on service authentication
- Token revocation effectiveness
- Role escalation prevention
- Concurrent request handling with admin session

## Operational Notes

### Admin Account Management

**Creating Admins:**
```bash
# Via API (requires existing super_admin or administrator)
POST /admin/admins
{
  "walletAddress": "0x...",
  "role": "auditor"  # Start with minimum privilege
}
```

**Role Hierarchy Access:**
- `auditor` (30) - Read-only: `/admin/jobs/metrics/*`, `/audit/*`
- `moderator` (50) - Moderation queue only
- `governance_operator` (60) - Governance + read access
- `security_analyst` (60) - Security + read access
- `administrator` (80) - Full operational control except admin management
- `super_admin` (100) - Full system control including admin creation

### Emergency Response

**If admin compromise suspected:**
1. Identify compromised admin wallet address
2. Use `PATCH /admin/admins/:id/status` with `super_admin` account to deactivate
3. Admin's JWT remains valid until expiration but database lookup fails (fail-closed)
4. Review audit logs: `GET /audit/user/:userId`
5. Investigate with: `GET /admin/protocol/audit-logs/admin`

**If service degradation suspected:**
1. Check queue metrics: `GET /admin/jobs/metrics`
2. Pause affected queue: `POST /admin/jobs/pause/:queue`
3. Investigate with audit logs and incident tracking
4. Resume when resolved: `POST /admin/jobs/resume/:queue`

## Compliance and Audit

All administrative actions are captured in the audit subsystem:

- **Who:** Admin wallet address and role
- **What:** Endpoint, method, parameters
- **When:** Timestamp with millisecond precision
- **Result:** Success/failure and any error messages
- **Context:** Request ID for distributed tracing

Audit logs support:
- Immutable append-only storage
- Legal hold markers (prevents deletion)
- Export for compliance reporting
- Security event filtering

## Future Enhancements

This implementation satisfies V2-BE-105 requirements. Future work may include:

1. **Multi-factor authentication** for super_admin actions
2. **IP allowlisting** for admin access
3. **Session management** with configurable timeout policies
4. **Admin action approval workflows** for high-risk operations
5. **Real-time alerting** on suspicious admin activity patterns

## Dependencies

- V2-BE-104: Referenced contract ABI/address artifacts must be canonical
- Admin database table must exist and be migrated
- Redis must be available for token blacklisting
- Audit subsystem must be operational

## Non-Goals

This implementation explicitly does **not**:
- Change smart-contract protocol rules
- Add alternative-chain (Stellar/Soroban) runtime support
- Replace TypeORM or create second persistence architecture
- Grant backend authority over protocol settlement
- Introduce Prisma for domain entities

## Review and Approval

**Required Approvals:**
- Backend maintainer review (required)
- Security/architecture maintainer approval (required for sensitive paths)

**Verification:**
- No unrelated issues closed
- No unrelated refactors bundled
- Migrations and schemas synchronized
- Documentation complete and accurate
- Authorization matrix updated

## Conclusion

Administrative and operator endpoints are now protected with fail-closed, role-based access control that maintains the protocol boundary. The implementation uses the existing dual-plane authorization architecture without introducing new runtime dependencies or granting the backend authority over protocol truth.

All job queue control operations now require verified admin credentials with appropriate role hierarchy, preventing unauthorized access while enabling legitimate operational and security workflows.
