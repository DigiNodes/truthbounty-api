# Event Indexer Architecture

## High-Level System Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                        TRUTHBOUNTY API                             │
│                      (NestJS Application)                          │
└────────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
        ┌───────────▼─────────┐  ┌──────────▼──────────┐
        │  Existing API       │  │ Event Indexer      │
        │  (App Controller)   │  │ (NEW COMPONENT)    │
        └─────────────────────┘  └──────────┬─────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
                    ▼                       ▼                       ▼
        ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
        │ Config Module    │   │ Indexer Service  │   │ Indexer Module   │
        │                  │   │ (Core Logic)     │   │ (Lifecycle Mgmt) │
        │ • RPC URL        │   │                  │   │                  │
        │ • Contracts      │   │ • Event Polling  │   │ • onModuleInit   │
        │ • DB Params      │   │ • RPC Queries    │   │ • onModuleDestroy│
        │ • Thresholds     │   │ • Decoding       │   │                  │
        └──────────────────┘   │ • Deduplication  │   └──────────────────┘
                               │ • Reorg Safety   │
                               │ • Retry Logic    │
                               └──────────┬───────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
                    ▼                    ▼                    ▼
        ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
        │ Indexer REST API │  │  Optimism RPC    │  │ PostgreSQL DB    │
        │ (Controller)     │  │                  │  │                  │
        │                  │  │ • eth_blockNumber│  │ ┌────────────────┐│
        │ • GET /status    │  │ • eth_getLogs    │  │ │ indexed_events ││
        │ • POST /restart  │  │ • eth_getBlock   │  │ │ (event data)   ││
        │ • POST /backfill │  │                  │  │ └────────────────┘│
        └──────────────────┘  └──────────────────┘  │ ┌────────────────┐│
                                                     │ │ indexing_state ││
                                                     │ │ (progress)     ││
                                                     │ └────────────────┘│
                                                     └──────────────────┘
```

## Component Interaction Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    POLLING LOOP (Every 12s)                      │
│                  [EventIndexerService]                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Get Current Block Number                                    │
│     └─→ await provider.getBlockNumber()                         │
│         ↓                                                        │
│  2. For Each Configured Contract                                │
│     └─→ Get lastProcessedBlockNumber from DB                    │
│         ↓                                                        │
│  3. Fetch Events from RPC                                       │
│     └─→ eth_getLogs(address, topics, fromBlock, toBlock)        │
│         ↓                                                        │
│  4. Process Each Event                                          │
│     └─→ Check if already indexed (idempotency)                  │
│     └─→ Decode event using ethers.Interface                     │
│     └─→ Calculate confirmations                                 │
│     └─→ Determine finalization status                           │
│     └─→ Store in indexed_events table                           │
│         ↓                                                        │
│  5. Update Indexing State                                       │
│     └─→ Set lastProcessedBlockNumber                            │
│     └─→ Mark status as 'idle'                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Reorg Detection & Recovery Flow

```
┌──────────────────────────────────────────────────────────────────┐
│              RECONCILIATION LOOP (During Polling)                │
│            [EventIndexerService.reconcileReorgs]                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  For Each Finalized Event in Database:                          │
│                                                                  │
│  confirmations = currentBlockNumber - eventBlockNumber          │
│                                                                  │
│  IF confirmations >= THRESHOLD (e.g., 12)                       │
│     └─→ Keep as finalized ✓                                     │
│                                                                  │
│  ELSE IF confirmations < THRESHOLD                              │
│     └─→ Mark as unfinalized                                     │
│     └─→ Reset isProcessed = false                               │
│     └─→ Clear processingError                                   │
│     └─→ Allow re-processing ◄─ REORG RECOVERY                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Idempotency & Deduplication

```
┌──────────────────────────────────────────────────────────────────┐
│              Event Deduplication Strategy                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Level 1: Application Check                                     │
│  ┌────────────────────────────────────────────────────┐         │
│  │ SELECT * FROM indexed_events                       │         │
│  │ WHERE transaction_hash = ?                         │         │
│  │   AND log_index = ?                                │         │
│  │   AND event_type = ?                               │         │
│  │ LIMIT 1;                                           │         │
│  │                                                    │         │
│  │ IF found: SKIP (already indexed)                   │         │
│  │ ELSE: proceed to Level 2                           │         │
│  └────────────────────────────────────────────────────┘         │
│                         ↓                                        │
│  Level 2: Database Constraint                                   │
│  ┌────────────────────────────────────────────────────┐         │
│  │ UNIQUE (transaction_hash, log_index, event_type)   │         │
│  │                                                    │         │
│  │ Prevents any duplicate inserts at DB level        │         │
│  └────────────────────────────────────────────────────┘         │
│                                                                  │
│  Result: Guaranteed single processing even with:                │
│  • Duplicate RPC responses                                      │
│  • Service restarts                                             │
│  • Multiple indexer instances                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## State Machine: Event Lifecycle

```
                    ┌─────────────────────┐
                    │   RPC Event Fetched │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Check Idempotency  │
                    │  (Already indexed?) │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┴────────────┐
                 │                          │
            YES  │                          │  NO
                 ▼                          ▼
        ┌──────────────┐         ┌──────────────────┐
        │   SKIP       │         │   Decode Event   │
        │   (return)   │         │   (Parse logs)   │
        └──────────────┘         └────────┬─────────┘
                                         │
                                 ┌───────▼────────┐
                                 │ Store in DB    │
                                 │ indexed_events │
                                 └───────┬────────┘
                                         │
                        ┌────────────────▼────────────────┐
                        │ Check Confirmations             │
                        │ threshold_met = (conf >= 12)?   │
                        └────────────┬────────────────────┘
                                     │
                        ┌────────────┴────────────┐
                        │                         │
                    YES │                         │ NO
                        ▼                         ▼
            ┌────────────────────┐   ┌──────────────────────┐
            │  isFinalized=true  │   │  isFinalized=false   │
            │  Ready for syncing │   │  Await more blocks   │
            └────────────────────┘   └──────────────────────┘
                        │                         │
                        └────────────┬────────────┘
                                     │
            ┌────────────────────────▼────────────────────┐
            │ Check Reorg Risk (Next Reconciliation Loop) │
            │ if conf < 12: mark unfinalized, reprocess   │
            └─────────────────────────────────────────────┘
