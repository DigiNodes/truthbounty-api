# Implementation Summary: Event Indexing Service

## Overview

A production-ready **Smart Contract Event Indexing Service** has been implemented for the TruthBounty API. This service provides the foundation for syncing on-chain rewards and stakes from the Optimism blockchain into PostgreSQL.

## What Was Built

### 1. **Core Infrastructure**

#### Database Entities (`src/entities/`)
- **IndexedEvent**: Stores individual smart contract events with full traceability
  - Unique constraints on `(txHash, logIndex, eventType)` for idempotency
  - Tracks: block number, confirmations, finalization status, processing state
  - Supports retry tracking and error messages

- **IndexingState**: Tracks progress per contract/event type
  - Resume-friendly: stores last processed block number
  - Status tracking: `idle`, `indexing`, `backfilling`, `error`
  - Metrics: total events, processed, failed counts

#### Configuration (`src/config/`)
- **EventIndexerConfig**: Type-safe configuration interface
- **IndexerConfigService**: Environment-based configuration loader
- Supports multiple contracts and event types
- Customizable polling, batch sizes, and confirmation thresholds

#### Event Indexing Engine (`src/indexer/`)
- **EventIndexerService**: Core indexing logic
  - Polls Optimism RPC at configurable intervals
  - Fetches events using `eth_getLogs`
  - Decodes events using ethers.js
  - Prevents duplicates via database uniqueness constraints
  - Detects and recovers from chain reorgs
  - Retries failed events with configurable limits

- **IndexerModule**: NestJS module with lifecycle management
  - Auto-starts on module initialization
  - Clean shutdown on module destruction

- **IndexerController**: REST API for management
  - `GET /indexer/status` - Current status and metrics
  - `POST /indexer/restart` - Restart the indexer
  - `POST /indexer/backfill` - Resume from specific block

### 2. **Key Safety Features**

#### Idempotency
```sql
UNIQUE (transaction_hash, log_index, event_type)
```
- Prevents duplicate event processing even if indexed multiple times
- Database enforces uniqueness at storage layer

#### Reorg Safety
- Tracks block confirmations for each event
- Configurable confirmation threshold (default 12 blocks)
- Automatically marks events as "unfinalized" if confirmations drop below threshold
- Reconciliation loop detects and recovers from reorgs

#### Restart-Safe Indexing
- Stores `lastProcessedBlockNumber` for each contract/event
- Can resume from any block without data loss
- Supports backfilling from historical blocks

#### Error Handling
- Tracks failed events with error messages
- Configurable retry attempts (default 3)
- Failed events remain in database for manual inspection

### 3. **Database Schema**

#### indexed_events table
```
id (UUID, PK)
eventType (VARCHAR)
contractAddress (VARCHAR)
transactionHash (VARCHAR)
blockNumber (BIGINT)
logIndex (INTEGER)
chainId (INTEGER)
eventData (JSONB) - raw log data
parsedData (JSONB) - decoded parameters
confirmations (INTEGER)
isFinalized (BOOLEAN)
isProcessed (BOOLEAN)
processingError (TEXT)
retryAttempts (INTEGER)
processedAt (TIMESTAMP)
createdAt, updatedAt
```

**Indexes**:
- `(blockNumber, logIndex)` - unique
- `(transactionHash, logIndex, eventType)` - unique
- `(eventType, blockNumber)` - for queries by event type
- `(processedAt)` - for time-based queries

#### indexing_state table
```
id (UUID, PK)
chainId (INTEGER)
contractAddress (VARCHAR)
eventType (VARCHAR)
lastProcessedBlockNumber (BIGINT)
lastScannedBlockNumber (BIGINT)
lastFinalizedBlockNumber (BIGINT)
status (VARCHAR) - idle/indexing/backfilling/error
errorMessage (TEXT)
totalEventCount, processedEventCount, failedEventCount
blockRangePerBatch, confirmationsRequired, maxRetryAttempts
lastIndexedAt, lastSyncedAt
createdAt, updatedAt
```

**Index**: `(chainId, contractAddress, eventType)` - unique

### 4. **Configuration**

Environment variables (see `.env.example`):

```env
# RPC
OPTIMISM_RPC_URL=https://mainnet.optimism.io
CHAIN_ID=10

# Indexing
CONFIRMATIONS_REQUIRED=12
BLOCK_RANGE_PER_BATCH=5000
MAX_RETRY_ATTEMPTS=3
POLLING_INTERVAL_MS=12000

# Database
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_NAME=truthbounty

# Contracts
INDEXED_CONTRACTS='[{"address": "0x...", "events": [...]}]'
```

### 5. **API Endpoints**

#### GET /indexer/status
Returns current indexing status:
```json
{
  "success": true,
  "data": {
    "isRunning": true,
    "currentBlockNumber": 123456789,
    "indexingStates": [
      {
        "contractAddress": "0x...",
        "eventType": "Staked",
        "lastProcessedBlock": 123456000,
        "status": "idle",
        "totalEvents": 1250,
        "processedEvents": 1250,
        "failedEvents": 0
      }
    ]
  }
}
```

#### POST /indexer/restart
Restarts the indexing service.

#### POST /indexer/backfill
Backfill from a specific block:
```json
{
  "contractAddress": "0x...",
  "blockNumber": 10000000
}
```

### 6. **Testing**

