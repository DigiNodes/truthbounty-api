# TruthBounty API Documentation

## Overview

This document provides a comprehensive reference for all API endpoints in the TruthBounty API. TruthBounty is a decentralized news verification infrastructure that allows users to submit claims, provide evidence, resolve disputes, and earn rewards.

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

### Claims

Manage claims and their evidence.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/claims/latest` | Get latest claims |
| GET | `/claims/user/:wallet` | Get claims by user wallet |
| GET | `/claims/:id` | Get a single claim by ID |
| POST | `/claims` | Create a new claim |
| POST | `/claims/:claimId/evidence` | Add evidence to a claim |
| PUT | `/claims/evidence/:evidenceId` | Update evidence with new version |
| GET | `/claims/:claimId/evidence` | Get all evidence for a claim |
| GET | `/claims/:claimId/evidence/latest` | Get latest evidence for a claim |
| GET | `/claims/evidence/:evidenceId` | Get a single evidence by ID |

**Query Parameters:**
- "limit" (optional): Number of results to return (default: 10)

**Path Parameters:**
- `:wallet` - Wallet address
- `:id` - Claim ID
- `:claimId` - Claim ID
- `:evidenceId` - Evidence ID

**Request Body (POST /claims):**
```json
{
  "title": "string",
  "content": "string",
  "category": "string",
  "wallet": "string"
}
```

**Request Body (POST /claims/:claimId/evidence):**
```json
{
  "cid": "string"
}
```

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
- `:nullifierHash` - Nullifier hash

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

Reward management.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/rewards` | Create a new reward |
| GET | `/rewards` | Get all rewards |
| GET | `/rewards/:id` | Get reward by ID |
| PATCH | `/rewards/:id` | Update reward |
| DELETE | `/rewards/:id` | Delete reward |

**Path Parameters:**
-  `:id` - Reward ID

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

## Claim Lifecycle Errors (V1)

Claim lifecycle operations fail closed with stable, versioned, typed error codes. Clients MUST switch on the code field and MuST NOT parse human-readable messages. Internal details (SQL / stack traces / raw chain payloads) iss never returned.

### Error Envelope

All claim lifecycle errors return the standard envelope with a typed error object:

```json
{
  "success": false,
  "requestId": "string",
  "timestamp": "ISO-8601 string",
  "data": null,
  "error": {
    "code": "CANONICAL_CLAIM_NOT_FOUND",
    "code": "CANONICAL_CLAIM_NOT_FOUND",
    "version": "v1",
    "message": "Claim not found",
    "details": {
      "claimId": "string",
      "chainId": "number",
      "releaseId": "string",
      "deploymentBlock": "number",
      "artifactChecksum": "string"
    },
    "retryable": false
  }
}
```

### Error Codes

All codes are prefixed and versioned (`v1`). The code is stable across patch releases; changes to code semantics require a new version prefix.

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
