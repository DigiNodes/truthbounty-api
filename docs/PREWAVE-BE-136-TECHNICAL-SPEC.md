# PREWAVE-BE-136: Technical Specification

## Background

The canonical event ingestion system currently conflates three distinct concerns:
1. **Event ingestion progress**: Which blocks have had their events ingested
2. **Chain safety**: The provider's reorg-unlikely boundary (safe head)
3. **Chain finality**: The provider's immutable boundary (finalized head)

This conflation causes:
- Events to be prematurely labeled as "safe" before provider confirmation
- Finality to lag during historical backfill
- Projection freshness to misreport data state

## Current Implementation Analysis

### Current Flow

```
Event arrives at block N
  ↓
Ingest into canonical_events
  ↓
Compute: finalizedBlock = N - confirmations.finalized
  ↓
Update checkpoint:
  lastSafeBlock = GREATEST(lastSafeBlock, N)
  lastFinalizedBlock = GREATEST(lastFinalizedBlock, N - confirmations)
  ↓
Projection reads checkpoint
  ↓
Reports data as "safe" or "finalized" based on these values
```

**Problem**: `lastSafeBlock` advances to N immediately, even if provider safe head is < N.

### Provider Finality Tags

Optimism (and EVM chains) support block tags:
- `latest`: Most recent block (may reorg)
- `safe`: Reorg-unlikely (L1-derived finality on Optimism)
- `finalized`: Immutable (L1 finalized on Optimism)

RPC call: `eth_getBlockByNumber(tag, includeTransactions)`

### Existing Optimism Finality Model

From `src/indexer/event-indexer.service.ts`:

```typescript
private async fetchFinalizedBlockNumber(): Promise<number> {
  const block = await withRpcBackoff(
    () => this.provider.send('eth_getBlockByNumber', ['finalized', false])
  );
  return parseInt(block.number, 16);
}
```

This shows the correct approach: query the provider's finalized tag directly.

## Proposed Solution

### 1. Three-Watermark Model

```
┌─────────────────────────────────────────────────┐
│ lastProcessedBlock: 1005                        │  ← Ingestion progress
│ lastSafeBlock: 1000                             │  ← Provider safe tag
│ lastFinalizedBlock: 990                         │  ← Provider finalized tag
│                                                 │
│ Invariant: finalized ≤ safe ≤ processed        │
└─────────────────────────────────────────────────┘
```

### 2. New Schema

#### Migration: Add Processed Block Tracking

```sql
ALTER TABLE v2_event_checkpoints 
  ADD COLUMN "lastProcessedBlock" BIGINT DEFAULT 0,
  ADD COLUMN "lastProcessedBlockHash" VARCHAR(66),
  ADD COLUMN "safeHeadProvenance" VARCHAR(255) DEFAULT 'confirmation-count',
  ADD COLUMN "finalizedHeadProvenance" VARCHAR(255) DEFAULT 'confirmation-count',
  ADD COLUMN "lastObservedAt" TIMESTAMP;

-- Update constraint to include processed block
ALTER TABLE v2_event_checkpoints 
  DROP CONSTRAINT IF EXISTS "chk_v2_checkpoint_final_lte_safe";

ALTER TABLE v2_event_checkpoints 
  ADD CONSTRAINT "chk_v2_checkpoint_ordering" 
  CHECK ("lastFinalizedBlock" <= "lastSafeBlock" AND "lastSafeBlock" <= "lastProcessedBlock");

-- Data migration: current lastSafeBlock becomes lastProcessedBlock
UPDATE v2_event_checkpoints 
SET "lastProcessedBlock" = "lastSafeBlock",
    "lastProcessedBlockHash" = "lastSafeBlockHash";
```

#### Updated Entity

