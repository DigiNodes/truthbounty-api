# Component Quick Reference

Quick lookup guide for common component usage patterns in TruthBounty API.

## Component Directory

### 📊 Data Aggregation & Resolution
- **AggregationService** - Combine verification votes into verdicts
- **WeightedVoteResolutionService** - Reputation-weighted voting
- **SybilResistanceService** - Multi-factor attack prevention

### 🔗 Blockchain & Indexing
- **BlockchainIndexerService** - Event processing
- **ReorgDetectorService** - Fork detection & recovery

### 👤 Identity & Access
- **IdentityService** - User/wallet management
- **WalletThrottlerGuard** - Rate limiting by wallet

### 📝 Evidence & Auditing
- **EvidenceService** - Evidence versioning with IPFS
- **AuditTrailService** - Action logging & compliance

### ⚡ Caching & Infrastructure
- **ClaimsCache** - Redis caching layer
- **PrismaService** - Database ORM
- **RedisService** - Cache management
- **IpfsService** - Distributed storage

---

## Quick Start Examples

### Inject a Service

```typescript
import { Injectable } from '@nestjs/common';
import { AggregationService } from './aggregation.service';

@Injectable()
export class MyService {
  constructor(private aggregation: AggregationService) {}

  async doSomething() {
    const result = await this.aggregation.aggregateVerifications(votes);
  }
}
```

### Auto-Log Actions

```typescript
import { Audited } from 'src/audit/decorators/audited.decorator';

@Post('/claims')
@Audited()
async createClaim(@Body() dto: CreateClaimDto) {
  // Automatically logged with before/after states
}
```

### Rate Limit Operations

```typescript
import { ThrottleByWallet } from 'src/common/decorators/throttle-by-wallet.decorator';

@Post('/vote')
@ThrottleByWallet('vote')
async submitVote(@Body() dto: VoteDto) {
  // Limited to 50 votes per hour per wallet
}
```

### Cache Claim Lookups

```typescript
import { ClaimsCache } from 'src/cache/claims.cache';

@Injectable()
export class ClaimsService {
  constructor(private cache: ClaimsCache) {}

  async getClaim(id: string) {
    const cached = await this.cache.getClaim(id);
    if (cached) return cached;
    // Query database if not cached
  }
}
```

### Verify Wallet Signatures

```typescript
import { IdentityService } from 'src/identity/identity.service';

const isValid = await identityService.verifySignature(
  'Hello, verify this message',
  signature,
  walletAddress
);
```

### Submit Evidence with IPFS

```typescript
import { EvidenceService } from 'src/claims/evidence.service';

const evidence = await evidenceService.submitEvidence(claimId, {
  content: 'Evidence content here',
  contentType: 'text',
  metadata: { source: 'document' }
});
```

---

## Common Patterns

### Pattern 1: Full Claim Workflow

```typescript
async createClaimWithEvidence(
  user: User,
  claimDto: CreateClaimDto,
  evidenceDto: SubmitEvidenceDto
) {
  // 1. Create claim
  const claim = await this.prisma.claim.create({ data: claimDto });

  // 2. Log action
  await this.audit.logAction({
    action: 'CREATE',
    entityType: 'Claim',
    entityId: claim.id,
    userId: user.id,
    afterState: claim,
  });

  // 3. Submit evidence
  const evidence = await this.evidenceService.submitEvidence(
    claim.id,
    evidenceDto
  );

  // 4. Invalidate cache
  await this.cache.invalidateUserClaims(user.id);

  return { claim, evidence };
}
```

### Pattern 2: Rate Limited Voting

```typescript
@Post('/vote')
@ThrottleByWallet('vote')
async submitVote(
  @Body() voteDto: VoteDto,
  @CurrentUser() user: User
) {
  // 1. Verify user has reputation
  if (user.reputation < 10) {
    throw new ForbiddenException('Insufficient reputation');
  }

  // 2. Calculate Sybil score
  const sybilScore = await this.sybilService.calculateSybilScore(user.id);
  if (sybilScore.compositeScore > 0.8) {
    throw new ForbiddenException('Sybil risk detected');
  }

  // 3. Submit vote
  const vote = await this.votingService.submitVote(voteDto, user);

  // 4. Log action
  await this.audit.logAction({
    action: 'CREATE',
    entityType: 'Vote',
    entityId: vote.id,
    userId: user.id,
    afterState: vote,
  });

  return vote;
}
```

### Pattern 3: Sybil-Resistant Resolution

```typescript
async resolveClaimWithSybilCheck(
  claimId: string,
  verifications: Verification[]
) {
  // 1. Filter by Sybil scores
  const sybilScores = await Promise.all(
    verifications.map(v => 
      this.sybilService.calculateSybilScore(v.userId)
    )
  );

  const trustedVerifications = verifications.filter(
    (v, i) => sybilScores[i].compositeScore < 0.7
  );

  // 2. Aggregate trusted votes
  const result = await this.aggregation.aggregateVerifications(
    trustedVerifications
  );

  // 3. Resolve with weighted voting
  const verdict = await this.votingService.resolveClaimWeightedVote(
    claimId,
    trustedVerifications
  );

  // 4. Update claim
  await this.prisma.claim.update({
    where: { id: claimId },
    data: {
      resolvedVerdict: verdict.verdict === 'true',
      confidenceScore: verdict.confidenceScore,
      finalized: true,
    }
  });

  // 5. Audit
  await this.audit.logAction({
    action: 'UPDATE',
    entityType: 'Claim',
    entityId: claimId,
    beforeState: { verdict: null },
    afterState: { verdict: verdict.verdict },
  });

  return verdict;
}
```

