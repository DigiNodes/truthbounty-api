# PREWAVE-BE-136: Derive Safe and Finalized Checkpoints from Canonical Chain Heads

## Problem Summary

The V2 canonical-event ingestion path (`src/v2/events/canonical-events.service.ts`) currently:

1. **Conflates event ingestion with chain finality**: Sets `lastSafeBlock = event.blockNumber` when ingesting an event, treating the just-ingested block as safe even though it hasn't been validated against the provider's actual safe head.

2. **Computes finalized from event block**: Uses `getFinalizedBlock(currentEventBlock) = currentEventBlock - confirmations.finalized` instead of querying the provider's finalized tag.

3. **Can advance finality beyond actual chain heads**: If the provider's safe head is at block 1000 but we ingest an event at block 1005, `lastSafeBlock` advances to 1005 incorrectly.

4. **Fails for historical backfill**: When backfilling old logs while the provider heads are substantially ahead, finality remains tied to each log's block rather than advancing from the observed heads.

## Current Code Problems

### `canonical-events.service.ts` (lines 69-105)

```typescript
private getFinalizedBlock(currentEventBlock: bigint): bigint {
  const config = this.indexerConfig.getEventIndexerConfig();
  return currentEventBlock - BigInt(config.confirmations.finalized);
}

// In the ingest transaction:
const newBlock = normalized.event.blockNumber;
const finalizedBlock = this.getFinalizedBlock(newBlock);

await manager
  .createQueryBuilder()
  .update(EventCheckpoint)
  .set({
    lastSafeBlock: () => `GREATEST("lastSafeBlock", '${newBlockStr}')`,
    lastFinalizedBlock: () => `GREATEST("lastFinalizedBlock", '${finalizedBlockStr}')`,
  })
```

