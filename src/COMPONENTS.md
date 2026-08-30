# TruthBounty API - Component Documentation

This document provides comprehensive documentation for reusable components, services, and utilities in the TruthBounty API backend.

## Table of Contents

1. [Aggregation](#aggregation-service)
2. [Weighted Vote Resolution](#weighted-vote-resolution-service)
3. [Sybil Resistance](#sybil-resistance-service)
4. [Blockchain Indexer](#blockchain-indexer-service)
5. [Audit Trail](#audit-trail-service)
6. [Identity Management](#identity-service)
7. [Claims Cache](#claims-cache)
8. [Evidence Management](#evidence-service)
9. [Reorg Detection](#reorg-detector-service)
10. [Rate Limiting](#wallet-throttler-guard)
11. [Realtime Event Stream](#realtime-event-stream)
12. [Infrastructure Services](#infrastructure-services)

---

## Aggregation Service

**Location:** `src/aggregation/aggregation.service.ts`

### Overview
Pure, deterministic aggregation logic for combining individual verifications into claim verdicts. Computes weighted aggregations and confidence scores based on verification votes and reputation weights.

### Key Methods

#### `aggregateVerifications(verifications: Verification[]): AggregationResult`
Aggregates multiple verification votes into a single verdict.

**Parameters:**
- `verifications`: Array of individual verification objects with votes and weights

**Returns:**
```typescript
{
  verdict: boolean | null;        // True/False/Null (unresolved)
  confidenceScore: number;        // 0-1 normalized confidence
  totalWeight: number;            // Sum of all weighted votes
  details: AggregationDetails;   // Breakdown of calculation
}
```

**Example:**
```typescript
const verifications = [
  { vote: true, reputation: 85 },
  { vote: true, reputation: 60 },
  { vote: false, reputation: 30 },
];

const result = await aggregationService.aggregateVerifications(verifications);
// Returns: { verdict: true, confidenceScore: 0.78, ... }
```

### Use Cases
- Resolving claims from multiple verifier votes
- Computing overall claim confidence
- Weighted voting based on reputation

### Configuration
- Confidence threshold: Configurable in `aggregation.config.ts`
- Weight calculations: Customizable aggregation strategy

---

## Weighted Vote Resolution Service

**Location:** `src/blockchain/weighted-vote-resolution.service.ts`

### Overview
Implements reputation-weighted voting for claim resolution on-chain. Converts verification votes into authoritative outcomes with confidence metrics, Sybil attack protection, and configurable thresholds.

### Key Methods

#### `resolveClaimWeightedVote(claimId: string, verifications: Verification[]): Promise<ClaimVerdict>`
Resolves a claim using weighted voting logic.

**Parameters:**
- `claimId`: The claim identifier
- `verifications`: Array of verification votes with weights

**Returns:**
```typescript
{
  claimId: string;
  verdict: 'true' | 'false' | 'unresolved';
  confidenceScore: number;
  weightedVotes: WeightedVoteBreakdown;
  timestamp: Date;
}
```

**Example:**
```typescript
const verdict = await votingService.resolveClaimWeightedVote(
  'claim-123',
  [{ verifierId: 'user-1', vote: true, sybilScore: 0.95 }]
);
```

#### `computeVoteWeight(verifierId: string): Promise<number>`
Computes the voting weight for a verifier based on reputation and Sybil resistance.

**Returns:** Weight multiplier (typically 0-2x)

### Sybil Protection Features
- Reduces weight for accounts with high Sybil scores
- Implements voting threshold enforcement
- Tracks vote distribution patterns

### Configuration
- Confidence threshold for finalization
- Sybil weight reduction factor
- Minimum verifier count

---

## Sybil Resistance Service

**Location:** `src/sybil-resistance/sybil-resistance.service.ts`

### Overview
Multi-factor Sybil scoring system combining Worldcoin verification, wallet age, staking participation, and verification accuracy. Provides explainable scores for transparency in attack prevention.

### Architecture

#### Component Scores (0-1 normalized)

1. **Worldcoin Score** (Binary: 0 or 1)
   - 1.0 if user verified with Worldcoin
   - 0.0 otherwise

2. **Wallet Age Score**
   - Based on blockchain transaction history
   - Newer wallets = lower score
   - Score increases over time

3. **Staking Score**
   - Historical participation in staking contracts
   - Stake duration and amount
   - Demonstrates commitment

4. **Accuracy Score**
   - Based on verification history accuracy
   - Verified claims matching on-chain results
   - Higher for consistent verifiers

#### Final Composite Score
```
compositeScore = w1*worldcoinScore + w2*walletAgeScore + 
                 w3*stakingScore + w4*accuracyScore
```

Default weights: [0.4, 0.2, 0.2, 0.2]

### Key Methods

#### `calculateSybilScore(userId: string): Promise<SybilScoreResult>`
Computes comprehensive Sybil resistance score.

**Returns:**
```typescript
{
  compositeScore: number;           // 0-1 final score
  worldcoinScore: number;
  walletAgeScore: number;
  stakingScore: number;
  accuracyScore: number;
  calculationDetails: string;       // JSON explanation
  timestamp: Date;
}
```

**Example:**
```typescript
const score = await sybilService.calculateSybilScore('user-123');
console.log(`Sybil Score: ${score.compositeScore}`);
console.log(`Details: ${JSON.parse(score.calculationDetails)}`);
```

#### `isLikelySybil(userId: string, threshold: number = 0.7): Promise<boolean>`
Quick check if user likely Sybil attacker.

**Parameters:**
- `threshold`: Score above which to flag as Sybil (default 0.7)

**Returns:** Boolean - true if likely Sybil

### Explainability
Each score calculation includes `calculationDetails` JSON with:
- Individual component values
- Weight application
- Contributing factors
- Timestamps and metadata

### Use Cases
- Voting weight adjustment
- Account flagging
- Risk assessment
- Compliance reporting

---

## Blockchain Indexer Service

**Location:** `src/blockchain/blockchain-indexer.service.ts`

### Overview
Processes blockchain events idempotently with transaction safety. Manages processed event tracking, token balances, and indexer progress checkpoints for reliable blockchain data synchronization.

### Key Methods

#### `indexBlockEvents(blockNumber: number, events: BlockchainEvent[]): Promise<IndexingResult>`
Processes events from a specific blockchain block.

**Parameters:**
- `blockNumber`: Block number to process
- `events`: Array of blockchain events

**Returns:**
```typescript
{
  blockNumber: number;
  eventsProcessed: number;
  tokensUpdated: number;
  checkpoint: IndexingCheckpoint;
  errors: ProcessingError[];
}
```

#### `getProcessingCheckpoint(): Promise<IndexingCheckpoint>`
Retrieves the last processed block and state.

**Returns:**
```typescript
{
  lastProcessedBlock: number;
  lastProcessedTime: Date;
  isHealthy: boolean;
}
```

#### `recoverFromFailure(fromBlock: number): Promise<void>`
Recovers indexer from failure by reprocessing blocks from specified point.

### Idempotency Guarantees
- Event tracking prevents duplicate processing
- Transaction-safe state updates
- Automatic recovery from crashes
- Checkpoint-based resumption

### Configuration
- Block batch size
- Confirmation depth (blocks to finality)
- Processing timeout
- Retry strategy

### Use Cases
- Indexing token transfers
- Processing governance events
- Tracking claim submissions
- Updating ledger balances

---

## Audit Trail Service

**Location:** `src/audit/services/audit-trail.service.ts`

### Overview
Comprehensive audit logging for all actions (create, update, delete, etc.). Tracks before/after state, user/wallet context, and correlation IDs for compliance, debugging, and accountability.

### Key Methods

#### `logAction(auditEvent: AuditEvent): Promise<void>`
Records an action in the audit trail.

**Parameters:**
```typescript
interface AuditEvent {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'VIEW';
  entityType: string;              // e.g., 'Claim', 'Evidence'
  entityId: string;
  userId?: string;
  walletAddress?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  changes?: Record<string, Change>;
  ipAddress?: string;
  correlationId?: string;
  metadata?: Record<string, any>;
}
```

**Example:**
```typescript
await auditService.logAction({
  action: 'UPDATE',
  entityType: 'Claim',
  entityId: 'claim-123',
  userId: 'user-456',
  beforeState: { status: 'pending', verdict: null },
  afterState: { status: 'resolved', verdict: true },
  changes: {
    status: { old: 'pending', new: 'resolved' },
    verdict: { old: null, new: true }
  },
  correlationId: 'req-789'
});
```

#### `getAuditTrail(entityId: string): Promise<AuditEvent[]>`
Retrieves all audit events for an entity.

**Returns:** Array of audit events in chronological order

#### `searchAuditLogs(filters: AuditFilter): Promise<AuditEvent[]>`
Searches audit logs with various filters.

**Filters:**
```typescript
{
  entityType?: string;
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  action?: 'CREATE' | 'UPDATE' | 'DELETE';
  limit?: number;
}
```

### Interceptor Integration
Use `@Audited()` decorator on controller methods to auto-log:

```typescript
@Post('/claims')
@Audited()
async createClaim(
  @Body() dto: CreateClaimDto,
  @CurrentUser() user: User,
) {
  // Auto-logged with before/after states
}
```

### Use Cases
- Compliance reporting
- Change history tracking
- User accountability
- Debugging issues
- Regulatory audits

---

## Identity Service

**Location:** `src/identity/identity.service.ts`

### Overview
User and wallet management with ECDSA signature verification. Handles wallet linking, user creation, and multi-wallet support for blockchain-based identity.

### Key Methods

#### `createUser(walletAddress: string): Promise<User>`
Creates a new user with primary wallet.

**Parameters:**
- `walletAddress`: Blockchain wallet address (EVM format)

**Returns:**
```typescript
{
  id: string;
  walletAddress: string;
  reputation: number;
  createdAt: Date;
  wallets: Wallet[];
}
```

**Example:**
```typescript
const user = await identityService.createUser('0x1234...');
```

#### `linkWallet(userId: string, walletAddress: string, chain: string, signature: string): Promise<Wallet>`
Links an additional wallet to an existing user.

**Parameters:**
- `userId`: Existing user ID
- `walletAddress`: New wallet to link
- `chain`: Blockchain name (ethereum, polygon, etc.)
- `signature`: ECDSA signature proving wallet ownership

**Returns:** Linked wallet object

#### `verifySignature(message: string, signature: string, walletAddress: string): Promise<boolean>`
Verifies ECDSA signature.

**Uses:** ethers.js for signature verification (EIP-191)

**Example:**
```typescript
const isValid = await identityService.verifySignature(
  'Verify wallet ownership',
  '0x...',
  '0x...'
);
```

#### `getUserByWallet(walletAddress: string): Promise<User>`
Retrieves user by any linked wallet address.

**Returns:** User object or null if not found

### Multi-Wallet Support
- Users can link wallets from multiple chains
- One blockchain address → One user (enforced)
- Cross-chain scenarios handled in service layer

### Signature Scheme
- Standard: EIP-191 (Ethereum signed message)
- Format: `0x19Ethereum Signed Message:\n{length}{message}`
- Recovery: Public key → wallet address

### Use Cases
- User registration via wallet
- Wallet linking verification
- Cross-chain identity
- Signature verification for actions

---

## Claims Cache

**Location:** `src/cache/claims.cache.ts`

### Overview
Redis-based caching layer for claims with configurable TTL. Provides methods for claim lookup, user claims, and cache invalidation for performance optimization.

### Key Methods

#### `getClaim(claimId: string): Promise<Claim | null>`
Gets cached claim or queries database.

**Returns:** Claim object or null

#### `getClaims(filter: ClaimFilter): Promise<Claim[]>`
Gets multiple claims with optional filters.

**Filters:**
```typescript
{
  userId?: string;
  status?: 'pending' | 'resolved';
  limit?: number;
  offset?: number;
}
```

#### `invalidateClaim(claimId: string): Promise<void>`
Invalidates cache for specific claim.

**Example:**
```typescript
await claimsCache.invalidateClaim('claim-123');
```

#### `invalidateUserClaims(userId: string): Promise<void>`
Invalidates all claims for a user.

### Configuration
- Cache TTL: Default 5 minutes
- Maximum entries: Configurable
- TTL by claim status:
  - Pending: 2 minutes (frequently changing)
  - Resolved: 10 minutes (stable)

### Cache Keys
```
claim:{claimId}
user_claims:{userId}
claim_list:{filter_hash}
```

### Graceful Degradation
- Falls back to database if Redis unavailable
- Cache miss on errors (safe failure)
- No data loss on cache failure

### Use Cases
- Frequent claim lookups
- User's recent claims
- Claim list pagination
- Reducing database load

---

## Evidence Service

**Location:** `src/claims/evidence.service.ts`

### Overview
Evidence management with versioning and IPFS integration. Tracks evidence history and integrates with audit trail for immutable evidence chain supporting claim verification.

### Key Methods

#### `submitEvidence(claimId: string, evidenceData: EvidenceSubmission): Promise<Evidence>`
Submits new evidence for a claim.

**Parameters:**
```typescript
interface EvidenceSubmission {
  content: string | Buffer;          // Evidence content
  contentType: 'text' | 'json' | 'file';
  metadata?: Record<string, any>;
}
```

**Returns:**
```typescript
{
  id: string;
  claimId: string;
  latestVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Process:**
1. Upload content to IPFS
2. Get IPFS hash (CID)
3. Create evidence version record
4. Log to audit trail
5. Return evidence object

#### `updateEvidence(evidenceId: string, updateData: EvidenceUpdate): Promise<EvidenceVersion>`
Creates a new version of existing evidence.

**Returns:** New evidence version with updated IPFS CID

#### `getEvidenceHistory(evidenceId: string): Promise<EvidenceVersion[]>`
Gets all versions of an evidence item.

**Returns:** Array of versions in chronological order

#### `getClaimEvidence(claimId: string): Promise<Evidence[]>`
Gets all evidence for a claim.

### Version Tracking
- Each update creates immutable version
- IPFS CID immutably stored
- Version history never changes
- Latest version always accessible

### IPFS Integration
- Provider-agnostic (supports Pinata, Estuary, etc.)
- Automatic pinning for persistence
- CID format (IPFS hash)

### Flagging System
Evidence can be flagged and tracked (see EvidenceFlag entity):
```typescript
interface EvidenceFlag {
  id: string;
  evidenceId: string;
  reason: 'suspicious' | 'spam' | 'invalid' | 'malicious';
  flaggedBy: string;
  createdAt: Date;
}
```

### Use Cases
- Submitting supporting documents
- Evidence versioning
- Immutable evidence chain
- Change history tracking
- Content moderation

---

## Reorg Detector Service

**Location:** `src/blockchain/reorg-detector.service.ts`

### Overview
Detects and handles blockchain reorganizations with configurable confirmation depth. Ensures data consistency across forks and manages recovery from chain reorgs.

### Key Methods

#### `checkForReorg(currentBlockNumber: number): Promise<ReorgEvent | null>`
Checks if a reorganization occurred.

**Returns:**
```typescript
{
  detected: boolean;
  reorgDepth: number;           // Blocks affected
  affectedBlockRange: [from, to];
  timestamp: Date;
} | null
```

#### `getConfirmedBlockNumber(): Promise<number>`
Gets the highest block number considered "confirmed" (safe from reorg).

**Formula:** `current_block - configurable_depth`

**Default depth:** 12 blocks (Ethereum)

#### `handleReorg(reorgEvent: ReorgEvent): Promise<void>`
Handles reorg recovery:
1. Pause indexing
2. Revert affected transactions
3. Reindex from fork point
4. Resume operations

#### `watchForReorgs(interval: number = 30000): void`
Starts periodic reorg checking.

**Parameters:**
- `interval`: Check frequency in milliseconds

### Configuration
```typescript
{
  confirmationDepth: 12,              // Blocks to finality
  maxReorgDepth: 64,                  // Maximum reorg depth to handle
  checkInterval: 30000,               // Check frequency (ms)
  enableAutoRecovery: true,
}
```

### Risk Levels
- **Low Risk:** Blocks > confirmation depth
- **At Risk:** Blocks within confirmation depth
- **Unconfirmed:** Current block

### Use Cases
- Ensuring transaction finality
- Recovery from chain forks
- Data consistency checking
- Blockchain reliability
- Enterprise-grade safety

---

## Wallet Throttler Guard

**Location:** `src/common/guards/wallet-throttler.guard.ts`

### Overview
Rate limiting by wallet address across different operation types. Prevents spam while tracking by wallet address with IP fallback for anonymous requests.

### Features

#### Decorator: `@ThrottleByWallet(operationType: string)`
Applies rate limiting to specific operations.

**Parameters:**
- `operationType`: Type of operation (e.g., 'claim_create', 'vote', 'dispute')

**Example:**
```typescript
@Post('/claims')
@ThrottleByWallet('claim_create')
async createClaim(@Body() dto: CreateClaimDto) {
  // Auto-limited per wallet
}
```

#### Configuration by Operation Type
```typescript
{
  claim_create: {
    limit: 10,              // 10 claims per window
    windowMs: 3600000,      // Per hour
  },
  vote: {
    limit: 50,
    windowMs: 3600000,
  },
  dispute: {
    limit: 5,
    windowMs: 86400000,     // Per day
  },
}
```

### Tracking Strategy
1. **Primary:** Wallet address from request context
2. **Fallback:** IP address if wallet not available
3. **User context:** Combines both for additional safety

### Response on Limit Exceeded
```
HTTP 429 Too Many Requests

{
  message: 'Rate limit exceeded',
  retryAfter: 600,           // Seconds until next attempt
  limit: 10,
  current: 10,
  resetAt: '2026-03-28T14:30:00Z'
}
```

### Use Cases
- Prevent claim spam
- Limit voting frequency
- Dispute rate limiting
- Sybil attack prevention
- API protection

---

## Realtime Event Stream

**Location:** `src/realtime/`

### Overview
A projection-backed, Server-Sent Events (SSE) realtime stream. Smart contracts emit facts, the indexer projects them, and this module publishes the normalized projection changes to authenticated subscribers. It is built on a durable Postgres outbox so nothing is ever published before its database transaction commits, with resume cursors, heartbeat, bounded backpressure, and rollback/replacement messages for non-finalized data.

### Architecture
```
[projection writer] → outbox row written in the SAME transaction (RealtimeService.emitWithinTransaction)
        │   (row only becomes visible after COMMIT → "publish after commit" guarantee)
        ▼
[projection_events outbox table]   (id = monotonic cursor)
        │
[RealtimePublisherService]  polls committed, un-published rows (bounded batch, FOR UPDATE SKIP LOCKED)
        │                     → broadcasts to RealtimeBusService → marks published (retry/replay)
        │                     → detects finalized→unfinalized (reorg) → emits ROLLBACK outbox row
        ▼
[RealtimeBusService]  in-process bounded-buffer broadcast hub (backpressure)
        │
[RealtimeStreamController @Sse('realtime/events')]  ← JwtAuthGuard
        │   - resume via Last-Event-ID cursor replay
        │   - heartbeat, bounded backpressure (503 on overflow)
        ▼
[client]
```

### Key Components

#### `RealtimeService`
- `emitWithinTransaction(manager, change)` — records a projection change inside the caller's database transaction (validated at the boundary). The row surfaces only after commit.
- `emitRollback(manager, params)` — records a rollback/replacement envelope.
- `streamFrom(options)` — builds an `Observable<RealtimeEnvelope>` that replays committed rows after `afterId` then subscribes to the live bus, with heartbeat and bounded backpressure.

#### `RealtimePublisherService`
Polls committed, un-published outbox rows (bounded batch) and broadcasts them to the bus, then marks them published. Failed rows are retried on a later pass (retry/replay). Also detects projections whose source indexed event was un-finalized by the chain indexer (reorg) and records a deduplicated ROLLBACK row.

#### `RealtimeBusService`
In-process broadcast hub with bounded per-subscriber buffers. A subscriber that cannot keep up (buffer exceeds capacity) is disconnected with a backpressure error.

#### `RealtimeStreamController`
- `GET /realtime/events` — authenticated SSE stream. Reads `Last-Event-ID` for resume.
- `POST /realtime/events` — internal, validated endpoint to record a projection change within a committed transaction.

### Security
- The stream is protected by `JwtAuthGuard` (Bearer JWT); only authenticated clients may subscribe.
- Untrusted input is validated with class-validator and again at `RealtimeService` (fail closed).
- Configuration (`RealtimeConfigService`) rejects invalid values by throwing rather than silently downgrading.
- No backend-authoritative protocol mutation: outcome logic stays in the smart contracts; the API only projects events.

### Configuration (env)
- `REALTIME_POLL_INTERVAL_MS` (1000), `REALTIME_MAX_PUBLISH_BATCH` (100), `REALTIME_HEARTBEAT_INTERVAL_MS` (15000), `REALTIME_MAX_BACKLOG` (1000), `REALTIME_MAX_REPLAY_ROWS` (5000).

---

## Infrastructure Services

### PrismaService

**Location:** `src/prisma/prisma.service.ts`

Database ORM and connection management.

**Key Features:**
- Automatic connection pooling
- Query logging in development
- Graceful shutdown
- Migration support

#### Usage
```typescript
@Injectable()
export class ClaimsService {
  constructor(private prisma: PrismaService) {}

  async getClaim(id: string) {
    return this.prisma.claim.findUnique({ where: { id } });
  }
}
```

---

### RedisService

**Location:** `src/redis/redis.service.ts`

Caching layer with graceful degradation.

**Key Methods:**
- `get(key: string)`: Get cached value
- `set(key: string, value: any, ttl?: number)`: Set with optional TTL
- `del(key: string)`: Delete key
- `flushAll()`: Clear all cache

#### Configuration
```typescript
{
  host: 'localhost',
  port: 6379,
  ttl: 300,              // Default TTL in seconds
  enabled: true,
}
```

---

### IpfsService

**Location:** `src/ipfs/ipfs.service.ts`

Provider-agnostic IPFS file uploads.

**Key Methods:**
- `upload(content: Buffer | string)`: Upload file
- `getUrl(cid: string)`: Get IPFS URL
- `pin(cid: string)`: Ensure persistence

**Returns:** IPFS CID (hash)

---

## Integration Patterns

### Using Multiple Components

**Example: Creating a claim with full audit and caching**

```typescript
@Injectable()
export class ClaimsService {
  constructor(
    private claims: ClaimsService,
    private audit: AuditTrailService,
    private cache: ClaimsCache,
  ) {}

  async createClaim(dto: CreateClaimDto, user: User) {
    // Create claim
    const claim = await this.prisma.claim.create({ data: dto });

    // Log to audit trail
    await this.audit.logAction({
      action: 'CREATE',
      entityType: 'Claim',
      entityId: claim.id,
      userId: user.id,
      afterState: claim,
    });

    // Invalidate cache
    await this.cache.invalidateUserClaims(user.id);

    return claim;
  }
}
```

### Error Handling

All services implement graceful degradation:

```typescript
try {
  const claim = await this.cache.getClaim(id);
  return claim;
} catch (error) {
  console.warn('Cache miss, querying database');
  return this.prisma.claim.findUnique({ where: { id } });
}
```

---

## Testing Components

### Mocking Services

```typescript
const mockAggregationService = {
  aggregateVerifications: jest.fn(),
};

describe('VotingService', () => {
  beforeEach(() => {
    TestingModule = Test.createTestingModule({
      providers: [
        VotingService,
        {
          provide: AggregationService,
          useValue: mockAggregationService,
        },
      ],
    }).compile();
  });

  it('should use aggregated result', async () => {
    mockAggregationService.aggregateVerifications.mockResolvedValue({
      verdict: true,
      confidenceScore: 0.95,
    });

    const result = await votingService.resolve(...);
    expect(result.verdict).toBe(true);
  });
});
```

---

## Best Practices

1. **Always use TypeScript types** - Full type safety
2. **Handle errors gracefully** - Implement graceful degradation
3. **Log important operations** - Use AuditTrailService
4. **Cache strategically** - Consider TTL and invalidation
5. **Verify signatures properly** - Use service methods, not custom code
6. **Test with mocks** - Isolate component testing
7. **Document breaking changes** - Update this guide
8. **Use correlation IDs** - Track requests through system

---

## Performance Considerations

| Component | Typical Latency | Optimization |
|-----------|-----------------|--------------|
| AggregationService | 1-5ms | In-memory computation |
| Sybil Resistance | 50-200ms | Caching frequent scores |
| Blockchain Indexer | Variable | Batch processing |
| Audit Trail | 10-50ms | Async logging |
| Identity Service | 20-100ms | Database indexes |
| Claims Cache | 1-2ms (hit), 20-100ms (miss) | Redis TTL tuning |
| Evidence Service | 100-500ms | IPFS pinning |
| Reorg Detector | 5-20ms | Periodic checks only |
| Rate Limiting | <1ms | In-memory counters |

---

## Migration Guide

### Updating Component Usage

If implementation changes:

1. Check component version in comments
2. Review method signatures
3. Update error handling
4. Test with new version
5. Update documentation

**Version tracking:**
```typescript
// Component: AggregationService
// Version: 1.2.0
// Last updated: 2026-03-28
```

---

## Support & Troubleshooting

### Common Issues

**Issue:** Cache not invalidating
- **Solution:** Ensure `invalidateClaim()` called after updates

**Issue:** Signature verification failing
- **Solution:** Verify message format matches client-side

**Issue:** Audit logs growing too large
- **Solution:** Implement log retention policy

**Issue:** IPFS uploads timing out
- **Solution:** Check IPFS pinning service status

---

**Documentation Version:** 1.0
**Last Updated:** March 28, 2026
**Scope:** Production-ready components
**Maintainer:** TruthBounty Development Team