### Pattern 4: Cache Invalidation

```typescript
// After any update to a claim:
await Promise.all([
  this.cache.invalidateClaim(claimId),
  this.cache.invalidateUserClaims(claim.userId),
  this.cache.del(`claim_list:*`),  // Invalidate listings
]);
```

---

## Configuration Reference

### AggregationService Config
```typescript
// src/aggregation/aggregation.config.ts
export const aggregationConfig = {
  confidenceThreshold: 0.65,
  minVerificationCount: 3,
  weightStrategy: 'reputation-weighted',
};
```

### SybilResistanceService Config
```typescript
export const sybilConfig = {
  weights: {
    worldcoin: 0.4,
    walletAge: 0.2,
    staking: 0.2,
    accuracy: 0.2,
  },
  thresholds: {
    likely_sybil: 0.7,
    risky: 0.5,
  },
};
```

### Rate Limiting Config
```typescript
export const throttleConfig = {
  claim_create: { limit: 10, windowMs: 3600000 },
  vote: { limit: 50, windowMs: 3600000 },
  dispute: { limit: 5, windowMs: 86400000 },
};
```

### Cache Config
```typescript
export const cacheConfig = {
  ttl: 300,
  maxEntries: 10000,
  statusSpecific: {
    pending: 120,    // 2 minutes
    resolved: 600,   // 10 minutes
  },
};
```

---

## Troubleshooting Guide

### Service Not Injecting?
```typescript
// Ensure service is provided in module
@Module({
  providers: [MyService, AggregationService],
  exports: [MyService],
})
export class MyModule {}
```

### Cache Not Working?
```typescript
// Check Redis connection
logger.debug('Redis status:', this.redis.isConnected());

// Manually invalidate
await this.cache.invalidateClaim(id);
```

### Signature Verification Failing?
```typescript
// Verify message format:
// 1. Message must match exactly what was signed
// 2. Signature must be recent (check timestamp)
// 3. Wallet address must be checksummed (ethers handles this)

const isValid = await identityService.verifySignature(
  'Exact message that was signed',
  signature,
  '0x' + walletAddress.slice(2)  // Ensure checksum format
);
```

### Slow Sybil Calculations?
```typescript
// Sybil scores are cached, but can be slow on first calculation
// Use in background jobs when possible
const score = await this.sybilService.calculateSybilScore(userId);
// First call: ~200ms (queries multiple data sources)
// Subsequent calls within TTL: ~10ms (cached)
```

---

## Type Definitions Reference

### Common Types

```typescript
// User with identity
interface User {
  id: string;
  walletAddress: string;
  reputation: number;
  wallets: Wallet[];
  sybilScores: SybilScore[];
  createdAt: Date;
}

// Wallet linked to user
interface Wallet {
  id: string;
  address: string;
  chain: string;
  userId: string;
  user: User;
  linkedAt: Date;
}

// Claim to be verified
interface Claim {
  id: string;
  resolvedVerdict: boolean | null;
  confidenceScore: number | null;
  finalized: boolean;
  evidences: Evidence[];
  createdAt: Date;
}

// Evidence supporting a claim
interface Evidence {
  id: string;
  claimId: string;
  claim: Claim;
  latestVersion: number;
  versions: EvidenceVersion[];
  createdAt: Date;
}

// Versioned evidence content
interface EvidenceVersion {
  id: string;
  evidenceId: string;
  version: number;
  cid: string;                  // IPFS hash
  createdAt: Date;
}

// User's Sybil resistance score
interface SybilScore {
  id: string;
  userId: string;
  worldcoinScore: number;
  walletAgeScore: number;
  stakingScore: number;
  accuracyScore: number;
  compositeScore: number;
  calculationDetails: string;   // JSON
  createdAt: Date;
}

// Audit log entry
interface AuditEvent {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'VIEW';
  entityType: string;
  entityId: string;
  userId?: string;
  walletAddress?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  changes?: Record<string, any>;
  ipAddress?: string;
  correlationId?: string;
  createdAt: Date;
}
```

---

## Performance Tips

1. **Cache Sybil Scores** - They don't change frequently
2. **Batch Signature Verifications** - Use Promise.all()
3. **Use Database Indexes** - Queries on claimId, userId, status
4. **Async Audit Logging** - Don't block on audit calls
5. **Paginate Audit Logs** - Can get very large
6. **Monitor Cache Hit/Miss** - Adjust TTL if needed

---

## Links & References

- [Full Component Documentation](./COMPONENTS.md)
- [Database Schema](../prisma/schema.prisma)
- [API Documentation](../docs/API_REFERENCE.md)
- [Architecture Overview](../ARCHITECTURE.md)

---

**Last Updated:** March 28, 2026
**Version:** 1.0
