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

## Persistence Boundary: TypeORM-Only for New Code (V2-BE-111)

TypeORM/PostgreSQL is the persistence path for all new backend code. `src/database/transaction.runner.ts` is the shared transaction helper; use it rather than reaching for a raw `DataSource` or a second transaction abstraction.

Prisma (`src/prisma/`, `prisma/schema.prisma`) has pre-existing, real usage in a specific, closed list of modules: `auth`, `notifications`, `outbox` (see above), `sybil-resistance`, `analytics`, `ai-assistant`, and `identity`/`worldcoin`. That usage is grandfathered, not sanctioned for new work: it predates this boundary and migrating it off Prisma is a separate, larger effort, not part of this change.

Two things enforce the boundary going forward:
- `eslint.config.mjs` restricts importing `@prisma/client` or `prisma.service` outside the grandfathered file list; new files hit this at lint time.
- `src/architecture.spec.ts` asserts the same thing at test time, independent of whether lint runs.

Adding a file to either allowlist is a signal that the "TypeORM-only" boundary is being widened, not narrowed, so it should be treated the same as adding a new ORM: reviewed deliberately, not done to silence a lint error.

