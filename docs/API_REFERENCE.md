
# TruthBounty API Documentation

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
- `limit` (optional): Number of results to return (default: 10)

**Path Parameters:**
- `:wallet` - Wallet address
-  `:id` - Claim ID
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
-  `admin` - Set to `true` to access flags (admin only)

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
- `status` - Filter by dispute status
-  `trigger` - Filter by dispute trigger

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
- `:address` - Wallet address

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
- `:eventId` - Event ID
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
- `:id` - Reward ID

---

### Leaderboard

User leaderboard rankings.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/leaderboard` | Get leaderboard rankings |

**Query Parameters:**
-  `type` - Leaderboard type: `global` or `weekly` (default: `global`)

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
-  `:entityType` - Entity type (e.g., CLAIM, USER, DISPUTE)
-  `:entityId` - Entity ID
-  `:userId` - User ID
- `:actionType` - Action type (e.g., CLAIM_CREATED, EVIDENCE_ADDED)

**Query Parameters:**
-  `entityType` - Filter by entity type
-  `actionType` - Filter by action type
-  `userId` - Filter by user ID
-  `limit` - Number of results (default: 100, max: 500)
-  `offset` - Offset for pagination
-  `days` - Number of days for summary (default: 7)

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

