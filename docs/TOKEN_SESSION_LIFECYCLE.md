# Token and Session Lifecycle Documentation

## Overview

This document describes the canonical session key model, token lifecycle, and refresh rotation behavior implemented in `TokenService`. All session management is fail-closed: Redis operation failures result in exceptions rather than silent success.

## Session Key Schema

The TokenService uses a consistent Redis key model with no legacy parallel schemes:

### Primary Keys

- **Session metadata**: `auth:session:{refreshJti}`
  - Stores complete `SessionMetadata` object as JSON
  - TTL: `REFRESH_TOKEN_TTL_SECONDS` (default: 7 days)
  - Deleted atomically during refresh rotation
  
- **User session index**: `auth:user_sessions:{address}`
  - Stores JSON array of refresh JTIs for a given wallet address
  - TTL: `REFRESH_TOKEN_TTL_SECONDS` (default: 7 days)
  - Maintained via Lua scripts for atomic updates
  - Used for wallet-wide revocation

- **Token blacklist**: `auth:blacklist:{jti}`
  - Stores `'1'` for revoked tokens (both access and refresh)
  - TTL: Remaining token lifetime (never longer than necessary)
  - Checked before accepting any token

- **Capability nonce**: `auth:capability_nonce:{nonce}`
  - Stores capability binding metadata as JSON
  - TTL: Capability token expiry (max 5 minutes)
  - Consumed atomically during validation

### Address Normalization

All addresses are normalized to lowercase before use as Redis keys or session metadata fields:
```typescript
const normalizedAddress = address.toLowerCase();
```

### Subject Mapping

The JWT `sub` claim is determined by account type:
- **User-backed sessions**: `sub = userId` (string user ID)
- **Wallet-only sessions**: `sub = address.toLowerCase()` (normalized address)

## Token Pair Generation

### Process

1. Generate access token JWT with:
   - `sub`: userId or normalized address
   - `address`: normalized address
   - `userId`: user ID or null
   - `jti`: random 16-byte hex string (access JTI)
   - `type`: 'access'
   - `aud`: configured audience (default: 'truthbounty-api')
   - `iss`: configured issuer (default: 'truthbounty-api')

2. Generate refresh token:
   - Format: `{refreshJti}.{base64url(48 random bytes)}`
   - `refreshJti`: random 16-byte hex string
   - Total entropy: 384 bits in random portion + 128 bits in JTI

3. Store session metadata:
   - Hash refresh token: `sha256(refreshToken)` → `tokenHash`
   - Create `SessionMetadata` object with all context
   - Write to `auth:session:{refreshJti}` with TTL
   - **Fail-closed**: If write fails, throw `InternalServerErrorException`

4. Update user session index:
   - Add `refreshJti` to `auth:user_sessions:{address}` array via Lua script
   - Lua script ensures atomicity and idempotency
   - **Fail-closed**: If index write fails, delete session metadata and throw

### Session Metadata Structure

```typescript
interface SessionMetadata {
  jti: string;                    // Refresh JTI
  tokenHash: string;              // SHA-256 hash of full refresh token
  address: string;                // Normalized wallet address
  userId: string | null;          // User ID if linked, null otherwise
  accessJti: string;              // Current access token JTI
  createdAt: number;              // Unix timestamp (ms)
  lastActivityAt: number;         // Unix timestamp (ms)
  deviceInfo?: DeviceInfo;        // Optional device fingerprint
  ipAddress?: string;             // Normalized IP address
  userAgent?: string;             // User agent string
  revokedAt?: number;             // Revocation timestamp (if revoked)
  revocationReason?: string;      // Human-readable reason
}
```

## Refresh Token Rotation

### Atomic Rotation Process

Refresh token rotation is atomic and replay-safe using a Lua script:

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then 
  return redis.call('DEL', KEYS[1]) 
