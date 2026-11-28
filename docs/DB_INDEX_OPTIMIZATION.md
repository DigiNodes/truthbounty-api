# Database Index Optimization for Claims

## Overview

This document describes the database index optimization implemented to improve query performance for claims, stakes, disputes, and leaderboard queries.

## Objectives

- ✅ Optimize claim queries
- ✅ Improve leaderboard queries
- ✅ Reduce table scan time
- ✅ Enhance dispute resolution performance

## Indexes Added

### Claims Table

The `finalized`, `confidenceScore`, and `resolvedVerdict` indexes are legacy
schema artifacts. Their columns are excluded from TypeORM reads and writes and
must not be used to answer protocol-state queries. The versioned claim
read-model endpoint is the API surface for release-bound claim status; its
finalized rows are gated by canonical events and contract checkpoints.

### Stake Table

| Index Name                 | Columns         | Type   | Purpose                       |
| -------------------------- | --------------- | ------ | ----------------------------- |
| `IDX_stake_claim_id`       | `claimId`       | Single | Find all stakes for a claim   |
| `IDX_stake_wallet_address` | `walletAddress` | Single | Find all stakes by wallet     |
| `IDX_stake_updated_at`     | `updatedAt`     | Single | Recent stake activity queries |

### Stake Event Table

| Index Name                       | Columns                    | Type      | Purpose                   |
| -------------------------------- | -------------------------- | --------- | ------------------------- |
| `IDX_stake_event_claim_id`       | `claimId`                  | Single    | Event history for claims  |
| `IDX_stake_event_wallet_address` | `walletAddress`            | Single    | Event history for wallets |
| `IDX_stake_event_timestamp`      | `timestamp`                | Single    | Chronological queries     |
| `IDX_stake_event_block_number`   | `blockNumber`              | Single    | Block-based queries       |
| `IDX_stake_event_claim_wallet`   | `claimId`, `walletAddress` | Composite | Combined filtering        |

### Disputes Table

| Index Name                  | Columns             | Type      | Purpose                   |
| --------------------------- | ------------------- | --------- | ------------------------- |
| `IDX_disputes_claim_id`     | `claimId`           | Single    | Find disputes for a claim |
| `IDX_disputes_status`       | `status`            | Single    | Filter by dispute status  |
| `IDX_disputes_created_at`   | `createdAt`         | Single    | Recent disputes           |
| `IDX_disputes_claim_status` | `claimId`, `status` | Composite | Combined filtering        |

### Reward Claims Table

| Index Name                           | Columns                           | Type      | Purpose                 |
| ------------------------------------ | --------------------------------- | --------- | ----------------------- |
| `IDX_reward_claims_wallet_timestamp` | `walletAddress`, `blockTimestamp` | Composite | Wallet reward history   |
| `IDX_reward_claims_amount`           | `amount`                          | Single    | Top earners leaderboard |

## Query Patterns Optimized

Do not query `claims.finalized`, `claims.resolvedVerdict`, or
`claims.confidenceScore` for protocol status or analytics that imply consensus.
These legacy fields are intentionally not exposed by claim metadata endpoints.

### 3. Find Stakes by Claim

```sql
SELECT * FROM stake WHERE claimId = ?;
```

**Index Used:** `IDX_stake_claim_id`

### 4. Find Stakes by Wallet

```sql
SELECT * FROM stake WHERE walletAddress = ?;
```

**Index Used:** `IDX_stake_wallet_address`

### 5. Aggregate Stakes by Claim

```sql
SELECT claimId, COUNT(*) as stake_count, SUM(amount) as total_amount
FROM stake
GROUP BY claimId;
```

**Index Used:** `IDX_stake_claim_id`

### 6. Recent Stake Events

```sql
SELECT * FROM stake_event
ORDER BY timestamp DESC
LIMIT 100;
```

**Index Used:** `IDX_stake_event_timestamp`

### 7. Find Disputes by Claim

```sql
SELECT * FROM disputes
WHERE claimId = ?
ORDER BY createdAt DESC;
```

**Index Used:** `IDX_disputes_claim_id`, `IDX_disputes_created_at`

### 8. Open Disputes

```sql
SELECT * FROM disputes
WHERE status = 'OPEN'
ORDER BY createdAt DESC;
```

**Index Used:** `IDX_disputes_status`, `IDX_disputes_created_at`

