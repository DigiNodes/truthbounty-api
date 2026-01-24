# Event Indexing Service Implementation

## Overview

The Event Indexing Service is a robust, production-ready system for monitoring and indexing smart contract events from the Optimism blockchain. It provides:

- **Event Subscription**: Polls Optimism RPC for contract events
- **Persistent Storage**: Stores events in PostgreSQL with full traceability
- **Reorg Safety**: Handles blockchain reorganizations gracefully
- **Idempotency**: Prevents duplicate event processing via unique constraints
- **Restart Safety**: Can resume indexing from any block without data loss

## Architecture

### Components

1. **EventIndexerService** (`src/indexer/event-indexer.service.ts`)
   - Core indexing logic
   - Event fetching and processing
   - Reorg detection and reconciliation
   - Retry management

2. **Database Entities**
   - `IndexedEvent`: Stores individual smart contract events
   - `IndexingState`: Tracks progress per contract/event type

3. **Configuration**
   - Environment-based configuration via `.env`
   - Supports multiple contracts and event types
   - Flexible block range and confirmation thresholds

4. **REST API** (`src/indexer/indexer.controller.ts`)
   - `/indexer/status` - Get current indexing status
   - `/indexer/restart` - Restart the indexer
   - `/indexer/backfill` - Backfill from a specific block

## Key Features

### 1. Idempotency & Duplicate Prevention

Events are stored with a unique constraint on `(transactionHash, logIndex, eventType)`. This ensures:

```typescript
// Unique constraint prevents duplicate inserts
@Index(['transactionHash', 'logIndex', 'eventType'], { unique: true })
```

Before storing an event, the service checks if it already exists:

```typescript
const existingEvent = await this.eventRepository.findOne({
  where: {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    eventType: eventConfig.name,
  },
});

if (existingEvent) {
  // Skip processing - event already indexed
  return;
}
```

### 2. Reorg Safety

The service protects against chain reorganizations through:

**Confirmation Threshold**:
```typescript
const confirmations = currentBlockNumber - event.blockNumber;
const isFinalized = confirmations >= this.config.confirmationsRequired;
```

**Reconciliation Loop**:
```typescript
// Mark events as unfinalized if they fall below confirmation threshold
if (confirmations < this.config.confirmationsRequired) {
  event.isFinalized = false;
  event.isProcessed = false;
  // Event can be re-processed
}
```

### 3. Restart-Safe Indexing

`IndexingState` tracks progress per contract/event:

```typescript
{
  contractAddress: "0x...",
  eventType: "StakeMinted",
  lastProcessedBlockNumber: 12345,  // Resume from here
  status: "idle" | "indexing" | "backfilling" | "error"
}
```

On restart, the service resumes from `lastProcessedBlockNumber + 1`.

### 4. Event Processing Pipeline

```
1. Fetch Events
   └─> eth_getLogs(address, topics, fromBlock, toBlock)

2. Check Idempotency
   └─> Query existing event by (txHash, logIndex)

3. Decode Event
   └─> Ethers.js Interface.parseLog()

4. Calculate Confirmations
   └─> currentBlock - eventBlock

5. Store Event
   └─> Insert into indexed_events table

6. Update State
   └─> Update last_processed_block_number
```

## Setup & Configuration

### 1. Install Dependencies

```bash
npm install
```

Dependencies added:
- `ethers` - Blockchain interaction
- `typeorm` - ORM for PostgreSQL
- `pg` - PostgreSQL driver
- `@nestjs/typeorm` - NestJS TypeORM integration
- `@nestjs/config` - Environment configuration

### 2. Configure Environment

Create `.env.local` or `.env`:

```env
# RPC Configuration
OPTIMISM_RPC_URL=https://mainnet.optimism.io
CHAIN_ID=10

# Indexing Parameters
CONFIRMATIONS_REQUIRED=12       # Blocks before finalization
BLOCK_RANGE_PER_BATCH=5000      # Events per fetch
MAX_RETRY_ATTEMPTS=3            # Retries for failed events
POLLING_INTERVAL_MS=12000       # Check interval (12 seconds)

# Database (PostgreSQL)
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_NAME=truthbounty
DATABASE_SYNCHRONIZE=false
DATABASE_LOGGING=false

# Indexed Contracts
INDEXED_CONTRACTS='[
  {
    "address": "0x...",
    "name": "StakingContract",
    "startBlock": 10000000,
    "events": [
      {
        "name": "Staked",
        "signature": "0x...",
        "abi": {...}
      }
    ]
  }
]'
```

### 3. Setup PostgreSQL Database

```bash
# Create database
createdb truthbounty

# Run migrations (auto via synchronize: true in dev)
# Or manually create tables from entity definitions
```

### 4. Start the Service

```bash
# Development with hot reload
npm run start:dev

# Production
npm run build
npm run start:prod
```

## API Endpoints

### Get Indexer Status

```bash
GET /indexer/status
```

Response:
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

### Restart Indexer

```bash
POST /indexer/restart
```

Response:
```json
{
  "success": true,
  "message": "Indexer restarted successfully"
}
```

### Backfill from Block