end 
return 0
```

**Key properties:**
- Exactly one concurrent refresh succeeds (others get `0` and fail)
- Session consumed before new session created (no session duplication)
- Hash verified with timing-safe comparison before consumption attempt

### Step-by-Step Rotation

1. **Parse refresh token**: Extract `refreshJti` from format
2. **Blacklist check**: Verify token not already revoked
3. **Fetch session**: Get `auth:session:{refreshJti}`
4. **Validate structure**: Check all required fields present and well-formed
5. **Hash comparison**: Timing-safe comparison of supplied vs stored hash
   - **Mismatch = theft detection**: Revoke all user sessions
6. **Atomic consumption**: Lua compare-and-delete with exact value match
   - **Concurrent use**: Second attempt sees different/missing value → fails
7. **Blacklist old token**: Write `auth:blacklist:{refreshJti}`
   - **Fail-closed**: If write fails, throw `InternalServerErrorException`
8. **Update index**: Remove consumed JTI from user session index
9. **Generate new pair**: Call `generateTokenPair()` with preserved context

### Security Properties

- **Single-use**: Consumed session cannot be reused (Lua script ensures atomicity)
- **Replay protection**: Blacklist prevents reuse even if session recreated elsewhere
- **Theft detection**: Hash mismatch triggers wallet-wide revocation
- **Constant-time failure**: All failure modes return generic `AUTH_GENERIC_FAILURE_MESSAGE`
- **No enumeration**: External callers cannot distinguish failure reasons

## Access Token Validation

### Validation Steps

1. Check token type is `'access'` (not `'refresh'` or `'capability'`)
2. Verify required fields present: `jti`, `address`, `sub`
3. Validate address format: `/^0x[0-9a-f]{40}$/i`
4. Check audience includes configured `ACCESS_TOKEN_AUDIENCE`
5. Check issuer matches configured `TOKEN_ISSUER`
6. Verify subject matches derived value:
   - `userId` present: `sub === String(userId)`
   - Wallet-only: `sub === address.toLowerCase()`
7. Query blacklist: `auth:blacklist:{jti}`

**Fail-fast**: Structure/claim validation happens before blacklist lookup to avoid unnecessary Redis calls.

## Logout

### Single Session Logout

When `jti` is provided (current access token):

1. Blacklist access token with remaining TTL:
   - `TTL = max(1, exp - floor(now / 1000))`
   - **Fail-closed**: If blacklist write fails, throw
2. Proceed to wallet-wide revocation

### Wallet-Wide Revocation

Performed by `revokeAllUserTokens(address)`:

1. Fetch user session index: `auth:user_sessions:{address}`
2. If no index, return early (no sessions to revoke)
3. Parse index (handle both JSON array and legacy single-JTI format)
4. For each session JTI:
   - Fetch session metadata
   - Blacklist both refresh JTI and access JTI
   - **Fail-closed**: If any blacklist write fails, throw
   - Delete session metadata
   - **Fail-closed**: If session existed and delete fails, throw
5. Delete user session index
   - **Fail-closed**: If delete fails, throw

### Error Handling

All Redis operation failures during logout/revoke throw:
- `InternalServerErrorException('Unable to revoke authentication token')`
- `InternalServerErrorException('Unable to revoke authentication session')`
- `InternalServerErrorException('Unable to remove authentication session')`
- `InternalServerErrorException('Unable to remove authentication session index')`

**Consequence**: Partial failures are not silently ignored. Caller/client can retry.

## Blacklist Queries

### isBlacklisted(jti: string)

Simple lookup: `GET auth:blacklist:{jti}`

Returns:
- `true` if key exists (token is revoked)
- `false` if key does not exist (token is active or expired)

**Used by:**
- `refreshAccessToken()`: Check refresh token not revoked
- `validateAccessToken()`: Check access token not revoked

## Capability Tokens

Capability tokens use a separate lifecycle:

- **Nonce-based replay protection**: Each capability has unique nonce
- **Atomic consumption**: Nonce consumed via compare-and-delete Lua script
- **Bounded expiry**: Hard cap of 5 minutes
- **Explicit binding**: Capability tied to audience, subject, resource, chain, release, deployment, artifact

Capability tokens do not interact with session lifecycle or blacklist. They are single-use and expire quickly.

## Index Maintenance

### Adding Session to Index

Done during `generateTokenPair()` via Lua script:

```lua
local raw = redis.call('GET', KEYS[1])
local ids = {}
if raw then 
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then 
    return redis.error_reply('Invalid user session index') 
  end
  ids = decoded 
