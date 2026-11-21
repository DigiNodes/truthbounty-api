# PREWAVE-BE-157: Feature Flag Sanitization Implementation

## Summary

This implementation addresses security vulnerabilities in the feature flags API by:
1. Sanitizing public API responses to exclude internal targeting rules
2. Preventing caller-controlled identity impersonation 
3. Filtering server-only flags from public access
4. Using verified principals for personalized flag evaluation

## Changes Made

### 1. DTOs for Public Responses (`src/feature-flags/dto/`)

**PublicFeatureFlagDto**
- Exposes only: id, key, type, enabled, environment, description, expiresAt, createdAt
- **Excludes sensitive fields**: rolloutPercentage, rules (userIds, roles), metadata, version, createdBy, serverOnly

**EvaluateFlagDto**  
- Request DTO accepting only `environment` parameter (validated)
- User identity derived from authenticated principal, not query params

**FeatureFlagEvaluationDto**
- Response DTO with evaluation result + `authenticated` flag
- Does not expose targeting rules or rollout configuration

**ListFlagsDto**
- Query parameter validation for `environment` field

### 2. Entity & Type Updates

**FeatureFlag entity** (`src/feature-flags/entities/feature-flag.entity.ts`)
- Added `serverOnly: boolean` column (default: false)
- Server-only flags are internal operational toggles not exposed publicly

**Types** (`src/feature-flags/feature-flags.types.ts`)
- Updated `CreateFeatureFlagInput` and `UpdateFeatureFlagInput` to include `serverOnly`

**Migration** (`src/migrations/1795263952634-AddServerOnlyToFeatureFlags.ts`)
- Adds `serverOnly` column with index for efficient filtering

### 3. Service Layer (`src/feature-flags/feature-flags.service.ts`)

**New Methods:**

```typescript
evaluateForPrincipal(
  key: string,
  principal: AuthenticatedPrincipal | null,
  environment?: string
): Promise<FeatureFlagEvaluationResult>
```
- Derives evaluation context from verified principal
- Prevents caller-supplied userId/roles from being trusted
- Returns explicit anonymous context when principal is null

```typescript
deriveContextFromPrincipal(
  principal: AuthenticatedPrincipal | null,
  environment?: string
): FeatureFlagContext
```
- Extracts userId, walletAddress, and roles from authenticated principal
- Ensures unauthenticated callers cannot impersonate users or roles

```typescript
findAllPublic(environment?: string): Promise<FeatureFlag[]>
```
- Filters out `serverOnly` flags from public listing
- Admin endpoints continue to use `findAll()` for full access

**Cache Strategy:**
- Flag **definitions** are cached (global per environment)
- Flag **evaluations** are NOT cached (computed per request with user context)
- Prevents personalized results from leaking across users

### 4. Controller Layer (`src/feature-flags/feature-flags.controller.ts`)

**Public Endpoints (Sanitized):**

```typescript
GET /feature-flags
  - Returns: PublicFeatureFlagDto[]
  - Calls: findAllPublic() to filter serverOnly flags
  - Input: ListFlagsDto (validated environment)

GET /feature-flags/evaluate/:key
  - Returns: FeatureFlagEvaluationDto
  - Calls: evaluateForPrincipal()
  - Uses: @CurrentUser() decorator (verified principal)
  - Input: EvaluateFlagDto (environment only)
  - No longer accepts userId or roles query params

GET /feature-flags/:id
  - Returns: PublicFeatureFlagDto
  - Rejects: serverOnly flags (throws "not found")
```

**Admin Endpoints (Full Access):**

```typescript
GET /admin/feature-flags
  - Returns: FeatureFlag[] (complete entities)
  - Guards: JwtAuthGuard + AdminGuard
  - Includes: serverOnly flags and all internal metadata

GET /admin/feature-flags/:id
  - Returns: FeatureFlag (complete entity with rules, targeting)
  - Guards: JwtAuthGuard + AdminGuard
```

### 5. Comprehensive Tests