```typescript
@Entity('v2_event_checkpoints')
@Check('chk_v2_checkpoint_ordering', 
  '"lastFinalizedBlock" <= "lastSafeBlock" AND "lastSafeBlock" <= "lastProcessedBlock"')
export class EventCheckpoint {
  // ... existing fields ...
  
  @Column({ type: 'bigint', default: 0 })
  lastProcessedBlock: string;

  @Column({ type: 'varchar', length: 66, nullable: true })
  lastProcessedBlockHash: string | null;

  @Column({ type: 'varchar', length: 255, default: 'confirmation-count' })
  safeHeadProvenance: string;

  @Column({ type: 'varchar', length: 255, default: 'confirmation-count' })
  finalizedHeadProvenance: string;

  @Column({ type: 'timestamp', nullable: true })
  lastObservedAt: Date | null;
}
```

### 3. Chain Head Observer Service

```typescript
// src/v2/events/chain-head-observer.service.ts

export interface ChainHeadSnapshot {
  chainId: number;
  observedBlock: bigint;
  observedHash: string;
  safeBlock: bigint;
  safeHash: string;
  finalizedBlock: bigint;
  finalizedHash: string;
  observedAt: Date;
}

export interface ChainHeadFetchResult {
  status: 'success' | 'partial' | 'unavailable';
  snapshot?: ChainHeadSnapshot;
  error?: string;
  missingTags?: ('safe' | 'finalized')[];
}

@Injectable()
export class ChainHeadObserverService {
  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly config: IndexerConfigService,
  ) {}

  /**
   * Fetch current chain heads from the provider.
   * Validates consistency: finalized <= safe <= observed.
   * Fails closed: returns error status if any tag is unavailable or inconsistent.
   */
  async fetchChainHeads(chainId: number): Promise<ChainHeadFetchResult> {
    try {
      const [latest, safe, finalized] = await Promise.all([
        this.fetchBlockByTag('latest'),
        this.fetchBlockByTag('safe'),
        this.fetchBlockByTag('finalized'),
      ]);

      if (!latest) {
        return { status: 'unavailable', error: 'latest block unavailable' };
      }

      const missingTags: ('safe' | 'finalized')[] = [];
      if (!safe) missingTags.push('safe');
      if (!finalized) missingTags.push('finalized');

      if (missingTags.length > 0) {
        return { 
          status: 'partial', 
          error: `missing tags: ${missingTags.join(', ')}`,
          missingTags,
        };
      }

      // Validate ordering
      if (finalized!.number > safe!.number || safe!.number > latest.number) {
        return {
          status: 'unavailable',
          error: `inconsistent chain heads: finalized=${finalized!.number} safe=${safe!.number} latest=${latest.number}`,
        };
      }

      return {
        status: 'success',
        snapshot: {
          chainId,
          observedBlock: latest.number,
          observedHash: latest.hash,
          safeBlock: safe!.number,
          safeHash: safe!.hash,
          finalizedBlock: finalized!.number,
          finalizedHash: finalized!.hash,
          observedAt: new Date(),
        },
      };
    } catch (error) {
      this.logger.error(`Failed to fetch chain heads for chain ${chainId}:`, error);
      return { 
        status: 'unavailable', 
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchBlockByTag(tag: string): Promise<{ number: bigint; hash: string } | null> {
    try {
      const block = await withRpcBackoff(
        () => this.provider.send('eth_getBlockByNumber', [tag, false])
      );
      return {
        number: BigInt(block.number),
        hash: block.hash,
      };
    } catch (error) {
      this.logger.warn(`Failed to fetch block tag '${tag}':`, error);
      return null;
    }
  }
}
```

### 4. Checkpoint Update Service

