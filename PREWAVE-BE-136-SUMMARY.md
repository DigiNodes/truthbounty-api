# PREWAVE-BE-136: Derive Safe and Finalized Checkpoints from Canonical Chain Heads

## Quick Summary

**Issue**: The V2 event ingestion currently sets checkpoint values (`lastSafeBlock`, `lastFinalizedBlock`) based on the block number of each ingested event, rather than querying the provider's actual safe/finalized chain heads. This causes:
- Events to be incorrectly labeled as "safe" before provider confirmation
- Finality to lag during historical backfill
- Projection freshness to misreport data state

**Solution**: Separate event ingestion progress from chain finality by:
1. Adding `lastProcessedBlock` to track ingestion progress
2. Fetching provider chain heads (`eth_getBlockByNumber("safe")` / `"finalized"`)
3. Updating safe/finalized watermarks from provider responses, not event blocks
4. Maintaining invariant: `lastFinalizedBlock ≤ lastSafeBlock ≤ lastProcessedBlock`

## Problem Detail

### Current Broken Flow

```typescript
// In canonical-events.service.ts
private getFinalizedBlock(currentEventBlock: bigint): bigint {
  return currentEventBlock - BigInt(config.confirmations.finalized);
}

// When ingesting event at block 1005:
lastSafeBlock = GREATEST(lastSafeBlock, 1005)              // ❌ Wrong!
lastFinalizedBlock = GREATEST(lastFinalizedBlock, 1005-12) // ❌ Wrong!
```

**Problems:**
- If provider safe head is at 1000, we incorrectly advance to 1005
- During backfill of block 50 while provider is at 200, finalized stays at 38 instead of advancing to 200
- Projection freshness reports events as "safe" when they're still reorgable

### Correct Flow

```typescript
// During ingestion:
lastProcessedBlock = GREATEST(lastProcessedBlock, 1005) // ✓ Track ingestion

// Separately, from provider:
safeBlock = await provider.send('eth_getBlockByNumber', ['safe', false])
finalizedBlock = await provider.send('eth_getBlockByNumber', ['finalized', false])

// Update checkpoints:
lastSafeBlock = GREATEST(lastSafeBlock, safeBlock)           // ✓ From provider!
lastFinalizedBlock = GREATEST(lastFinalizedBlock, finalizedBlock) // ✓ From provider!
```

## Implementation Overview

### 1. Schema Changes (Migration Required)

Add to `EventCheckpoint` entity:
- `lastProcessedBlock` / `lastProcessedBlockHash` - ingestion progress
- `safeHeadProvenance` / `finalizedHeadProvenance` - track source ("provider-safe-tag" vs "confirmation-count-fallback")
- `lastObservedAt` - timestamp of last provider observation
- Update CHECK constraint: `lastFinalizedBlock ≤ lastSafeBlock ≤ lastProcessedBlock`

### 2. New Services

**ChainHeadObserverService**
- Fetches provider chain heads: `latest`, `safe`, `finalized`
- Validates consistency: finalized ≤ safe ≤ observed
- Fails closed on missing/stale/inconsistent data

**CheckpointUpdaterService**  
- Polls chain heads periodically
- Updates safe/finalized watermarks for all contracts on chain
- Uses monotonic SQL (`GREATEST()`) to prevent regression
- Logs provenance for audit trail

### 3. Updated Ingestion

**canonical-events.service.ts**
- Remove `getFinalizedBlock()` method
- Only update `lastProcessedBlock` during ingestion
- Never touch `lastSafeBlock`/`lastFinalizedBlock`

### 4. Integration

- Wire checkpoint updater into indexer polling loop
- Update `ProjectionFreshnessService` to read `lastProcessedBlock`
- Expose new metrics and health checks
- Update runbook documentation

## Key Design Decisions

### ✅ Separation of Concerns

| Concern | Tracks | Source | Update Trigger |
|---------|--------|--------|----------------|
| Ingestion Progress | Which events processed | Event ingestion | Every event |
| Safe Head | Reorg-unlikely boundary | Provider RPC | Periodic poll |
| Finalized Head | Immutable boundary | Provider RPC | Periodic poll |

### ✅ Fail-Closed Safety

- Missing provider response → no finality advancement
- Inconsistent chain heads → reject and alert  
- Stale data → health check reports degraded
- Concurrent updates → database monotonicity prevents regression

### ✅ Provenance Tracking

Every checkpoint update records:
- Source: `"provider-safe-tag"` vs `"confirmation-count-fallback"`
- Timestamp: `lastObservedAt`
- Hash: for reorg detection

## Files Modified

### New Files
- `src/v2/events/chain-head-observer.service.ts`
- `src/v2/events/checkpoint-updater.service.ts`
- `migrations/XXXXXXX-add-processed-block-tracking.ts`
- Tests for above

