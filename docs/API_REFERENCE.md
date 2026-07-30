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
- `limit` (optional): Number of results to return (default: 10)

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
- `admin` - Set to `true` to access flags (admin only)

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
- `trigger` - Filter by dispute trigger

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
- `type` - Leaderboard type: `global` or `weekly` (default: `global`)

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
- `:userId` - User ID
- `:actionType` - Action type (e.g., CLAIM_CREATED, EVIDENCE_ADDED)

**Query Parameters:**
- `entityType` - Filter by entity type
- `actionType` - Filter by action type
- `userId` - Filter by user ID
- `limit` - Number of results (default: 100, max: 500)
- `offset` - Offset for pagination
- `days` - Number of days for summary (default: 7)

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

Conversational AI assistance over protocol knowledge, with context retrieval, streaming, safety guardrails, and usage analytics. All routes require a JWT (`Authorization: Bearer <token>`), including GETs — conversations are private per user. Responses are wrapped in a standard envelope: `{ success, requestId, timestamp, data, error, meta? }`. Full request/response schemas are in Swagger under the `ai-assistant` tag. See [AI_ASSISTANT_ARCHITECTURE.md](./AI_ASSISTANT_ARCHITECTURE.md), [AI_ASSISTANT_OPERATIONS.md](./AI_ASSISTANT_OPERATIONS.md), and [AI_ASSISTANT_SECURITY.md](./AI_ASSISTANT_SECURITY.md) for details.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ai-assistant/conversations` | Create a conversation (`mode`: general / moderation_assist / admin_analytics, role-gated) |
| GET | `/ai-assistant/conversations` | List the current user's conversations |
| GET | `/ai-assistant/conversations/:id` | Get a single conversation |
| GET | `/ai-assistant/conversations/:id/messages` | Get a conversation's message history |
| PATCH | `/ai-assistant/conversations/:id/archive` | Archive a conversation |
| DELETE | `/ai-assistant/conversations/:id` | Delete (soft) a conversation |
| POST | `/ai-assistant/conversations/:id/messages` | Send a message, get a non-streaming assistant reply with citations |
| POST | `/ai-assistant/conversations/:id/messages/stream` | Stage a message for a streamed reply; returns `messageId` + `streamUrl` |
| GET | `/ai-assistant/conversations/:id/stream/:messageId` | Server-Sent Events stream (`citation`, `chunk`, `done`/`error` events) |
| GET | `/ai-assistant/knowledge-base` | List knowledge-base documents used for context retrieval |
| GET | `/ai-assistant/knowledge-base/:id` | Get a single knowledge-base document |
| POST | `/ai-assistant/knowledge-base` | Create a document (moderator/admin only) |
| PATCH | `/ai-assistant/knowledge-base/:id` | Update a document (moderator/admin only) |
| DELETE | `/ai-assistant/knowledge-base/:id` | Deactivate a document (moderator/admin only) |
| GET | `/ai-assistant/analytics/usage` | Usage analytics summary (admin only) |

Rate limits: `POST .../messages` uses the `ai` throttle bucket; streaming (`.../messages/stream` and the SSE GET) uses the stricter `aiStream` bucket. Both are configurable via `RATE_LIMIT_AI_*`/`RATE_LIMIT_AI_STREAM_*` env vars.

---

## Error Responses

All endpoints may return the following error responses:

| Status Code | Description |
|-------------|-------------|
| `400` | Bad Request - Invalid parameters |
| `403` | Forbidden - Access denied |
| `404` | Not Found - Resource not found |
| `409` | Conflict - Resource already exists |
| `500` | Internal Server Error |

---

## Notes

- This API uses JSON for request and response bodies.
- Some endpoints are rate-limited using wallet-based throttling.
- The API is built with NestJS and uses Prisma for database operations.
- Blockchain events are indexed and tracked for audit purposes.