```typescript
// src/v2/events/checkpoint-updater.service.ts

@Injectable()
export class CheckpointUpdaterService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly chainHeadObserver: ChainHeadObserverService,
    private readonly config: IndexerConfigService,
  ) {}

  /**
   * Update safe/finalized watermarks for all checkpoints on a chain.
   * Called periodically by the indexer polling loop.
   */
  async updateFinalityWatermarks(chainId: number): Promise<void> {
    const result = await this.chainHeadObserver.fetchChainHeads(chainId);

    if (result.status === 'unavailable') {
      this.logger.warn(`Chain heads unavailable for chain ${chainId}: ${result.error}`);
      return; // Fail closed: do not advance finality on stale/missing data
    }

    if (result.status === 'partial') {
      this.logger.warn(`Partial chain heads for chain ${chainId}: ${result.error}`);
      // Could use confirmation-count fallback here if configured
      return;
    }

    const { snapshot } = result;
    if (!snapshot) return;

    // Update all checkpoints for this chain atomically
    await this.dataSource.transaction(async (manager) => {
      const updateResult = await manager
        .createQueryBuilder()
        .update(EventCheckpoint)
        .set({
          lastSafeBlock: () => `GREATEST("lastSafeBlock", '${snapshot.safeBlock}')`,
          lastSafeBlockHash: snapshot.safeHash,
          lastFinalizedBlock: () => `GREATEST("lastFinalizedBlock", '${snapshot.finalizedBlock}')`,
          lastFinalizedBlockHash: snapshot.finalizedHash,
          safeHeadProvenance: 'provider-safe-tag',
          finalizedHeadProvenance: 'provider-finalized-tag',
          lastObservedAt: snapshot.observedAt,
        })
        .where('chainId = :chainId', { chainId })
        .execute();

      this.logger.debug(
        `Updated finality watermarks for chain ${chainId}: ` +
        `safe=${snapshot.safeBlock} finalized=${snapshot.finalizedBlock} ` +
        `(${updateResult.affected} checkpoints)`
      );
    });

    // Also update BlockchainStateService if it's the canonical authority
    await this.blockchainState.setFinalizedBlock(Number(snapshot.finalizedBlock));
    await this.blockchainState.setSafeBlock(Number(snapshot.safeBlock));
    await this.blockchainState.setObservedHead(Number(snapshot.observedBlock));
  }
}
```

### 5. Updated Ingestion Service

```typescript
// src/v2/events/canonical-events.service.ts

async ingest(log: RawLog): Promise<IngestOutcome> {
  // ... existing validation and decoding ...

  return this.dataSource.transaction(async (manager) => {
    // ... insert canonical event ...

    // Update ONLY processed block, not safe/finalized
    const newBlock = normalized.event.blockNumber;
    const newBlockStr = newBlock.toString();

    const updateResult = await manager
      .createQueryBuilder()
      .update(EventCheckpoint)
      .set({
        lastProcessedBlock: () => `GREATEST("lastProcessedBlock", '${newBlockStr}')`,
        lastProcessedBlockHash: log.blockHash, // if available
      })
      .where('chainId = :chainId AND contractAddress = :contractAddress', {
        chainId: log.chainId,
        contractAddress: normalized.event.contractAddress,
      })
      .execute();

    if (updateResult.affected === 0) {
      await manager.insert(EventCheckpoint, {
        chainId: log.chainId,
        contractAddress: normalized.event.contractAddress,
        lastProcessedBlock: newBlockStr,
        lastProcessedBlockHash: log.blockHash,
        lastSafeBlock: '0',      // Will be updated by checkpoint updater
        lastFinalizedBlock: '0', // Will be updated by checkpoint updater
      });
    }

    return { status: 'ingested', event: normalized.event };
  });
}
```

### 6. Integration Points

#### A. Indexer Polling Loop

Add checkpoint update to existing indexer service:

```typescript
// In event-indexer.service.ts or new v2-indexer-orchestrator.service.ts

async pollChain(): Promise<void> {
  // 1. Fetch chain heads and update finality watermarks
  await this.checkpointUpdater.updateFinalityWatermarks(this.chainId);

  // 2. Fetch and ingest new events (existing logic)
  await this.fetchAndIngestEvents();

  // 3. Run projectors (existing logic)
  await this.runProjectors();
}
```