### 9. Top Reward Earners Leaderboard

```sql
SELECT walletAddress, SUM(amount) as total_rewards, COUNT(*) as claim_count
FROM reward_claims
GROUP BY walletAddress
ORDER BY total_rewards DESC
LIMIT 100;
```

**Index Used:** `IDX_reward_claims_amount`

### 10. Recent Rewards by Wallet

```sql
SELECT * FROM reward_claims
WHERE walletAddress = ?
ORDER BY blockTimestamp DESC;
```

**Index Used:** `IDX_reward_claims_wallet_timestamp`

## Benchmarking

### Running Benchmarks

1. **Before Migration** - Establish baseline:

```bash
npm run benchmark:indexes
```

2. **Apply Migration**:

```bash
npm run typeorm migration:run
```

3. **After Migration** - Measure improvements:

```bash
npm run benchmark:indexes
```

### Benchmark Script

The benchmark script (`scripts/benchmark-indexes.ts`) tests:

- Single table queries
- Aggregation queries
- Join queries
- Sorting and filtering operations

Results are saved to `benchmark-results/` with timestamps for comparison.

### Expected Improvements

| Query Type                  | Before | After | Improvement |
| --------------------------- | ------ | ----- | ----------- |
| Stakes by claim             | ~80ms  | ~8ms  | 90%         |
| Recent stake events         | ~60ms  | ~6ms  | 90%         |
| Open disputes               | ~40ms  | ~4ms  | 90%         |
| Top earners leaderboard     | ~150ms | ~15ms | 90%         |

_Note: Actual improvements depend on data volume and hardware._

## Performance Considerations

### Index Maintenance

- Indexes are automatically maintained by PostgreSQL
- Write operations (INSERT/UPDATE/DELETE) are slightly slower due to index updates
- Read operations are significantly faster
- Trade-off is favorable for read-heavy workloads

### Partial Indexes

Some indexes use `WHERE` clauses to reduce index size:

- `IDX_claims_confidence_score` only indexes non-null values
- `IDX_claims_resolved_verdict` only indexes non-null values

This reduces index size and maintenance overhead while still optimizing common queries.

### Composite Indexes

Composite indexes are used for queries that filter on multiple columns:

- `IDX_stake_event_claim_wallet` for `(claimId, walletAddress)`
- `IDX_disputes_claim_status` for `(claimId, status)`
- `IDX_reward_claims_wallet_timestamp` for `(walletAddress, blockTimestamp)`

Column order matters: most selective column first.

## Migration Details

**Migration File:** `src/migrations/1769500000000-OptimizeClaimIndexes.ts`

**Applied:** [Date will be filled when migration runs]

**Rollback:** The migration includes a `down()` method to remove all indexes if needed.

## Monitoring

### Query Performance

Monitor slow queries using PostgreSQL's `pg_stat_statements`:

```sql
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
WHERE query LIKE '%claims%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### Index Usage

Check if indexes are being used:

```sql
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename IN ('claims', 'stake', 'stake_event', 'disputes', 'reward_claims')
ORDER BY idx_scan DESC;
```

### Unused Indexes

Identify unused indexes:

```sql
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
AND indexname NOT LIKE '%_pkey'
AND tablename IN ('claims', 'stake', 'stake_event', 'disputes', 'reward_claims');
```

## Recommendations

1. **Run benchmarks regularly** to track performance over time
2. **Monitor index usage** to identify unused indexes
3. **Analyze query plans** using `EXPLAIN ANALYZE` for slow queries
4. **Consider partitioning** if tables grow beyond 10M rows
5. **Vacuum regularly** to maintain index efficiency

## Related Files

- Migration: `src/migrations/1769500000000-OptimizeClaimIndexes.ts`
- Benchmark: `scripts/benchmark-indexes.ts`
- Entities:
  - `src/claims/entities/claim.entity.ts`
  - `src/staking/entities/stake.entity.ts`
  - `src/staking/entities/stake-event.entity.ts`
  - `src/dispute/entities/dispute.entity.ts`
  - `src/rewards/entities/reward-claim.entity.ts`

## References

- [PostgreSQL Index Documentation](https://www.postgresql.org/docs/current/indexes.html)
- [TypeORM Index Documentation](https://typeorm.io/indices)
- [Query Optimization Best Practices](https://www.postgresql.org/docs/current/performance-tips.html)
