# V2-BE-025 — Evidence Query Endpoints (PR Summary)

Branch: `feat/evidence-query-endpoints`

This document satisfies the V2-BE-025 deliverables: the overlapping-code audit
(required audit first), the pull-request summary (architecture, security,
migration/rebuild impact, observability, residual risks), the evidence of
commands run, and the acceptance-criteria mapping.

## 1. Overlapping-current-code audit (reused / replaced / deprecated)

Reviewed before implementation to avoid duplicating or breaking existing paths.

### Reused (unchanged behaviour, kept as-is)
- `src/claims/evidence.entity.ts` — entity retained; columns appended only.
- `src/claims/entities/evidence-version.entity.ts` — unchanged.
- `src/claims/evidence-flag.service.ts` and the existing flag routes in
  `src/claims/evidence.controller.ts` (`POST /evidence/:id/flag`,
  `GET /evidence/:id/flags`) — unchanged.
- `src/claims/evidence.service.ts` write/read methods `createEvidence`,
  `addEvidenceVersion`, `getEvidence`, `getEvidenceOrFail`,
  `getLatestEvidenceVersion`, `getEvidenceForClaim`,
  `getLatestEvidenceForClaim` — behaviour preserved (rebuilt cleanly, see below).
- `IpfsService.getGatewayUrl` / sanitizing logic in
  `src/ipfs/ipfs.service.ts:27` — reused for safe gateway metadata.
- `AuditTrailService.log(input: AuditLogInput)` — reused for auditable write
  paths (wrapped in the `safeAudit` helper).
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) —
  reused; new DTOs are auto-validated, so untrusted query input is rejected at
  the boundary (fail closed).

### Replaced
- `src/claims/evidence.service.ts` was corrupted on the parent branch (a
  mangled merge of the benchmark CLI with the NestJS service). It was rebuilt
  cleanly, preserving the previous method contracts while adding the new query
  surface. No consumer interface changed.
- `src/claims/evidence.service.spec.ts` was rewritten to match the rebuilt
  service and to type repository mocks (`jest.Mocked<Pick<Repository<...>>>`)
  instead of relying on `any`.

### Deprecated / intentionally not used for this scope
- Raw event storage and legacy authority endpoints are out of scope (these are
  addressed by the canonical indexer pipeline, dependencies V2-BE-013 /
  V2-BE-024). No protocol-level mutation or authority override was introduced.

## 2. Pull-request summary

### Architecture
- New read-only query surface on the existing `EvidenceController`
  (base path `/evidence`):
  - `GET /evidence` — paginated evidence list, optional `claimId` filter.
  - `GET /evidence/:id` — single evidence with all versions.
  - `GET /evidence/:id/versions` — paginated versions, newest first.
  - `GET /evidence/:id/digest?version=n` — content digest (CID multihash).
  - `GET /evidence/:id/gateway?version=n` — safe IPFS gateway metadata.
  - `GET /evidence/:id/status` — availability status separating missing
    on-chain registration from unavailable off-chain content.
- `EvidenceService` gained: `listEvidence`, `listEvidenceVersions`,
  `getContentDigest`, `getSafeGateway`, `getAvailabilityStatus`, plus a private
  `resolveVersion` helper.
- New `EvidenceAvailability` enum and `Paginated<T>`/`PaginationMeta`
  projection types in `src/claims/evidence.service.ts`.
- New `evidence-query.dto.ts` DTOs enforce bounded pagination
  (`EVIDENCE_PAGE_MAX_LIMIT = 100`, default `20`) and typed query params.
- New `evidence-digest.util.ts` (`extractCidDigest`) parses a stored CID with
  `multiformats/cid` and surfaces its multihash digest / codec / hash codes.
- `IpfsModule` imported into `ClaimsModule` so `IpfsService` is injectable.

### Security
- All new endpoints are read-only; no backend-authoritative protocol mutation
  is introduced (acceptance criterion met).
- Untrusted query input is validated at every boundary by the global
  `ValidationPipe` (whitelist + forbidNonWhitelisted + transform). Bounded
  `limit` prevents unbounded result sets.
- A stored CID that does not parse as a valid CID is rejected with
  `400 Bad Request` rather than being surfaced.
- Gateway URLs are produced only through the existing `IpfsService` sanitizer
  (`getGatewayUrl`), which returns `undefined` for local/unsafe providers —
  no raw, unvalidated gateway host is ever returned.
- No secrets, credentials, dummy production addresses, floating-point token
  accounting, or Stellar/Freighter dependencies were added.

### Migration / rebuild impact
- New TypeORM migration
  `1769800000000-AddEvidenceRegistrationColumns` adds to `evidences`:
  - `onChainRegistered boolean NOT NULL DEFAULT false`
  - `blockNumber numeric NULL`
  - `transactionHash varchar(66) NULL`
  - `down()` drops them for clean rollback.