#### B. Projection Freshness

Update to read new field:

```typescript
// src/v2/projection/projection-freshness.service.ts

private resolveIndexedBlock(cursor: ProjectorCursor, checkpoints: EventCheckpoint[]): string | null {
  // For V2 projectors, use the checkpoint's PROCESSED block, not safe block
  const checkpoint = checkpoints.find(
    c => c.chainId === cursor.chainId && c.contractAddress === cursor.contractAddress
  );
  return checkpoint?.lastProcessedBlock ?? null;
}
```

#### C. Health and Metrics

```typescript
// Expose new metrics
indexer_processed_block{chain_id="10",contract="0x..."} 1005
indexer_safe_block{chain_id="10",contract="0x..."} 1000
indexer_finalized_block{chain_id="10",contract="0x..."} 990

// Health check now shows provenance
{
  "chainId": 10,
  "lastProcessedBlock": "1005",
  "lastSafeBlock": "1000",
  "lastFinalizedBlock": "990",
  "safeHeadProvenance": "provider-safe-tag",
  "finalizedHeadProvenance": "provider-finalized-tag",
  "lastObservedAt": "2026-11-20T10:30:00Z"
}
```

### 7. Fallback and Fail-Closed Behavior

#### When Provider Tags Unavailable

```typescript
const config = this.indexerConfig.getEventIndexerConfig();

if (result.status === 'partial' && config.fallbackToConfirmationCount) {
  // Use confirmation-count as fallback (ONLY if explicitly configured)
  const safeBlock = snapshot.observedBlock - BigInt(config.confirmations.safe);
  const finalizedBlock = snapshot.observedBlock - BigInt(config.confirmations.finalized);
  
  // Update with explicit provenance marking
  await updateCheckpoint({
    safeBlock,
    finalizedBlock,
    safeHeadProvenance: 'confirmation-count-fallback',
    finalizedHeadProvenance: 'confirmation-count-fallback',
  });
} else {
  // Fail closed: do not advance finality on missing/stale provider data
  this.logger.warn('Provider finality unavailable and fallback disabled');
  // Health endpoint will show stale lastObservedAt
}
```

## Testing Strategy

### Unit Tests

```typescript
describe('ChainHeadObserverService', () => {
  it('fetches and validates consistent chain heads', async () => {
    mockProvider.send
      .mockResolvedValueOnce({ number: '0x3e8', hash: '0xlatest' }) // latest: 1000
      .mockResolvedValueOnce({ number: '0x3e0', hash: '0xsafe' })   // safe: 992
      .mockResolvedValueOnce({ number: '0x3d8', hash: '0xfinal' }); // finalized: 984

    const result = await service.fetchChainHeads(10);
    expect(result.status).toBe('success');
    expect(result.snapshot?.finalizedBlock).toBe(984n);
  });

  it('rejects inconsistent chain heads (finalized > safe)', async () => {
    mockProvider.send
      .mockResolvedValueOnce({ number: '0x3e8', hash: '0xlatest' })
      .mockResolvedValueOnce({ number: '0x3e0', hash: '0xsafe' })
      .mockResolvedValueOnce({ number: '0x3f0', hash: '0xfinal' }); // WRONG: 1008 > 992

    const result = await service.fetchChainHeads(10);
    expect(result.status).toBe('unavailable');
    expect(result.error).toContain('inconsistent');
  });
});

describe('CheckpointUpdaterService', () => {
  it('updates all checkpoints for a chain', async () => {
    await checkpointRepo.save([
      { chainId: 10, contractAddress: '0xA', lastProcessedBlock: '1000' },
      { chainId: 10, contractAddress: '0xB', lastProcessedBlock: '995' },
    ]);

    mockObserver.fetchChainHeads.mockResolvedValue({
      status: 'success',
      snapshot: { safeBlock: 990n, finalizedBlock: 980n, /* ... */ },
    });

    await service.updateFinalityWatermarks(10);

    const checkpoints = await checkpointRepo.find({ where: { chainId: 10 } });
    expect(checkpoints.every(c => c.lastSafeBlock === '990')).toBe(true);
    expect(checkpoints.every(c => c.lastFinalizedBlock === '980')).toBe(true);
  });
});
```