#### Unit Tests (`src/indexer/event-indexer.service.spec.ts`)
- Service initialization
- Status retrieval
- Backfill validation

#### E2E Tests (`test/indexer.e2e-spec.ts`)
- API endpoint testing
- Status verification
- Backfill request handling

Run with:
```bash
npm test
npm run test:e2e
```

## Architecture Flow

```
┌─────────────────────────────────────────┐
│    Event Indexing Service               │
│  (EventIndexerService)                  │
└────────┬────────────────────────────────┘
         │
         ├─→ Polling Loop (every 12s)
         │   └─→ Get current block number
         │   └─→ For each contract:
         │       └─→ Fetch logs (eth_getLogs)
         │       └─→ Decode events
         │       └─→ Check idempotency
         │       └─→ Store in DB
         │       └─→ Update state
         │
         ├─→ Reorg Reconciliation
         │   └─→ Check confirmations
         │   └─→ Mark finalized
         │   └─→ Revert if unconfirmed
         │
         └─→ Retry Loop
             └─→ Retry failed events
             └─→ Track attempts

         ↓ (Storage)

    PostgreSQL Database
    ├─ indexed_events (idempotent)
    └─ indexing_state (progress tracking)

         ↓ (API)

    REST Endpoints
    ├─ GET /indexer/status
    ├─ POST /indexer/restart
    └─ POST /indexer/backfill
```

## Implementation Details

### Event Processing Pipeline

```typescript
1. eth_getLogs(contractAddress, topics, fromBlock, toBlock)
   ↓
2. Check if event exists (idempotency)
   ↓
3. Parse event using ethers.Interface
   ↓
4. Calculate confirmations = currentBlock - eventBlock
   ↓
5. Determine finalization = confirmations >= threshold
   ↓
6. Insert into indexed_events (fails if duplicate)
   ↓
7. Update indexing_state.lastProcessedBlockNumber
```

### Reorg Handling

```typescript
// Forward: New events added
for each new event {
  if confirmations >= THRESHOLD {
    mark as finalized
  }
}

// Backward: Reorg recovery
for each finalized event {
  if confirmations < THRESHOLD {
    unfinalize and unprocess
    allow re-processing
  }
}
```

### Idempotency Guarantee

```sql
-- Unique constraint prevents duplicates
UNIQUE (transaction_hash, log_index, event_type)

-- Code also checks before insert
SELECT * FROM indexed_events 
WHERE transaction_hash = ? 
  AND log_index = ? 
  AND event_type = ?
LIMIT 1;
```

## Files Created/Modified

### Created Files
- `src/entities/indexed-event.entity.ts` - Event storage entity
- `src/entities/indexing-state.entity.ts` - State tracking entity
- `src/entities/index.ts` - Entity exports
- `src/config/event-indexer.config.ts` - Configuration types
- `src/config/indexer-config.service.ts` - Configuration provider
- `src/config/index.ts` - Config exports
- `src/indexer/event-indexer.service.ts` - Core indexing service
- `src/indexer/indexer.module.ts` - NestJS module
- `src/indexer/indexer.controller.ts` - REST API
- `src/indexer/index.ts` - Indexer exports
- `src/indexer/event-indexer.service.spec.ts` - Unit tests
- `test/indexer.e2e-spec.ts` - E2E tests
- `.env.example` - Configuration template
- `EVENT_INDEXER.md` - Implementation documentation

### Modified Files
- `src/app.module.ts` - Integrated TypeORM and IndexerModule
- `package.json` - Added dependencies (ethers, typeorm, pg, etc.)

## Dependencies Added

```json
{
  "@nestjs/config": "^3.1.1",
  "@nestjs/typeorm": "^11.0.0",
  "ethers": "^6.10.0",
  "pg": "^8.11.3",
  "typeorm": "^0.3.19"
}
```

## Next Steps for Integration

1. **Setup Database**
   ```bash
   createdb truthbounty
   npm run start:dev  # Auto-creates tables via synchronize
   ```

2. **Configure Contracts**
   - Add contract addresses and event ABIs to `INDEXED_CONTRACTS`
   - Set `startBlock` for each contract

3. **Start Indexing**
   ```bash
   npm run start:dev
   ```

4. **Monitor Progress**
   ```bash
   curl http://localhost:3000/indexer/status
   ```

5. **Downstream Integration**
   - Reward syncing can subscribe to `IndexedEvent` entities
   - Stake syncing can query `indexed_events` table
   - Use `isProcessed` flag for downstream workflow

## Production Readiness

✅ **Implemented**:
- Idempotency safeguards
- Reorg detection and recovery
- Restart safety
- Error tracking and retry logic
- Configurable thresholds
- REST management API
- Database schema with proper indexing
- Comprehensive error handling
- Type-safe configuration
- Unit and E2E tests

⚠️ **Considerations**:
- Update `INDEXED_CONTRACTS` with actual contract addresses
- Configure PostgreSQL credentials
- Set appropriate `CONFIRMATIONS_REQUIRED` (12 is standard)
- Monitor `/indexer/status` endpoint
- Keep database backups

## Summary

This implementation provides a **production-grade foundation** for on-chain data indexing. It handles:

- ✅ Event subscription and polling
- ✅ Persistent, idempotent storage
- ✅ Reorg safety with confirmation thresholds
- ✅ Restart-safe progress tracking
- ✅ Error recovery and retry logic
- ✅ REST management API

The service is ready for integration with reward and stake syncing modules.
