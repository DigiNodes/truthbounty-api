# TruthBounty API Documentation

This document provides a reference for the TruthBounty API. TruthBounty is a
decentralized news verification infrastructure. Claim and evidence protocol
transitions are submitted by users through their wallets; the API indexes and
serves finalized canonical projections.

## Base URL

```
http://localhost:3000
```

## Swagger UI

The API documentation is also available via Swagger UI at:

```
http://localhost:3000/api
```

## API Endpoints

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check endpoint |

---

### Claims and evidence

The protocol is chain-authoritative. The API does not create claims or register,
replace, or remove evidence. Claims are submitted by the user's wallet; the API
serves only event-derived projections. Legacy routes remain as migration
stubs and return `410 Gone` with a canonical replacement path.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v2/claim-read-models` | Canonical, release-bound claim projection |
| GET | `/api/v2/claim-read-models/:claimId` | Canonical projected claim detail |
| GET | `/v2/claims/:claimId/evidence` | Canonical event-projected evidence |
| GET | `/v2/claims/:claimId/evidence/versions` | Canonical projected evidence versions |
| GET | `/api/v2/claims/*` (legacy feed) | Deprecated compatibility path; returns 410 |
| GET | `/claims/*` (legacy) | Deprecated compatibility path; returns 410 |
| POST | `/claims` (legacy) | Returns 410; submit via the user's wallet |
| POST | `/claims/:claimId/evidence` (legacy) | Returns 410; registration requires wallet transaction |
| PUT | `/claims/evidence/:evidenceId` (legacy) | Returns 410; replacement requires wallet transaction |

#### Chain-first lifecycle

1. Prepare and validate any off-chain content; an IPFS CID alone is not
   protocol registration. This API currently exposes no claim-evidence upload
   route.
2. The user's wallet submits the claim or evidence transaction directly to the
   approved contract. The API never signs or relays it.
3. Wait for the contract event to reach the configured finality threshold.
4. Read the resulting state from the canonical projection endpoints above.
   Until ingestion completes, the claim/evidence may be pending or not found;
   never treat a submitted transaction or uploaded CID as projected state.

---

### Evidence

Manage evidence with flagging capabilities.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/evidence/:id/flag` | Flag evidence for review |
| GET | `/evidence/:id/flags` | Get flags for evidence (admin only) |

**Path Parameters:**
- `:id` - Evidence ID

**Request Body (POST /evidence/:id/flag):**
```json
{
  "reason": "string",
  "flaggedBy": "string (optional)"
}
```

**Query Parameters:**
- "admin" - Set to `true` to access flags (admin only)

---

### Disputes

Create and resolve disputes.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/disputes` | Create a new dispute |
| PATCH | `/disputes/:id/start-review` | Start dispute review process |
| PATCH | `/disputes/:id/resolve` | Resolve a dispute |
| PATCH | `/disputes/:id/reject` | Reject a dispute as spam/invalid |
| GET | `/disputes/claim/:claimId` | Get dispute by claim ID |
| GET | `/disputes/expired` | Get expired disputes |
| GET | `/disputes` | Get all disputes with optional filters |

**Path Parameters:**
- `:id` - Dispute ID
- `:claimId` - Claim ID

**Query Parameters:**
- "status" - Filter by dispute status
- "trigger" - Filter by dispute trigger

**Request Body (POST /disputes):**
```json
{
  "claimId": "string",
  "trigger": "MANUAL_REPORT | LOW_CONFIDENCE | EVIDENCE_CONFLICT",
  "originalConfidence": "number",
  "initiatorId": "string (optional)",
  "metadata": "object (optional)"
}
```

**Request Body (PATCH /disputes/:id/resolve):**
```json
{
  "outcome": "APPROVED | REJECTED | SPLIT",
  "finalConfidence": "number",
  "metadata": "object (optional)"
}
```

**Request Body (PATCH /disputes/:id/reject):**
```json
{
  "reason": "string"
}
```

---

### Identity

User and wallet identity management.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/identity/users` | Create a new user |
| GET | `/identity/users/:id` | Get user by ID |
| POST | `/identity/users/:id/wallets` | Link wallet to user |
| DELETE | `/identity/users/:id/wallets/:chain/:address` | Unlink wallet from user |
| POST | `/identity/users/:id/verify-worldcoin` | Mark user as Worldcoin verified |
| GET | `/identity/users/:id/sybil-score` | Get user's Sybil score |

**Path Parameters:**
- `:id` - User ID
- `:chain` - Blockchain chain (e.g., ethereum, solana)
-  `:address` - Wallet address

**Request Body (POST /identity/users/:id/wallets):**
```json
{
  "address": "string",
  "chain": "string",
  "signature": "string"
}
```

---

### Worldcoin

Worldcoin ID verification.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/identity/worldcoin/verify` | Verify a user using Worldcoin ID |
| GET | `/identity/worldcoin/status/:userId` | Get verification status for a user |
| GET | `/identity/worldcoin/verification/:nullifierHash` | Get verification by nullifier hash |

**Path Parameters:**
- `:userId` - User ID
-  `:nullifierHash` - Nullifier hash

**Request Body (POST /identity/worldcoin/verify):**
```json
{
  "userId": "string",
  "proof": "string",
  "action": "string",
  "signal": "string"
}
```

**Response:**
```json
{
  "success": true,
  "verification": {
    "id": "string",
    "userId": "string",
    "verificationLevel": "string",
    "verifiedAt": "string"
  }
}
```

---

### Sybil Resistance

Sybil resistance scoring.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/sybil/users/:userId/score` | Compute and store Sybil score |
| GET | `/sybil/users/:userId/score` | Get most recent Sybil score |
| GET | `/sybil/users/:userId/public-score` | Get privacy-safe public Sybil score (redacted) |
| POST | `/sybil/users/:userId/recompute` | Deterministic recompute with pinned version |
| POST | `/sybil/users/:userId/appeal` | Submit appeal against score evaluation |
| GET | `/sybil/users/:userId/appeals` | Get appeal history for user |
| GET | `/sybil/models` | List available Sybil score model versions |
| GET | `/sybil/users/:userId/history` | Get Sybil score history |
| GET | `/sybil/users/:userId/voting` | Get Sybil score for voting |
| POST | `/sybil/users/:userId/verify-worldcoin` | Mark user as Worldcoin verified |
| POST | `/sybil/recalculate-all` | Recalculate all Sybil scores (admin) |

**Path Parameters:**
- `:userId` - User ID

**Request Body (POST /sybil/users/:userId/verify-worldcoin):**
```json
{
  "verified": true
}
```

---

### Admin Authentication

Admin login binds the authentication attempt to the wallet principal of the verified JWT. The caller-supplied request body is not an identity source.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/auth/login` | Authenticate the verified JWT principal as an admin |

**Authorization:** Requires `Authorization: Bearer <token>`. The wallet address is derived exclusively from the verified JWT principal (`request.user`).

**Request Body:** None. The legacy `address` field is not part of the contract. If supplied for compatibility, it must exactly match (after normalization) the verified principal address; any mismatch is rejected before admin lookup or state change.

**Responses:**

| Status | Description |
|--------|-------------|
| `200` | Verified principal matches an active admin; login metadata (`lastLoginAt`) updated after successful authentication |
| `400` | Malformed or mismatched body address |
| `401` | Missing, malformed, revoked, or expired JWT principal |
| `403` | Non-admin or inactive identity; response is identical for unknown and inactive admins (non-enumerating) |

**Notes:**
- `lastLoginAt` is updated only after the principal is matched to an active admin and the session operation has succeeded.
- This endpoint does not issue an admin session by itself and does not bypass the admin-plane guard or role hierarchy.

---

### Blockchain

Blockchain event indexing and state management.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/blockchain/blocks/process` | Process a new block and its events |
| GET | `/api/v1/blockchain/indexing/stats` | Get indexing statistics |
| GET | `/api/v1/blockchain/chain/state` | Get chain state |
| GET | `/api/v1/blockchain/events/pending` | Get all pending events |
| GET | `/api/v1/blockchain/events/confirmed` | Get all confirmed events |
| GET | `/api/v1/blockchain/events/orphaned` | Get all orphaned events |
| GET | `/api/v1/blockchain/events/:eventId` | Get event by ID |
| GET | `/api/v1/blockchain/reorg/history` | Get reorg history |
| GET | `/api/v1/blockchain/reorg/statistics` | Get reorg statistics |
| GET | `/api/v1/blockchain/state/verify` | Verify state consistency |
| GET | `/api/v1/blockchain/blocks/:blockNumber/events` | Get events at specific block |
| GET | `/api/v1/blockchain/blocks/:blockNumber/canonical` | Get canonical block at height |
| POST | `/api/v1/blockchain/state/reset` | Manual state reset (testing/recovery) |
| POST | `/api/v1/blockchain/votes/resolve` | Resolve claim using weighted voting |
| POST | `/api/v1/blockchain/votes/validate` | Validate vote data |
| GET | `/api/v1/blockchain/config/resolution` | Get resolution configuration |
| POST | `/api/v1/blockchain/config/resolution` | Update resolution configuration |
| POST | `/api/v1/blockchain/votes/simulate` | Simulate claim resolution |

**Path Parameters:**
-  `:eventId` - Event ID
- `:blockNumber` - Block number

**Request Body (POST /api/v1/blockchain/blocks/process):**
```json
{
  "block": {
    "number": "number",
    "hash": "string",
    "timestamp": "string"
  },
  "events": []
}
```

**Request Body (POST /api/v1/blockchain/votes/resolve):**
```json
{
  "votes": [
    {
      "claimId": "string",
      "userId": "string",
      "verdict": "TRUE | FALSE",
      "userReputation": "number",
      "stakeAmount": "string",
      "timestamp": "string",
      "eventId": "string"
    }
  ],
  "config": {
    "quorumThreshold": "number (optional)",
    "minReputation": "number (optional)"
  }
}
```

**Request Body (POST /api/v1/blockchain/votes/simulate):**
```json
{
  "scenario": "clear_majority | tie | low_confidence | whale_dominance | insufficient_weight",
  "config": "object (optional)"
}
```

---

### Indexer

Event indexer management.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/indexer/status` | Get current indexer status |
| POST | `/indexer/restart` | Restart the indexer |
| POST | `/indexer/backfill` | Backfill events from a specific block |

**Request Body (POST /indexer/backfill):**
```json
{
  "contractAddress": "string",
  "blockNumber": "number"
}
```

---

### Rewards

The legacy rewards API has been deprecated. The collection and ID-based
endpoints return `410 Gone`. There is no direct V2 equivalent for legacy
reward IDs.

Reward data must be read from the canonical V2 claim projections where
applicable.

| Method | Endpoint | Status | Description |
|--------|----------|--------|-------------|
| GET | `/rewards` | 410 Gone | Deprecated legacy rewards collection |
| GET | `/rewards/:id` | 410 Gone | Deprecated legacy reward lookup |

**Migration:**
- Use `GET /api/v2/claims/:claimId/rewards` for the V2 reward projection.
- The V2 endpoint is claim-scoped; legacy reward IDs are not interchangeable
  with claim IDs.
- The legacy API no longer supports creating, updating, or deleting rewards.

---

### Leaderboard

User leaderboard rankings.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/leaderboard` | Get leaderboard rankings |

**Query Parameters:**
- "type" - Leaderboard type: `global` or `weekly` (default: `global`)

---

### Audit

Audit log retrieval.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/audit` | Get all audit logs with optional filters |
| GET | `/audit/entity/:entityType/:entityId` | Get audit logs for a specific entity |
| GET | `/audit/user/:userId` | Get audit logs for a specific user |
| GET | `/audit/action/:actionType` | Get audit logs for a specific action type |
| GET | `/audit/changes/:entityType/:entityId` | Get change history for an entity |
| GET | `/audit/summary` | Get audit summary for an entity type |

**Path Parameters:**
- `:entityType` - Entity type (e.g., CLAIM, USER, DISPUTE)
- `:entityId` - Entity ID
-  `:userId` - User ID
- `:actionType` - Action type (e.g., CLAIM_CREATED, EVIDENCE_ADDED)

**Query Parameters:**
- "entityType" - Filter by entity type
- "actionType" - Filter by action type
- "userId" - Filter by user ID
- "limit" - Number of results (default: 100, max: 500)
- "offset" - Offset for pagination
- "days" - Number of days for summary (default: 7)

---

### Inbound Webhooks

Signed inbound webhook delivery from external providers. All requests are verified before any state is committed.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhooks/:provider` | Receive a signed webhook delivery from a provider |

**Path Parameters:**
- `:provider` - Provider identifier. Unknown providers fail closed with `404`.

**Request Headers:**
- `Content-Type: application/json`
-  `<provider-signature-header>` - Provider-specific signature header (see below)
- `<provider-timestamp-header>` - Provider-specific timestamp header (see below)
- `<provider-delivery-id-header>` - Provider-specific delivery ID header (see below)

**Signed bytes and headers by provider:**

| Provider | Signature header | Timestamp header | Delivery ID header | Signed bytes | Algorithm |
|----------|------------------|------------------|------------------|--------------|----------|
| `stellar` | `Stellar-Signature` | `Stellar-Timestamp` | `Stellar-Delivery-ID` | `<timestamp>.<raw-body-bytes>` | HMAC-SHA256 |
| `coinbase` | `CB-Signature` | `CB-Timestamp` | `CB-Delivery-ID` | `<timestamp>.<raw-body-bytes>` | HMAC-SHA256 |
| `github` | `X-Hub-Signature-256` | (No timestamp header; timestamp is taken from the signed payload) | `X-GitHub-Delivery` | `<raw-body-bytes>` | HMAC-SHA256 |

**Signature verification rules:**
- The signature is computed over the exact raw request body bytes as received. The body is not re-serialized, re-ordered, or normalized before verification.
- Timestamps are validated against a provider-specific tolerance window (default 300 seconds). Deliveries outside the window are rejected with `401`.
- Signatures are compared using a constant-time comparison. Mismatches are rejected with `401`.
- Keys are rotated via a key set per provider. Verification succeeds if any active key in the set verifies the signature; keys are identified by a key ID prefix when present.
-  Delivery IDs are unique per provider. A repeated delivery ID is rejected with `409` and no state change is committed (transactional replay rejection).
- Request body size is limited to 1 MiB (configurable per provider). Oversized requests are rejected with `413`.
-  Secrets are never included in responses or logs. Verification failures log only the provider, delivery ID, and a reason code.

**Responses:**

| Status | Description |
|--------|-------------|
| `200` | Delivery accepted and processed |
| `400` | Malformed headers or payload |
| `401` | Invalid signature, body mutation, or timestamp outside tolerance window |
| `404` | Unknown provider (fails closed) |
| `409` | Duplicate delivery ID (replay) |
| `413` | Request body exceeds size limit |

---

## Data Types

### DisputeStatus

| Value | Description |
|-------|-------------|
| `PENDING` | Dispute is pending review |
| `IN_REVIEW` | Dispute is being reviewed |
| `RESOLVED` | Dispute has been resolved |
| `REJECTED` | Dispute was rejected as spam |
| `EXPIRED` | Dispute has expired |

### DisputeTrigger

| Value | Description |
|-------|-------------|
| `MANUAL_REPORT` | Manually reported by user |
| `LOW_CONFIDENCE` | Triggered by low confidence score |
| `EVIDENCE_CONFLICT` | Triggered by conflicting evidence |

### DisputeOutcome

| Value | Description |
|-------|-------------|
| `APPROVED` | Claim was approved |
| `REJECTED` | Claim was rejected |
| `SPLIT` | Decision was split/ambiguous |

### AuditEntityType

| Value | Description |
|-------|-------------|
| `CLAIM` | Claim entity |
| `USER` | User entity |
| `DISPUTE` | Dispute entity |
| `EVIDENCE` | Evidence entity |
| `REWARD` | Reward entity |

### AuditActionType

| Value | Description |
|-------|-------------|
| `CLAIM_CREATED` | Claim was created |
| `CLAIM_UPDATED` | Claim was updated |
| `CLAIM_DELETED` | Claim was deleted |
| `EVIDENCE_ADDED` | Evidence was added |
| `EVIDENCE_UPDATED` | Evidence was updated |
| `EVIDENCE_FLAGGED` | Evidence was flagged |
| `DISPUTE_CREATED` | Dispute was created |
| `DISPUTE_RESOLVED` | Dispute was resolved |
| `REWARD_CLAIMED` | Reward was claimed |

---

### AI Assistant

Conversational AI assistance over protocol knowledge, with context retrieval, streaming, safety guardrails, and usage analytics. All routes require a JWT (`Authorization: Bearer <token>`), including GEts — conversations are private per user. Responses are wrapped in a standard envelope: `{ success, requestId, timestamp, data, error, meta? }`. Full request/response schemas are in Swagger UI.

---

## Claim State and Finality

The API does not expose a claim-verdict or finalization write operation.
`POST /claims` creates claim metadata only; client-supplied `verdict`,
`confidenceScore`, or `finalized` fields do not set protocol state.

The release-bound, read-only endpoints are:

| Method | Route | Behavior |
|--------|-------|----------|
| GET | `/api/v2/claim-read-models` | Read-only list with projection freshness and release provenance |
| GET | `/api/v2/claim-read-models/:claimId` | Read-only claim projection with the same provenance |
| GET | `/api/v2/claims` and `/api/v2/claims/:id` | Deprecated metadata-only feed; does not publish verdict/finality |

A `FINALIZED` row is served as finalized only when its source identity matches
one canonical `VerdictSettled` event, the event's artifact version and verdict
contract address match the configured release provenance (and `SUBMITTED` rows
must match the configured claim-registry address), the event has a
valid opaque verdict code, and that contract's finalized checkpoint covers the
event block. Otherwise the API fails closed or keeps the outcome provisional.
The opaque decimal `verdictCode` is included only after finality and is never
interpreted as a verdict label until the pinned release's mapping is verified.

Read-model release configuration must include
`CLAIM_READ_MODEL_ARTIFACT_VERSION` and
`CLAIM_READ_MODEL_CLAIM_REGISTRY_ADDRESS` plus
`CLAIM_READ_MODEL_VERDICT_CONTRACT_ADDRESS` in addition to the chain, release,
deployment block, and artifact checksum. Missing or mismatched provenance
returns a fail-closed error.

The former `GET /claims/read-model/:claimId` and
`POST /claims/read-model/:claimId/reproject` routes were removed. The latter
replayed an unversioned lifecycle-event table and was not a safe canonical
projection input. No compatibility alias is retained.

| HTTP Status | Code | Meaning | Retryable |
|-------------|------|---------|----------|
| 404 | `CANONICAL_CLAIM_NOT_FOUND` | Claim does not exist in canonical state for the bound chain / release / deployment block | false |
| 403 | `CANONICAL_CLAIM_FORBIDDEN` | Actor is not authorized to perform the transition on this claim | false |
| 409 | `CANONICAL_CLAIM_WRONG_PHASE` | Requested transition is not valid from the claim's current phase | false |
| 409 | `CANONICAL_CLAIM_DUPLICATE` | Idempotent retry detected an equivalent prior transition with differing payload | false |
| 409 | `CANONICAL_CLAIM_INVALID_TRANSITION` | Transition is not permitted by the canonical contract state machine | false |
| 410 | `CANONICAL_CLAIM_STALE_PROJECTION` | Read or write targeted a stale projection (event not yet canonical at the bound deployment block) | true |
| 410 | `CANONICAL_CLAIM_REORGED` | The claim was affected by a chain reorg and must be re-resolved from canonical events | true |
| 503 | `CANONICAL_CLAIM_UNAVAILABLE` | Canonical state is temporarily unavailable (indexer catching up or chain REC failure) | true |

### Error Details Contract

The `details` object is stable and contains only non-sensitive, chain-bound identifiers:

| Field | Type | Description |
|-------|------|-------------|
| `claimId` | string | Claim identifier |
| `chainId` | number | Chain ID the claim is bound to |
| `releaseId` | string | Contract release ID |
| `deploymentBlock` | number | Deployment block number |
| `artifactChecksum` | string | Artifact checksum the state was derived from |
| `currentPhase` | string (optional) | Canonical phase at time of error (wrong-phase / invalid-transition only) |

Internal details (SQL errors, stack traces, raw event payloads, addresses of non-canonical blocks) are never included.

### Idempotent Retry Semantics

Clients MAY retry any error with `retryable: true` using the same request body and idempotency key. The server MUST return the canonical result of the original transition if it already committed. Divergent payloads for the same idempotency key return `CANONICAL_CLAIM_DUPLICATE`.

### State Transition Authority

State transitions are derived exclusively from canonical contracts and finalized events. Client-supplied phase or state values are ignored for authority purposes and are only used for conflict detection.