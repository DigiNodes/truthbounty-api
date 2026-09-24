# Event Indexer Architecture

## High-Level System Diagram
test in webdev
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

---

## Transactional Outbox Pattern & Idempotent Delivery Architecture (V2-BE-048 & V2-BE-076)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TRANSACTIONAL OUTBOX FLOW                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ 1. Domain Action (Prisma Transaction)                                       │
│    └─→ Write Projection Data                                                │
│    └─→ Write OutboxEvent (status = 'PENDING', idempotencyKey = sha256(...)) │
│        ↓ (Atomic Commit)                                                    │
│ 2. OutboxScheduler (Cron Poller every 5s)                                   │
│    └─→ Claims PENDING OutboxEvents                                          │
│    └─→ Relays job to BullMQ 'notifications' queue                           │
│    └─→ Updates OutboxEvent status to 'DISPATCHED'                           │
│        ↓                                                                    │
│ 3. NotificationProcessor (Worker)                                           │
│    └─→ Step 3a: Redis SETNX Guard (key = idempotency:notification:${key})   │
│        • Lock acquired  → proceed to delivery                               │
│        • Lock exists    → suppress duplicate execution                      │
│    └─→ Step 3b: DB Fallback Guard (DeliveryHistory.findByIdempotencyKey)    │
│        • Status DELIVERED → suppress duplicate                              │
│    └─→ Step 3c: Deliver via Channel (WebSocket / Email / Webhook / InApp)   │
│    └─→ Update DeliveryHistory status                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Security & Protocol Constraints
- **Zero PII & Settlement Data**: `OutboxEvent.payload` contains opaque routing identifiers only (`notificationId`, `channel`, `recipientIds`). No claim body, settlement calculations, private keys, or credentials are path-logged or queued.
- **Protocol Boundary**: API layer indexes, validates, and relays user-signed intent; it is never authoritative for settlement, rewards, or governance.
- **EVM Semantics**: Full compatibility with Optimism/EVM chain rules.

---

## Projection Readiness Gate (V2-BE-100)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     PROJECTION READINESS GATE                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Canonical Optimism/EVM events (v2_canonical_events)  ◄── protocol authority │
│         │                                                                    │
│         ▼                                                                    │
│  Projectors (v2-evidence, v2-verification, v2-disputes)                      │
│    read in (blockNumber, logIndex) order; idempotent; cursor in              │
│    v2_projector_cursors                                                     │
│         │                                                                    │
│         ▼                                                                    │
│  ProjectionReadinessService.evaluate(projector)   ← reads only, never writes │
│    I1 total evaluation (any error ⇒ not ready)                                │
│    I2 registered projector only                                              │
│    I3 events ⇒ cursor exists                                                 │
│    I4 cursor neither lags nor leads the canonical stream                     │
│    I5 no undecodable logs from approved protocol contracts                   │
│         │                                                                    │
│         ├── ready     → V2 read endpoints serve the projection               │
│         └── not ready → 503 projection_not_ready (reasons + evidence)         │
│                         and GET /v2/projections/readiness reports why         │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

The gate adds an enforcement layer, not a second source of truth: it derives
every input from existing V2 tables and never mutates protocol-derived state.
Read paths fail closed rather than answering from a projection the API cannot
prove still reproduces canonical events. Design, invariants, failure modes and
recovery: [docs/PROJECTION_READINESS_GATE.md](docs/PROJECTION_READINESS_GATE.md).