```

## Database Schema Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                  IndexingState Table                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ id (UUID)                                               │   │
│  │ chainId + contractAddress + eventType (UNIQUE)          │   │
│  │ lastProcessedBlockNumber ◄── Resume point              │   │
│  │ status (idle/indexing/backfilling/error)                │   │
│  │ totalEventCount, processedEventCount, failedEventCount │   │
│  └──────────────────────┬────────────────────────────────┘   │
│                         │ (1:N)                               │
│                         │                                     │
│  ┌──────────────────────▼────────────────────────────────┐   │
│  │              IndexedEvent Table                       │   │
│  │  ┌──────────────────────────────────────────────────┐ │   │
│  │  │ id (UUID)                                        │ │   │
│  │  │ eventType (foreign key to IndexingState)        │ │   │
│  │  │ transactionHash + logIndex + eventType (UNIQUE) │ │   │
│  │  │ blockNumber + logIndex (UNIQUE)                 │ │   │
│  │  │ contractAddress                                 │ │   │
│  │  │ eventData (JSONB - raw RPC response)            │ │   │
│  │  │ parsedData (JSONB - decoded parameters)         │ │   │
│  │  │ confirmations                                   │ │   │
│  │  │ isFinalized (reorg safety)                      │ │   │
│  │  │ isProcessed (downstream syncing)                │ │   │
│  │  │ processingError (error tracking)                │ │   │
│  │  │ retryAttempts (retry count)                     │ │   │
│  │  │ createdAt, updatedAt (timestamps)               │ │   │
│  │  └──────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Indexes:                                                    │
│  • (blockNumber, logIndex) - UNIQUE                          │
│  • (transactionHash, logIndex, eventType) - UNIQUE           │
│  • (eventType, blockNumber) - for filtered queries           │
│  • (processedAt) - for time-based queries                    │
│  • (isProcessed) - for finding unprocessed events            │
│                                                              │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow: From Blockchain to Application

```
┌─────────────────────┐
│  Optimism Chain     │
│  Contract Event     │
│  emitted()          │
└──────────┬──────────┘
           │
           ▼
┌──────────────────────────────┐
│ Optimism RPC Node            │
│ (eth_getLogs API)            │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ EventIndexerService          │
│ • Fetch logs                 │
│ • Parse/decode               │
│ • Check idempotency          │
│ • Calculate confirmations    │
│ • Handle errors/reorgs       │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ PostgreSQL indexed_events    │
│ • Raw event data             │
│ • Parsed parameters          │
│ • Finalization status        │
│ • Processing state           │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ Downstream Modules (Future)  │
│ • Reward Syncing             │
│ • Stake Syncing              │
│ • GraphQL API                │
│ • WebSocket Updates          │
└──────────────────────────────┘
```

## Deployment Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       Production Setup                         │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────┐         ┌──────────────────┐            │
│  │  Optimism RPC    │         │  PostgreSQL      │            │
│  │  (Alchemy/       │◄────────│  (AWS RDS/       │            │
│  │   Infura/Node)   │         │   Docker/        │            │
│  │                  │         │   Self-hosted)   │            │
│  └──────────────────┘         └──────────────────┘            │
│        ▲                              ▲                        │
│        │                              │                        │
│        └──────────────────┬───────────┘                        │
│                           │                                    │
│                    ┌──────▼──────┐                             │
│                    │ NestJS App  │                             │
│                    │ • Indexer   │                             │
│                    │ • REST API  │                             │
│                    └──────┬──────┘                             │
│                           │                                    │
│                 ┌─────────┴─────────┐                          │
│                 │                   │                          │
│           ┌─────▼────┐       ┌─────▼────┐                    │
│           │ Docker   │       │ Load     │                    │
│           │ Container│       │ Balancer │                    │
│           └──────────┘       └──────────┘                    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Configuration Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│            Configuration Loading Order                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Environment Variables (highest priority)               │
│     └─ OPTIMISM_RPC_URL                                    │
│     └─ DATABASE_HOST                                       │
│     └─ INDEXED_CONTRACTS                                   │
│                                                             │
│  2. .env.local (if exists)                                 │
│     └─ Local overrides                                     │
│                                                             │
│  3. .env (default)                                         │
│     └─ Project defaults                                    │
│                                                             │
│  4. Hardcoded Defaults in Code (lowest priority)          │
│     └─ If env var not found                               │
│     └─ Uses sensible defaults                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```
