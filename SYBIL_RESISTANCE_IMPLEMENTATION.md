# Sybil Resistance Scoring - Implementation Guide

## Overview

This implementation introduces a **Sybil Resistance Score** that quantifies user trustworthiness based on identity signals, wallet tenure, staking participation, and claim accuracy. The score is used to weight voting power and regulate participation in the verification protocol.

## Architecture

### Core Components

#### 1. **SybilResistanceService** (`sybil-resistance.service.ts`)
Main service that computes and manages Sybil scores.

**Key Methods:**
- `computeSybilScore(userId)` - Calculates score from signals
- `recordSybilScore(userId)` - Stores score snapshot
- `getLatestSybilScore(userId)` - Retrieves most recent score
- `getSybilScoreHistory(userId)` - Gets historical scores
- `setWorldcoinVerified(userId, verified)` - Marks Worldcoin verification
- `recalculateAllScores()` - Batch recalculation
- `getSybilScoreForVoting(userId)` - Exposes score to voting engines

#### 2. **SybilResistantVotingService** (`sybil-resistant-voting.service.ts`)
Integration layer for voting systems.

**Key Methods:**
- `calculateSybilWeightedVote(userId, baseWeight)` - Applies Sybil multiplier to vote weight
- `calculateSybilWeightedVotes(votes)` - Batch vote weighting
- `getVotingImpactAnalysis(votes)` - Shows weight distribution impact
- `meetsMinimumSybilScore(userId, minimumScore)` - Eligibility check
- `getParticipationEligibility(userIds)` - Batch eligibility reporting

#### 3. **SybilResistanceController** (`sybil-resistance.controller.ts`)
REST API endpoints for score management.

**Endpoints:**
- `POST /sybil/users/:userId/score` - Record new score
- `GET /sybil/users/:userId/score` - Get latest score
- `GET /sybil/users/:userId/history` - Get score history
- `GET /sybil/users/:userId/voting` - Get voting-formatted score
- `POST /sybil/users/:userId/verify-worldcoin` - Mark as Worldcoin verified
- `POST /sybil/recalculate-all` - Batch recalculation (admin)

### Database Schema

#### User Model (Updated)
```prisma
model User {
  id                  String      @id @default(uuid())
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt
  reputation          Int         @default(0)
  worldcoinVerified   Boolean     @default(false)
  
  wallets             Wallet[]
  sybilScores         SybilScore[]
}
```

#### SybilScore Model (New)
```prisma
model SybilScore {
  id                  String      @id @default(uuid())
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt
  
  userId              String
  user                User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  // Component scores (0-1 normalized)
  worldcoinScore      Float       @default(0.0)   // Binary verification (0 or 1)
  walletAgeScore      Float       @default(0.0)   // Wallet tenure signal
  stakingScore        Float       @default(0.0)   // Staking participation
  accuracyScore       Float       @default(0.0)   // Claim accuracy history
  
  // Final score
  compositeScore      Float       @default(0.0)   // Final weighted score (0-1)
  
  // Metadata
  calculationDetails  String?     // JSON for explainability
  
  @@unique([userId, createdAt])
  @@index([userId])
  @@index([compositeScore])
}
```

## Scoring Algorithm

### Signal Collection

1. **Worldcoin Verification** (Binary)
   - Input: `user.worldcoinVerified`
   - Indicates strong identity proof

2. **Wallet Age** (Time-based)
   - Input: Oldest wallet `linkedAt` timestamp
   - Threshold: 90 days for full score
   - Formula: `min(ageMs / THRESHOLD_MS, 1.0)`

3. **Staking Participation** (Amount-based)
   - Input: Total staked tokens across all claims
   - Uses logarithmic scaling: `log1p(amount) / log1p(THRESHOLD_AMOUNT)`
   - Prevents whale dominance

4. **Claim Accuracy** (Ratio-based)
   - Input: Ratio of correct votes to total votes
   - Minimum 5 claims required for score
   - Formula: `claimsCorrect / claimsVotedOn`

### Normalization

Each signal is independently normalized to [0, 1] range:
- **Worldcoin**: Binary (0 or 1)
- **Wallet Age**: Linear with 90-day threshold
- **Staking**: Logarithmic with 1-token threshold
- **Accuracy**: Direct ratio (0-1)

### Composite Score Calculation

```
Sybil Score = (
  worldcoinScore × 0.30 +
  walletAgeScore × 0.25 +
  stakingScore × 0.25 +
  accuracyScore × 0.20
)
```

**Weights:**
- 30% - Worldcoin verification (identity is most important)
- 25% - Wallet age (account tenure indicates commitment)
- 25% - Staking participation (economic skin-in-the-game)
- 20% - Claim accuracy (behavioral track record)

## Voting Integration

### Vote Weight Multiplier

Sybil scores are applied to voting weights using a multiplier:

```
multiplier = 0.5 + (0.5 × sybilScore)
finalWeight = baseWeight × multiplier
```

**Effect:**
- Score 0.0 → 50% weight reduction
- Score 0.5 → 75% weight
- Score 1.0 → 100% full weight

### Example Voting Impact

```
User A (Sybil score 0.9):
  Base weight: 100
  Multiplier: 0.95
  Final weight: 95

User B (Sybil score 0.2):
  Base weight: 100
  Multiplier: 0.6
  Final weight: 60

Vote outcome shifts based on user credibility
```

### Eligibility Requirements

Minimum score for participation: **0.1** (configurable)
- Only 50% weight penalty
- Encourages all users to establish reputation

## Integration Points

### 1. Identity Service
**Location:** `src/identity/identity.controller.ts`