### Modified Files
- `src/v2/events/canonical-events.service.ts` - Remove finalized computation, track processed block
- `src/v2/events/entities/event-checkpoint.entity.ts` - Add new fields
- `src/v2/projection/projection-freshness.service.ts` - Read lastProcessedBlock
- `src/v2/events/v2-events.module.ts` - Register new services
- `docs/indexer-runbook.md` - Document new watermarks

## Testing Requirements

### Unit Tests (Per Acceptance Criteria)
- ✅ Provider returns valid heads → success
- ✅ Provider returns stale/regressed heads → reject
- ✅ Provider unavailable → fail gracefully
- ✅ Malformed responses → reject
- ✅ Concurrent updates → no races

### Integration Tests  
- ✅ Ingest event at N while provider heads < N → finality doesn't advance
- ✅ Ingest old logs while provider ahead → finality advances from provider
- ✅ Checkpoint and freshness responses agree on scope
- ✅ PostgreSQL transactional persistence and restart
- ✅ Reorg affecting unfinalized block → watermarks correct

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Provider finality unavailable | System can't advance finality | Fail closed with clear health/logs; optional confirmation-count fallback |
| Data migration breaks existing | Projections fail | Add new fields without removing old; dual-write transition period |
| Cursor vs Checkpoint conflict | Two competing authorities | Reconcile with #814 cursor authority; document relationship |
| Performance impact | Polling adds RPC load | Batch updates per chain; use existing indexer interval |

## Dependencies

### Required Before Implementation
- **#814**: Consolidate reorg state on durable canonical cursor
  - *Question*: Is `BlockchainStateService.advanceCursor()` the canonical authority?
  - *Action*: Reconcile checkpoint vs cursor persistence strategy

- **#596**: Canonical finalized-block ingestion cursor  
  - *Question*: Is there a separate cursor mechanism we should use?
  - *Action*: Ensure single source of truth for finality

### Related
- **#453**: Projection readiness and finality gate
- **#833**: Enforce chain/deployment scope in projectors

## Open Questions for Maintainer

1. **Cursor Authority**: Should we use `BlockchainStateService.advanceCursor()` instead of direct EventCheckpoint updates? (#814 relationship)

2. **Per-Contract vs Per-Chain**: Provider tags are chain-wide but EventCheckpoint is per-contract. Should we create a separate `ChainHeadCheckpoint` table?

3. **Fallback Policy**: When provider tags unavailable:
   - Always fail closed?
   - Allow confirmation-count fallback if configured?
   - Chain-specific policies?

4. **Polling Frequency**: Should chain head observation be:
   - Every ingestion batch?
   - Separate timer?
   - Existing indexer poll interval?

5. **Optimism-Specific**: Do Sepolia vs Mainnet require different finality handling?

## Acceptance Criteria Status

- [ ] Ingestion progress, safe head, and finalized head are distinct persisted facts
- [ ] Safe/finalized watermarks come from provider chain heads, not event blocks
- [ ] Unavailable or inconsistent provider finality fails closed and is visible in health output
- [ ] No unfinalized event is labeled safe/finalized solely because it was ingested
- [ ] Reorg handling preserves checkpoint invariants
- [ ] Documentation and tests match actual Optimism finality policy
- [ ] Uses single durable cursor/checkpoint authority from #814/#596

## Estimated Complexity

**200 points (High)** based on:
- Schema migration with data backfill
- New services with RPC integration
- Cross-cutting changes to ingestion and projections
- Extensive integration testing required
- Coordination with #814 and #596
- Production rollout with monitoring

**Timeline**: ~5 days (phased rollout)

## Documentation Created

1. **PREWAVE-BE-136-IMPLEMENTATION-PLAN.md** - High-level phases and tasks
2. **PREWAVE-BE-136-TECHNICAL-SPEC.md** - Detailed technical design with code examples
3. **PREWAVE-BE-136-SUMMARY.md** - This file: executive summary

## Next Steps

1. ✅ Review implementation plan and technical spec
2. ⏳ Answer open questions (cursor authority, fallback policy, etc.)
3. ⏳ Coordinate with #814 and #596 maintainers
4. ⏳ Begin Phase 1: Schema migration
5. ⏳ Implement chain head observer service
6. ⏳ Update ingestion service
7. ⏳ Write comprehensive tests
8. ⏳ Deploy to staging and validate
9. ⏳ Production rollout with monitoring

## Contact

For questions or clarifications on this implementation plan:
- Review the technical spec for detailed code examples
- Check the implementation plan for phase-by-phase breakdown
- Consult related issues #814, #596, #453, #833
