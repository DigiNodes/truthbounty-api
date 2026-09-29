# Auth Timing Side-Channel Hardening (issue-416)

## Objective

Eliminate authentication timing side channels as a focused, independently
reviewable V2 backend work item (depends on V2-BE-044).

## What changed

- New shared helper `src/common/utils/timing-safe.util.ts`:
  `timingSafeEqualBytes/Utf8/Hex`, `constantTimeAddressEqual`. Length
  mismatches perform dummy `timingSafeEqual(a, a)` work and never throw
  (fixes `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` 500-vs-false oracle).
- `AuthService.login`: timing-safe address + challenge-message compares;
  **all** failures (bad signature, address mismatch, missing/corrupt/expired
  challenge, invalid nonce) collapse to constant-shape
  `401 { code: AUTH_UNAUTHORIZED, message: "Invalid credentials" }`.
  Distinct reasons are logged server-side only (redacted, observable,
  fail-closed). Dummy compare work normalizes hit-vs-miss timing.
- `TokenService.refreshAccessToken`: `sha256` refresh-token hash compared
  with `timingSafeEqualHex`; malformed/revoked/missing/corrupt/mismatch all
  return generic `401 Invalid credentials`. Mismatch still revokes all user
  sessions (theft fail-closed).
- `WebhooksService.verifySignature`: fixed unguarded `timingSafeEqual`
  via `timingSafeEqualHex` (no throw on length mismatch).
- `SiweService.verifySiwe`: timing-safe address/domain/origin compares;
  all failures return generic `AUTH_FAILED` (single shape), reasons logged
  internally. No `ADDRESS_MISMATCH` / `DOMAIN_MISMATCH` / ... oracles.
- Legacy `SiweVerificationService` + `WalletLinkageService` (TypeORM, not
  wired in `AuthModule`): same timing-safe + redacted constant-shape fixes;
  no new TypeORM persistence added (Prisma remains canonical).
- `IdentityService` (Prisma `linkWallet` / `unlinkWallet` / `getUser` /
  `findUserByAddress`): timing-safe compares, redacted messages (no address
  / id echo), not-found-vs-forbidden collapsed for unlink, already-linked
  vs user-missing use generic messages. Exception *types* preserved for
  REST semantics; *messages* are constant-shape.
- `AuthExceptionFilter`: all `401` auth failures collapse to
  `{ code: AUTH_UNAUTHORIZED, message: "Invalid credentials" }` externally;
  granular codes kept in server logs. `429` / `403` shapes unchanged.
- `IdentityController.linkWallet/unlinkWallet`: added
  `@ThrottleByWallet('auth')` (5 req/60s) to match `AuthController`.
- `ServiceAuthGuard`: now delegates to the shared helper (single canonical
  implementation).

## Non-goals (preserved)

- No password / recovery / OTP paths exist; auth remains wallet-signature
  (EVM/Optimism) only. No Stellar / Soroban / Freighter deps added.
- API only indexes/validates/caches/relays user-signed intent; never
  authoritative for settlement, rewards, treasury, or governance.
- No secrets, PII, or placeholder prod config committed.

## Recovery path contract (for future work)

If password/recovery is ever introduced: use `bcrypt.compare` (constant
time) for passwords, `timingSafeEqualHex` for reset tokens, single-shape
`401 Invalid credentials` externally, Prisma `User` extension only.

## Failure modes (bounded, observable, redacted, fail-closed)

| Path | External response | Internal |
|---|---|---|
| login any failure | `401 Invalid credentials` | `warn [signature-parse\|address-mismatch\|challenge-not-found\|...]` |
| refresh any failure | `401 Invalid credentials` | `warn [malformed\|revoked\|not-found\|mismatch]` + revoke-all on mismatch |
| wallet-link signature | `400 Invalid credentials` | `warn signature parse/verify failed` |
| wallet-link taken/missing user | `409/404 Wallet linkage failed` (redacted) | `warn [already-linked]` |
| unlink not-found/forbidden | `404 Wallet unlink failed` (collapsed) | `warn [not-found-or-forbidden]` |
| webhook bad signature | `false` (no throw) | caller decides 401 |

## Concurrency / idempotency

- Nonce single-use via Redis `GET` + `DEL` (replay prevented); concurrent
  logins with the same nonce: exactly one succeeds, others get generic 401.
- Refresh rotation: old `auth:refresh:<jti>` deleted + blacklisted
  atomically per request; concurrent reuse triggers theft revocation.
- `linkWallet` runs in Prisma `$transaction`; duplicate link is idempotent
  no-op (`alreadyLinked: true`, same response shape).

## Verification

- `npm run lint`, `npx tsc --noEmit`, `npm test` (incl. new
  `timing-safe.util.spec.ts`), `npm run test:e2e`, `npm run build`,
  `npx prisma validate`.
- Integration: real PostgreSQL/Redis or deterministic containers for
  login/refresh/link replay + concurrency tests.
- Human maintainer approval required for auth/database/sensitive changes.

## Evidence map (acceptance criteria)

- Scope without unrelated protocol/UI changes: only `auth/*`,
  `identity/*`, `webhooks verify`, `common/utils`, docs.
- Bounded/observable/redacted/fail-closed: table above + server logs.
- Concurrency/idempotency explicitly tested: nonce single-use, refresh
  rotation, link no-op.
- Docs updated: this runbook + Swagger `@ApiResponse` + `src/auth/README`
  note (see below).
- PR maps evidence to every criterion: this file.