end
for _, id in ipairs(ids) do 
  if id == ARGV[1] then 
    redis.call('EXPIRE', KEYS[1], ARGV[2])
    return 1 
  end 
end
table.insert(ids, ARGV[1])
redis.call('SETEX', KEYS[1], ARGV[2], cjson.encode(ids))
return 1
```

**Properties:**
- Idempotent: Adding same JTI twice is no-op
- Atomic: Array update and TTL refresh in single operation
- Error-safe: Corrupt index returns error (not silently overwritten)

### Removing Session from Index

Done during `removeSessionFromIndex()` via Lua script:

```lua
local raw = redis.call('GET', KEYS[1])
if not raw then return 1 end
local ok, ids = pcall(cjson.decode, raw)
if not ok or type(ids) ~= 'table' then 
  return redis.error_reply('Invalid user session index') 
end
local updated = {}
for _, id in ipairs(ids) do 
  if id ~= ARGV[1] then 
    table.insert(updated, id) 
  end 
end
if #updated == 0 then 
  return redis.call('DEL', KEYS[1]) 
end
local ttl = redis.call('TTL', KEYS[1])
redis.call('SET', KEYS[1], cjson.encode(updated))
if ttl > 0 then 
  redis.call('EXPIRE', KEYS[1], ttl) 
end
return 1
```

**Properties:**
- Removes specified JTI from array
- Deletes index if array becomes empty
- Preserves original TTL on updated index
- Error-safe: Corrupt index returns error

## Multi-Instance Behavior

### Session Sharing

Sessions are shared across all backend instances via Redis:
- Any instance can validate any token
- Any instance can rotate any refresh token (atomic consumption prevents conflicts)
- Any instance can revoke any session

### Clock Skew

- **Redis TTL**: Authoritative expiry enforcement
- **JWT exp claim**: Advisory expiry (validated by JWT library)
- **Blacklist TTL**: Covers remaining token lifetime from any instance's perspective

Instances do not need synchronized clocks for correctness (Redis is source of truth).

## Testing Strategy

### Unit Test Coverage

Tests verify:
- ✅ All AuthService → TokenService calls are type-safe
- ✅ Valid refresh rotates exactly once
- ✅ Concurrent refresh attempts produce at most one successor
- ✅ Malformed, expired, revoked, unknown, hash-mismatched tokens all return generic 401
- ✅ Hash mismatch revokes wallet sessions
- ✅ Access token blacklist checks work
- ✅ Logout invalidates access + refresh tokens
- ✅ Administrative revocation works for user-linked and wallet-only sessions
- ✅ Redis failures during session creation/rotation/logout/revocation throw errors
- ✅ Tests use current key schema (no legacy key references)

### Key Test Cases

**Refresh rotation:**
- Atomic consumption with Lua script exact-value comparison
- Concurrent use detected (second attempt fails)
- Blacklist write failure causes exception (not silent success)
- Session metadata validation rejects corrupt/incomplete data

**Session creation:**
- Metadata write failure prevents token return
- Index write failure triggers rollback of metadata

**Revocation:**
- Blacklist write failure throws
- Session delete failure throws (when session existed)
- Index delete failure throws

## Related Issues

- **#841**: Refresh token hashing in token-pair generation (separate concern)
- **#842/#843**: Wallet challenge consumption and SIWE verification (separate concern)
- **#831**: Persistence authority decision (Prisma vs Redis) - this implementation respects current Redis-based design
- **#813**: Credential rotation and secret provisioning (configuration concern)

## Non-Goals

- Changing protocol authority or backend-authoritative mutations
- Introducing additional persistence layers
- Modifying Drips points or wave assignments