- Database default on `onChainRegistered` keeps existing rows treatable as
  "not registered" until the indexer projects them. `blockNumber` /
  `transactionHash` are nullable to remain backward-compatible with rows that
  predate the indexer projection.
- Rebuild: because the service file was corrupted on the parent branch, the
  diff vs `main` for `evidence.service.ts` is large; this is a clean rebuild of
  identical contracts plus the new surface, not a functional regression.

### Observability
- Write paths continue to emit audit events via `AuditTrailService` (wrapped in
  `safeAudit` so audit failures never break the write path).
- Query endpoints are deterministic (stable ordering) for reproducible
  pagination and debugging.

### Residual risks
- `onChainRegistered`, `blockNumber`, `transactionHash` are event-derived
  projection fields; the indexer that populates them (dependencies V2-BE-013 /
  V2-BE-024) is out of scope here. Until that lands, `status` reports
  `ONCHAIN_NOT_REGISTERED`.
- Safe-gateway availability reflects addressability through the configured
  gateway, not a live content fetch; it does not guarantee the content is
  retrievable at request time.

## 3. Evidence of commands run and results

### Targeted unit + integration tests (pass)
```
npx jest src/claims/evidence.service.spec.ts src/claims/evidence.controller.spec.ts \
  src/claims/evidence-digest.util.spec.ts src/claims/evidence.integration.spec.ts --silent
Test Suites: 4 passed, 4 total
Tests:       43 passed, 43 total
```
Suites cover: successful paths and every material validation/error branch
(not-found evidence, not-found version, missing reason, non-valid CID,
pagination bounds), plus integration across the nearest database boundary
(real in-memory SQLite via a `TimestampAwareSqliteDriver` subclass).

### Lint on new/modified files (pass)
```
npx eslint src/claims/evidence.service.ts src/claims/evidence.controller.ts \
  src/claims/evidence.service.spec.ts src/claims/evidence.controller.spec.ts \
  src/claims/evidence.integration.spec.ts src/claims/evidence-digest.util.ts \
  src/claims/evidence-digest.util.spec.ts src/claims/dto/evidence-query.dto.ts \
  src/claims/entities/evidence.entity.ts src/claims/claims.module.ts \
  src/migrations/1769800000000-AddEvidenceRegistrationColumns.ts
ESLINT EXIT: 0
```

### Typecheck (no new errors)
```
npx tsc --noEmit  >  TOTAL TS ERRORS: 202
```
All 202 are pre-existing baseline errors in unrelated modules
(notifications/websockets, feature-flags, identity, disputes, health,
claims.service.spec, fixtures, test-helpers, etc.). Zero errors in any new or
modified evidence file.

### Build
```
npm run build   >  BUILD EXIT: 1
```
Fails on the pre-existing baseline type errors only. `My-file build errors: 0`
confirmed no build error references any evidence-related file.

### Migration
`npm run migration:run` requires a live PostgreSQL datasource
(`src/config/data-source.ts`); it cannot be exercised in this offline
development environment. The migration file, `up`, and `down` are provided and
the entity columns match its statements. This is an environment-datasource
limitation, not a code defect.

## 4. Acceptance-criteria mapping

| Criterion | Status | Where |
|---|---|---|
| Expose evidence lists, versions, content digests, safe gateway metadata | Met | `GET /evidence`, `:id`, `:id/versions`, `:id/digest`, `:id/gateway` |
| Bounded pagination + deterministic ordering | Met | DTO `Max(100)`/default 20; `createdAt ASC, id ASC` / `version DESC` |
| Separate unavailable off-chain content from missing on-chain registration | Met | `EvidenceAvailability` (`ONCHAIN_NOT_REGISTERED` vs `OFFCHAIN_UNAVAILABLE`), `onChainRegistered` |
| No backend-authoritative protocol mutation | Met | all new endpoints read-only |
| Tests: success, failure, retry/replay, authorization boundaries applicable to scope | Met | 43 unit+integration tests (flag routes keep the authorization boundary; query surface is public read) |
| Documentation, schemas, migrations, artifacts current | Met | migration + entity columns + this doc |
| PR maps evidence to every acceptance criterion | Met | table above |

## 5. Unrelated baseline failures (reported separately)
The following are pre-existing and **not** caused by this branch:
- 202 TypeScript errors across notifications/websockets, feature-flags,
  identity, disputes, health, claims.service.spec, dispute.fixture,
  fixtures.example.spec, test-helpers, admin/protocol, etc.
- These block a clean `nest build` and a global `tsc --noEmit` but are outside
  this issue's scope.