**feature-flags-security.spec.ts**
- ✅ PublicFeatureFlagDto excludes sensitive fields
- ✅ Server-only flags filtered from findAllPublic()
- ✅ Principal-derived context extracts userId/wallet/roles
- ✅ Anonymous callers receive explicit anonymous context
- ✅ Anonymous callers cannot match user/role-targeted flags
- ✅ Percentage rollout uses authenticated identity
- ✅ Cache isolation: flag definitions cached, evaluations per-request
- ✅ Authorization separation: flags control UX, not permissions

**feature-flags-controller-security.spec.ts**
- ✅ Public endpoints return sanitized DTOs only
- ✅ Server-only flags rejected from public access
- ✅ evaluateFlag uses @CurrentUser, not query params
- ✅ Anonymous evaluation uses null principal
- ✅ Query params for userId/roles are not accepted
- ✅ Admin endpoints return full entities with guards

## Security Properties

### ✅ Public API Response Sanitization
- Public endpoints never return `rules`, `rolloutPercentage`, `metadata`, `version`, `createdBy`
- Targeted user IDs and role allowlists are not disclosed
- Only approved client-visible fields are included in DTOs

### ✅ Caller-Controlled Context Prevention  
- Old insecure signature: `evaluateFlag(@Query('userId') userId, @Query('roles') roles)`
- New secure signature: `evaluateFlag(@CurrentUser() principal: AuthenticatedPrincipal)`
- User identity and roles derived from JWT-verified principal
- Arbitrary query parameters cannot impersonate users or roles

### ✅ Server-Only Flag Protection
- `serverOnly: true` flags excluded from public endpoints
- Internal operational flags (circuit breakers, kill switches) remain hidden
- Admin endpoints require `JwtAuthGuard + AdminGuard` for full access

### ✅ Cache Isolation
- Flag definitions cached globally per environment
- Personalized evaluations computed per-request
- Cache keys do not include user-specific context
- No risk of cross-user result leakage

### ✅ Authorization Boundary
- Feature flags control UX rollout and experimental features
- Feature flags **do not replace** authorization guards
- Backend permission checks remain enforced independently
- Flag evaluation result does not grant access rights

## Acceptance Criteria Met

- ✅ Public APIs expose only explicit allowlisted feature-flag contract
- ✅ Caller-controlled query parameters cannot impersonate users or roles  
- ✅ Internal rollout rules and targeted user IDs not publicly disclosed
- ✅ Server-only flags not accessible from public routes
- ✅ Feature flags cannot substitute for authorization decisions
- ✅ Comprehensive tests verify all security properties

## Migration Path

1. **Deploy migration**: `1795263952634-AddServerOnlyToFeatureFlags.ts`
   - Adds `serverOnly` column with default `false`
   - Existing flags remain publicly accessible unless explicitly marked

2. **Mark internal flags as server-only**:
   ```sql
   UPDATE feature_flags 
   SET "serverOnly" = true 
   WHERE key IN ('internal-circuit-breaker', 'emergency-readonly', ...);
   ```

3. **Update client code**:
   - Remove `userId` and `roles` query parameters from evaluation requests
   - Parse `authenticated` field from `FeatureFlagEvaluationDto`
   - Handle sanitized public DTOs (no internal fields)

4. **Admin tooling**:
   - Use `/admin/feature-flags` endpoints for complete flag management
   - Requires admin authentication via JWT + AdminGuard

## Related Issues

- #825 — Configuration value protection (complementary work)
- #809 — Admin maintenance state persistence
- #831 — Persistence/runtime architecture reconciliation

## Testing

Run security tests:
```bash
npm test -- feature-flags-security.spec.ts
npm test -- feature-flags-controller-security.spec.ts
```

Run integration tests:
```bash
npm run test:integration
```

## Notes

- This implementation follows defense-in-depth principles
- Feature flags are a UX/rollout mechanism, not an authorization layer
- All backend authorization guards remain in place and enforced
- Public API now has a clear, documented security boundary