**New Endpoint:**
```typescript
POST /identity/users/:id/verify-worldcoin
→ Sets worldcoinVerified = true
→ Recalculates Sybil score (30% boost)
```

**Response:**
```json
{
  "userId": "uuid",
  "compositeScore": 0.67,
  "worldcoinScore": 1.0,
  "calculationDetails": { ... }
}
```

### 2. Blockchain/Verification Module
**Location:** `src/blockchain/weighted-vote-resolution.service.ts`

**Usage Pattern:**
```typescript
// In vote resolution:
const sybilWeighted = await votingService.calculateSybilWeightedVotes(votes);
const aggregation = this.aggregateVotes(sybilWeighted);
const resolution = this.determineResolution(aggregation);
```

### 3. Claims Resolution
**Enhancement:** Accuracy tracking
- Records verified claims
- Calculates accuracy ratios
- Feeds into next score recalculation

## Usage Examples

### Record a Sybil Score

```bash
POST /sybil/users/{userId}/score

Response:
{
  "id": "score-uuid",
  "userId": "user-uuid",
  "worldcoinScore": 0.0,
  "walletAgeScore": 0.67,
  "stakingScore": 0.0,
  "accuracyScore": 0.0,
  "compositeScore": 0.27,
  "calculationDetails": {
    "worldcoinWeight": 0.3,
    "walletAgeWeight": 0.25,
    "stakingWeight": 0.25,
    "accuracyWeight": 0.2,
    "componentScores": { ... },
    "explanation": "..."
  }
}
```

### Verify with Worldcoin

```bash
POST /identity/users/{userId}/verify-worldcoin

Response:
{
  "id": "score-uuid",
  "compositeScore": 0.57,      // 30% boost from verification
  "worldcoinScore": 1.0,
  "walletAgeScore": 0.67,
  "calculationDetails": { ... }
}
```

### Get Voting-Ready Score

```bash
GET /sybil/users/{userId}/voting

Response:
{
  "userId": "user-uuid",
  "score": 0.57,
  "isVerified": true,
  "details": {
    "explanation": "...",
    "componentScores": { ... }
  }
}
```

### Apply to Voting

```typescript
const votingResult = await sybilVotingService.calculateSybilWeightedVote(
  userId,
  baseVoteWeight
);

// votingResult.finalWeight can now be used in vote aggregation
```

## Testing

### Test Coverage

**SybilResistanceService** (11 test suites):
- ✅ Deterministic score computation
- ✅ Worldcoin boost verification
- ✅ Wallet age contribution
- ✅ Explainability details
- ✅ Score recording and retrieval
- ✅ Recalculation workflows
- ✅ Edge cases (no wallets, normalization bounds)

**SybilResistantVotingService** (8 test suites):
- ✅ Vote weight multiplier application
- ✅ Batch vote weighting
- ✅ Impact analysis calculations
- ✅ Eligibility checking
- ✅ Participation reporting
- ✅ Edge cases (zero weight, consistency)

Run tests:
```bash
npm test sybil-resistance.service.spec.ts
npm test sybil-resistant-voting.service.spec.ts
```

## Explainability

Each score includes detailed `calculationDetails`:

```json
{
  "worldcoinWeight": 0.3,
  "walletAgeWeight": 0.25,
  "stakingWeight": 0.25,
  "accuracyWeight": 0.2,
  "componentScores": {
    "worldcoin": 1.0,
    "walletAge": 0.67,
    "staking": 0.0,
    "accuracy": 0.0
  },
  "timestamp": "2026-01-29T12:34:56Z",
  "explanation": "Sybil resistance score calculated from 4 signals: Worldcoin verification (1.00) - Identity proof, Wallet age (0.67) - Account tenure, Staking participation (0.00) - Economic commitment, Claim accuracy (0.00) - Verification history. Final score: 0.5700 (weighted average)"
}
```

Users can understand:
- **Which signals** contributed most
- **How much** each signal contributed
- **Why** they received their score
- **What improves** their score

## Future Enhancements

### Phase 2: Staking Integration
- [ ] Connect to staking module for real amount tracking
- [ ] Implement weighted staking across multiple claims
- [ ] Add slashing history to accuracy calculation

### Phase 3: Claims Integration
- [ ] Track dispute participation and win rates
- [ ] Implement dispute accuracy scoring
- [ ] Add time-decay to historical accuracy

### Phase 4: Advanced Signals
- [ ] Social reputation from community voting
- [ ] Cross-chain identity verification
- [ ] Decentralized ID (DID) integration
- [ ] Machine learning for fraud detection

### Phase 5: Dynamic Weighting
- [ ] Adjust weights based on protocol needs
- [ ] Market-based weight discovery
- [ ] Governance-controlled scoring

## Migration Notes

### Creating Migration
```bash
npx prisma migrate dev --name add_sybil_scores
```

### Adding to Existing Database
The migration creates:
1. `worldcoinVerified` column on `User` table (default: false)
2. New `SybilScore` table with proper indexes

No data loss for existing users.

## Performance Considerations

- **Score Calculation**: O(1) time, minimal DB queries
- **Batch Recalculation**: O(n) where n = number of users
- **Vote Weighting**: O(1) per vote, parallelizable
- **Storage**: One row per score snapshot per user
- **Indexes**: `userId` and `compositeScore` for quick queries

## Security Considerations

- Scores are deterministic (no randomness)
- Immutable historical records (snapshots)
- No cascading failures (errors don't prevent operation)
- Sensitive to garbage data (GIGO principle)
- Requires accurate staking/claims data

## References

- Protocol Blog: [Drips Blog on Trust Weighting](https://drips.network)
- Sybil Resistance: Preventing one-person-multiple-accounts attacks
- Weighted Voting: Balancing participation with credibility