**Problems:**
- `newBlockStr` (the event's block) is used directly as the safe watermark
- `finalizedBlockStr` is computed from the event block, not from the provider's finalized head
- No independent observation of provider safe/finalized tags

## Solution Architecture

### 1. Separate Three Concerns

| Concern | What it tracks | Source |
|---------|---------------|--------|
| **Ingestion Progress** | Highest block with events ingested | Event processing |
| **Safe Head** | Reorg-unlikely boundary | Provider `eth_getBlockByNumber("safe")` |
| **Finalized Head** | Immutable canonical boundary | Provider `eth_getBlockByNumber("finalized")` |

### 2. EventCheckpoint Schema Extension

The `EventCheckpoint` entity already has the required fields:
- `lastSafeBlock` / `lastSafeBlockHash` 
- `lastFinalizedBlock` / `lastFinalizedBlockHash`

We need to add:
- `lastProcessedBlock` / `lastProcessedBlockHash` - track ingestion progress separately
- `lastObservedAt` - timestamp of last provider head observation
- `safeHeadProvenance` / `finalizedHeadProvenance` - source of the watermark (e.g., "provider-safe-tag", "confirmation-count")

### 3. Provider Chain Head Observation

Create a new service method to fetch and persist provider-reported chain heads:

```typescript
interface ChainHeadSnapshot {
  observedBlock: bigint;
  observedHash: string;
  safeBlock: bigint;
  safeHash: string;
  finalizedBlock: bigint;
  finalizedHash: string;
  observedAt: Date;
  chainId: number;
}

async fetchChainHeads(chainId: number): Promise<ChainHeadSnapshot> {
  const latest = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const safe = await provider.send('eth_getBlockByNumber', ['safe', false]);
  const finalized = await provider.send('eth_getBlockByNumber', ['finalized', false]);
  
  // Validate: finalized <= safe <= observed
  // Return structured snapshot
}
```

### 4. Checkpoint Update Strategy

**During event ingestion** (`canonical-events.service.ts`):
- Update `lastProcessedBlock` to track ingestion progress
- Do NOT update `lastSafeBlock` or `lastFinalizedBlock`

**During chain head polling** (new service or existing indexer):
- Fetch provider chain heads periodically
- Update `lastSafeBlock` and `lastFinalizedBlock` from provider response
- Validate invariants: `finalizedBlock <= safeBlock <= processedBlock`
- Persist hashes for reorg detection

**Monotonicity guarantees:**
- All three watermarks can only advance (never regress without explicit rollback)
- A missing/stale/malformed provider response must not advance finality
- Concurrent updates use database-level monotonic guards (`GREATEST()`)

### 5. Integration with Existing Systems

#### Dependency #814 - Canonical Cursor

The issue mentions #814 establishes a "durable canonical cursor." We need to:
- Check if `BlockchainStateService.advanceCursor()` is the canonical authority
- Ensure checkpoint updates don't conflict with cursor state
- Reconcile per-contract checkpoints with chain-wide cursor state

#### Dependency #596 - Finalized Block Ingestion Cursor

Mentions establishing "canonical finalized-block ingestion cursor." Need to:
- Identify if there's a separate finalized cursor mechanism
- Ensure we use it as the single source of truth
- Avoid creating a second competing cursor system

#### Projection Freshness (#453)

The `ProjectionFreshnessService` consumes checkpoint values:
- Must read the NEW `lastProcessedBlock` for ingestion progress
- Continue reading `lastSafeBlock`/`lastFinalizedBlock` for finality
- Update `classifyByCheckpoint` logic if needed

## Implementation Tasks

### Phase 1: Schema and Types

1. **Extend EventCheckpoint entity**
   - Add `lastProcessedBlock` and `lastProcessedBlockHash`
   - Add `safeHeadProvenance` and `finalizedHeadProvenance`
   - Add `lastObservedAt` timestamp
   - Update CHECK constraint: `lastFinalizedBlock <= lastSafeBlock <= lastProcessedBlock`
   - Create migration

2. **Create ChainHeadSnapshot interface**
   - Define structured provider response type
   - Add validation helpers

### Phase 2: Provider Chain Head Service

3. **Create chain-head-observer.service.ts**
   - `fetchChainHeads(chainId: number): Promise<ChainHeadSnapshot>`
   - Handle RPC failures gracefully (return null or throw?)
   - Validate response consistency (finalized <= safe <= observed)
   - Add timeout and retry logic

4. **Integrate with V2 events module**
   - Register service in `v2-events.module.ts`
   - Determine polling frequency (reuse existing indexer interval?)

### Phase 3: Checkpoint Update Refactor

5. **Update canonical-events.service.ts**
   - Remove `getFinalizedBlock()` method
   - Change checkpoint update to only touch `lastProcessedBlock`
   - Remove direct updates to `lastSafeBlock`/`lastFinalizedBlock`

6. **Create checkpoint-updater.service.ts** (or integrate into existing service)
   - Periodic polling to fetch provider chain heads
   - Transactional update of `lastSafeBlock`/`lastFinalizedBlock` per checkpoint
   - Per-contract scope: update all EventCheckpoint rows for chainId
   - Monotonicity enforcement via `GREATEST()`

### Phase 4: Integration and Validation

7. **Update ProjectionFreshnessService**
   - Change to read `lastProcessedBlock` for indexed height
   - Verify dataState classification still works correctly

8. **Update indexer health/metrics**
   - Expose new fields in health snapshot
   - Add Prometheus metrics for processed vs finalized gap
   - Update runbook references

9. **Reconcile with #814 cursor authority**
   - Investigate if `BlockchainStateService.advanceCursor()` should be used
   - Ensure single source of truth for finality
   - Document cursor vs checkpoint relationship

### Phase 5: Tests

10. **Unit tests for chain head observer**
    - Provider returns valid heads: success
    - Provider returns stale/regressed heads: reject
    - Provider returns inconsistent heads (finalized > safe): reject
    - Provider unavailable: fail gracefully
    - Malformed responses: reject

11. **Integration tests for checkpoint updates**
    - Ingest event at block N while provider heads are behind N: finality doesn't advance
    - Ingest historical logs while provider ahead: finality advances from provider
    - Concurrent ingestion + head updates: no races or regressions
    - Checkpoint and freshness responses agree on scope

12. **PostgreSQL integration tests**
    - Transactional persistence of all three watermarks
    - Restart/replay behavior
    - CHECK constraint enforcement

13. **Reorg scenario tests**
    - Reorg affecting unfinalized block: watermarks remain correct
    - Finalized block never regresses without explicit rollback

## Non-Goals (Explicitly Out of Scope)

- ❌ Changing Optimism finality semantics
- ❌ Treating API-computed confirmations as substitute for provider tags (unless chain policy requires it)
- ❌ Changing contract state or protocol authority
- ❌ Mainnet deployment, contributor assignment, Drips, points, Stellar Wave

## Acceptance Criteria Checklist

- [ ] Ingestion progress, safe head, and finalized head are distinct persisted facts
- [ ] Safe/finalized watermarks come from provider chain heads, not event blocks
- [ ] Unavailable or inconsistent provider finality fails closed and is visible in health output
- [ ] No unfinalized event is labeled safe/finalized solely because it was ingested
- [ ] Reorg handling preserves checkpoint invariants
- [ ] Documentation and tests match actual Optimism finality policy
- [ ] Uses single durable cursor/checkpoint authority from #814/#596

## Open Questions

1. **Cursor vs Checkpoint**: Does #814 establish `BlockchainStateService.advanceCursor()` as the canonical authority, or is `EventCheckpoint` the V2-specific persistence?

2. **Polling frequency**: Should chain head observation be:
   - On every ingestion batch?
   - On a separate timer?
   - Integrated into existing indexer poll loop?

3. **Per-contract vs per-chain**: Are safe/finalized heads chain-wide (same for all contracts) or contract-specific? Schema suggests per-contract but provider tags are per-chain.

4. **Fallback policy**: When provider finality tags are unavailable:
   - Use confirmation-count as fallback?
   - Fail closed (no advancement)?
   - Use last known good value?

5. **Chain-specific policies**: Does Optimism Sepolia vs Mainnet require different handling of finality tags?

## Risk Mitigation

### Breaking Change Risk
- **Risk**: Changing checkpoint semantics could break existing projections
- **Mitigation**: Add new fields without removing old ones initially; dual-write during transition

### Data Migration Risk  
- **Risk**: Existing checkpoints have `lastSafeBlock` set to processed blocks
- **Mitigation**: Migration script to split into `lastProcessedBlock` (from lastSafeBlock) and reset `lastSafeBlock` to conservative value

### Provider Outage Risk
- **Risk**: If provider finality tags become unavailable, system stalls
- **Mitigation**: Fail closed but log clearly; health endpoint exposes stale finality; fallback to confirmation-count if explicitly configured

## Timeline Estimate

- Phase 1 (Schema): 0.5 day
- Phase 2 (Provider service): 1 day
- Phase 3 (Checkpoint refactor): 1 day
- Phase 4 (Integration): 1 day
- Phase 5 (Tests): 1.5 days
- **Total**: ~5 days (200 points at 40 points/day)

## Related Documentation

- `docs/indexer-runbook.md` - Defines observed/safe/finalized signals
- `src/v2/events/entities/event-checkpoint.entity.ts` - Current checkpoint schema
- `src/blockchain/state.service.ts` - Chain state management
- `src/indexer/event-indexer.service.ts` - Has `fetchFinalizedBlockNumber()` example
- `src/config/finality-policy.service.ts` - Finality classification logic

## Next Steps

1. Review this plan with maintainer
2. Answer open questions
3. Create detailed task list
4. Begin with Phase 1 schema changes