### Integration Tests

```typescript
describe('Checkpoint Finality (Integration)', () => {
  it('ingests event at block N while provider heads are behind N', async () => {
    // Setup: provider finalized at 100, safe at 110
    mockProvider.send.mockImplementation((method, params) => {
      if (params[0] === 'finalized') return { number: '0x64', hash: '0xf100' };
      if (params[0] === 'safe') return { number: '0x6E', hash: '0xs110' };
      return { number: '0x78', hash: '0xl120' }; // latest: 120
    });

    // Ingest event at block 115 (between safe and latest)
    await canonicalEventsService.ingest(makeLog({ blockNumber: 115n }));

    const checkpoint = await checkpointRepo.findOne({ 
      where: { chainId: 10, contractAddress: TEST_CONTRACT } 
    });

    expect(checkpoint.lastProcessedBlock).toBe('115');
    expect(checkpoint.lastSafeBlock).toBe('110'); // NOT 115!
    expect(checkpoint.lastFinalizedBlock).toBe('100'); // NOT 103!
  });

  it('advances finality during historical backfill', async () => {
    // Backfill old event at block 50
    await canonicalEventsService.ingest(makeLog({ blockNumber: 50n }));

    // Provider heads are current
    mockProvider.send.mockImplementation((method, params) => {
      if (params[0] === 'finalized') return { number: '0xc8', hash: '0xf200' }; // 200
      if (params[0] === 'safe') return { number: '0xd2', hash: '0xs210' }; // 210
      return { number: '0xdc', hash: '0xl220' }; // 220
    });

    await checkpointUpdater.updateFinalityWatermarks(10);

    const checkpoint = await checkpointRepo.findOne({ 
      where: { chainId: 10, contractAddress: TEST_CONTRACT } 
    });

    expect(checkpoint.lastProcessedBlock).toBe('50'); // ingestion at 50
    expect(checkpoint.lastFinalizedBlock).toBe('200'); // from provider, not 50-12=38!
  });
});
```

### Reorg Tests

```typescript
describe('Reorg Handling', () => {
  it('never marks reorged block as finalized', async () => {
    // Ingest block 100
    await canonicalEventsService.ingest(makeLog({ blockNumber: 100n, hash: '0xold' }));

    // Provider reports 100 as safe but not finalized
    mockProvider.send.mockImplementation((method, params) => {
      if (params[0] === 'finalized') return { number: '0x5a', hash: '0xf90' }; // 90
      if (params[0] === 'safe') return { number: '0x64', hash: '0xs100' }; // 100
      return { number: '0x6e', hash: '0xl110' }; // 110
    });

    await checkpointUpdater.updateFinalityWatermarks(10);

    // Block 100 reorgs to different hash
    await reorgRecovery.handleReorg({ 
      chainId: 10, 
      reorgBlock: 100n, 
      newHash: '0xnew' 
    });

    const checkpoint = await checkpointRepo.findOne({ 
      where: { chainId: 10, contractAddress: TEST_CONTRACT } 
    });

    // Block 100 was marked safe but NOT finalized, so reorg is allowed
    expect(checkpoint.lastFinalizedBlock).toBe('90');
    expect(checkpoint.lastSafeBlock).toBeLessThanOrEqual(90); // reset during reorg
  });
});
```

## Rollout Plan

### Phase 1: Schema Migration (Non-Breaking)

1. Add new columns with defaults
2. Populate `lastProcessedBlock` from current `lastSafeBlock`
3. Deploy migration to staging
4. Verify existing queries still work