```bash
POST /indexer/backfill
Content-Type: application/json

{
  "contractAddress": "0x...",
  "blockNumber": 10000000
}
```

## Database Schema

### indexed_events

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| eventType | VARCHAR | Event name (e.g., 'Staked') |
| contractAddress | VARCHAR | Contract address |
| transactionHash | VARCHAR | Tx hash (unique with logIndex) |
| blockNumber | BIGINT | Block number |
| logIndex | INTEGER | Log index in transaction |
| chainId | INTEGER | Chain ID (10 for Optimism) |
| eventData | JSONB | Raw log data |
| parsedData | JSONB | Decoded event parameters |
| confirmations | INTEGER | Block confirmations |
| isFinalized | BOOLEAN | Passed reorg threshold |
| isProcessed | BOOLEAN | Synced to downstream systems |
| processedAt | TIMESTAMP | When processed |
| processingError | TEXT | Error message if failed |
| retryAttempts | INTEGER | Retry count |
| createdAt | TIMESTAMP | Record created |
| updatedAt | TIMESTAMP | Record updated |

### indexing_state

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| chainId | INTEGER | Chain ID |
| contractAddress | VARCHAR | Contract address |
| eventType | VARCHAR | Event type |
| lastProcessedBlockNumber | BIGINT | Last indexed block |
| lastScannedBlockNumber | BIGINT | Scanned up to block |
| lastFinalizedBlockNumber | BIGINT | Finalized up to block |
| status | VARCHAR | idle/indexing/backfilling/error |
| errorMessage | TEXT | Error details |
| totalEventCount | BIGINT | Total events found |
| processedEventCount | BIGINT | Events processed |
| failedEventCount | INTEGER | Failed events |
| blockRangePerBatch | INTEGER | Batch size |
| confirmationsRequired | INTEGER | Reorg safety |
| maxRetryAttempts | INTEGER | Retry limit |
| lastIndexedAt | TIMESTAMP | Last index time |
| lastSyncedAt | TIMESTAMP | Last sync time |
| createdAt | TIMESTAMP | Created |
| updatedAt | TIMESTAMP | Updated |

## Safety Features

### 1. Unique Constraints

- `indexed_events`: `(blockNumber, logIndex)`
- `indexed_events`: `(transactionHash, logIndex, eventType)`
- `indexing_state`: `(chainId, contractAddress, eventType)`

These prevent:
- Duplicate event storage
- State conflicts
- Race conditions

### 2. Error Recovery

Failed events are tracked with:
- `processingError` - Error message
- `retryAttempts` - Retry count
- Automatic retry up to `maxRetryAttempts`

### 3. Reorg Handling

```typescript
// If block falls below confirmation threshold:
if (confirmations < this.config.confirmationsRequired) {
  // Mark as unfinalized
  event.isFinalized = false;
  // Reset processing state
  event.isProcessed = false;
  // Allow re-processing
}
```

## Performance Considerations

### Block Range Tuning

```env
# Smaller batch = more RPC calls but better error recovery
BLOCK_RANGE_PER_BATCH=1000   # Smaller

# Larger batch = fewer RPC calls but bigger failures
BLOCK_RANGE_PER_BATCH=10000  # Larger
```

### Polling Interval

```env
# Faster polling = lower latency but more RPC calls
POLLING_INTERVAL_MS=6000     # Faster

# Slower polling = higher latency but fewer calls
POLLING_INTERVAL_MS=30000    # Slower
```

### Confirmation Threshold

```env
# Lower = faster finalization but higher reorg risk
CONFIRMATIONS_REQUIRED=6     # Faster

# Higher = safer but slower finalization
CONFIRMATIONS_REQUIRED=20    # Safer
```

## Testing

### Unit Tests

```bash
npm run test
npm run test:cov
```

### E2E Tests

```bash
npm run test:e2e
```

## Monitoring & Logging

The service logs key events:

```
[EventIndexerService] Starting event indexer...
[EventIndexerService] Initialized state for 0x...
[EventIndexerService] Indexed 5 Staked events from blocks 1000000-1005000
[EventIndexerService] Potential reorg detected for event 0x...
[EventIndexerService] 3 events failed after max retries
```

Check `/indexer/status` endpoint for detailed status.

## Troubleshooting

### Events not being indexed

1. Check RPC URL is valid: `curl $OPTIMISM_RPC_URL`
2. Verify contract addresses in `INDEXED_CONTRACTS`
3. Check database connectivity: `psql $DATABASE_URL`
4. Review logs for errors

### Reorg loop detected

If events keep failing reorg detection:

1. Increase `CONFIRMATIONS_REQUIRED`
2. Check network stability
3. Review `indexing_state.errorMessage`

### Database connection issues

```bash
# Test connection
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME
```

### High memory usage

Reduce `BLOCK_RANGE_PER_BATCH` to process smaller chunks.

## Future Enhancements

- [ ] Event filtering by indexed parameters
- [ ] GraphQL API for event queries
- [ ] Webhook notifications on new events
- [ ] Multi-chain support
- [ ] Event aggregation and indexing
- [ ] Real-time WebSocket updates