### Phase 2: Add Services (Additive)

1. Deploy `ChainHeadObserverService`
2. Deploy `CheckpointUpdaterService`
3. Wire into indexer but don't change ingestion yet
4. Verify provider heads are being fetched correctly

### Phase 3: Switch Ingestion (Breaking)

1. Update `canonical-events.service.ts` to only update `lastProcessedBlock`
2. Remove `getFinalizedBlock()` method
3. Deploy to staging, run full suite
4. Monitor finality watermarks for correctness

### Phase 4: Update Consumers

1. Update `ProjectionFreshnessService`
2. Update health/metrics endpoints
3. Update documentation
4. Deploy to staging, verify read models

### Phase 5: Production

1. Deploy to production with monitoring
2. Validate metrics and health checks
3. Document new behavior in runbook

## Monitoring and Observability

### New Prometheus Metrics

```
indexer_processed_block{chain_id, contract}
indexer_safe_block{chain_id, contract}
indexer_finalized_block{chain_id, contract}
indexer_chain_head_fetch_failures_total{chain_id}
indexer_checkpoint_update_duration_seconds{chain_id}
indexer_finality_lag_seconds{chain_id}  # time since lastObservedAt
```

### Health Check Response

```json
{
  "status": "healthy",
  "chainId": 10,
  "checkpoints": [
    {
      "contractAddress": "0x123...",
      "lastProcessedBlock": "1005",
      "lastSafeBlock": "1000",
      "lastFinalizedBlock": "990",
      "safeHeadProvenance": "provider-safe-tag",
      "finalizedHeadProvenance": "provider-finalized-tag",
      "lastObservedAt": "2026-11-20T10:30:00Z",
      "finalityLagSeconds": 12
    }
  ]
}
```

### Alerts

```yaml
- alert: FinalityWatermarkStale
  expr: time() - indexer_last_observed_timestamp_seconds > 300
  annotations:
    summary: "Finality watermarks have not been updated in 5 minutes"

- alert: FinalityProviderUnavailable
  expr: rate(indexer_chain_head_fetch_failures_total[5m]) > 0.5
  annotations:
    summary: "Chain head fetch failures exceed 50% in 5m window"

- alert: ProcessedAheadOfFinalized
  expr: indexer_processed_block - indexer_finalized_block > 1000
  annotations:
    summary: "Processed block is >1000 ahead of finalized (check provider lag)"
```

## Security and Safety

### Fail-Closed Guarantees

1. **Missing provider response** → no finality advancement
2. **Inconsistent chain heads** → reject and log error
3. **Stale provider data** → health check reports degraded
4. **Concurrent updates** → database monotonicity prevents regression
5. **Malformed block tags** → validation rejects before persistence

### Audit Trail

All finality updates include provenance:
- `provider-safe-tag` - from eth_getBlockByNumber("safe")
- `provider-finalized-tag` - from eth_getBlockByNumber("finalized")
- `confirmation-count-fallback` - computed fallback (if configured)
- Timestamp in `lastObservedAt`

## Open Issues for Maintainer Review

1. **Should we use BlockchainStateService.advanceCursor()?**
   - Current spec updates EventCheckpoint directly
   - Cursor system from #814 may be canonical authority
   - Need to reconcile or choose one

2. **Per-contract vs per-chain finality?**
   - Provider tags are chain-wide
   - EventCheckpoint is per-(chain, contract)
   - Should we create a separate ChainHeadCheckpoint table?

3. **Confirmation-count fallback policy?**
   - Always disabled (fail closed)?
   - Opt-in via config?
   - Chain-specific policies?

4. **Backward compatibility strategy?**
   - Keep old confirmations config as fallback?
   - Hard migration vs dual-write period?

5. **SQLite test compatibility?**
   - CHECK constraint syntax
   - GREATEST() function
   - Need alternative for SQLite tests?
