# Event Indexer Quick Start Guide

## 5-Minute Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Setup PostgreSQL Database
```bash
# Create database
createdb truthbounty

# Verify connection
psql -h localhost -U postgres -d truthbounty -c "\dt"
```

### 3. Configure Environment
Copy and edit `.env.local`:
```bash
cp .env.example .env.local
```

Edit `.env.local`:
```env
# Use defaults or customize:
OPTIMISM_RPC_URL=https://mainnet.optimism.io
CHAIN_ID=10
DATABASE_HOST=localhost
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_NAME=truthbounty
DATABASE_SYNCHRONIZE=true  # Auto-create tables
```

### 4. Add Contracts to Index
Update `INDEXED_CONTRACTS` in `.env.local`:

```env
INDEXED_CONTRACTS='[
  {
    "address": "0x1234567890abcdef...",
    "name": "StakingContract",
    "startBlock": 100000000,
    "events": [
      {
        "name": "Staked",
        "signature": "0x1234...",
        "abi": {
          "type": "event",
          "name": "Staked",
          "inputs": [
            {"name": "user", "type": "address", "indexed": true},
            {"name": "amount", "type": "uint256"}
          ]
        }
      }
    ]
  }
]'
```

### 5. Start the Service
```bash
npm run start:dev
```

Output should show:
```
[NestFactory] Starting Nest application...
[InstanceLoader] EventIndexerService instantiated
[EventIndexerService] Starting event indexer...
[EventIndexerService] Initialized state for 0x... from block 100000000
```

### 6. Check Status
```bash
# In another terminal
curl http://localhost:3000/indexer/status
```

Response:
```json
{
  "success": true,
  "data": {
    "isRunning": true,
    "currentBlockNumber": 125789456,
    "indexingStates": [
      {
        "contractAddress": "0x...",
        "eventType": "Staked",
        "lastProcessedBlock": 100000000,
        "status": "idle",
        "totalEvents": 0,
        "processedEvents": 0,
        "failedEvents": 0
      }
    ]
  }
}
```

## Common Operations

### Restart Indexing
```bash
curl -X POST http://localhost:3000/indexer/restart
```

### Backfill from Specific Block
```bash
curl -X POST http://localhost:3000/indexer/backfill \
  -H "Content-Type: application/json" \
  -d '{
    "contractAddress": "0x...",
    "blockNumber": 110000000
  }'
```

### Query Indexed Events
```sql
-- Connect to database
psql -h localhost -U postgres -d truthbounty

-- View recent events
SELECT event_type, block_number, log_index, is_finalized, parsed_data
FROM indexed_events
ORDER BY created_at DESC
LIMIT 10;

-- View indexing state
SELECT contract_address, event_type, last_processed_block_number, status
FROM indexing_state;

-- Find failed events
SELECT event_type, processing_error, retry_attempts
FROM indexed_events
WHERE is_processed = false;
```

## Troubleshooting

### RPC Connection Failed
```bash
# Test RPC endpoint
curl -s https://mainnet.optimism.io -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq
```

### Database Connection Failed
```bash
# Check PostgreSQL is running
psql -h localhost -U postgres -c "SELECT version();"

# Check database exists
psql -h localhost -U postgres -lqt | grep truthbounty
```

### Events Not Indexing
1. Check contract address is correct
2. Verify event signature matches contract ABI
3. Ensure `startBlock` is before first event
4. Check `/indexer/status` for errors

### Memory/Performance Issues
Reduce batch size:
```env
BLOCK_RANGE_PER_BATCH=1000  # Instead of 5000
```

## File Structure

```
truthbounty-api/
├── src/
│   ├── entities/
│   │   ├── indexed-event.entity.ts      ✅ Events storage
│   │   ├── indexing-state.entity.ts     ✅ Progress tracking
│   │   └── index.ts
│   ├── config/
│   │   ├── event-indexer.config.ts      ✅ Type definitions
│   │   ├── indexer-config.service.ts    ✅ Config loading
│   │   └── index.ts
│   ├── indexer/
│   │   ├── event-indexer.service.ts     ✅ Core logic
│   │   ├── indexer.module.ts            ✅ Module
│   │   ├── indexer.controller.ts        ✅ REST API
│   │   ├── event-indexer.service.spec.ts ✅ Tests
│   │   └── index.ts
│   ├── app.module.ts                     ✅ Updated
│   └── main.ts
├── test/
│   └── indexer.e2e-spec.ts              ✅ E2E tests
├── .env.example                          ✅ Config template
├── EVENT_INDEXER.md                      ✅ Full docs
├── IMPLEMENTATION_SUMMARY.md             ✅ Summary
└── package.json                          ✅ Updated
```

## Key Concepts

### Idempotency
Events stored with unique constraint on `(txHash, logIndex, eventType)`.
Prevents duplicates even if indexed multiple times.

### Reorg Safety
Events marked as "finalized" after 12+ confirmations (configurable).
Automatically recovers if chain reorgs.

### Progress Tracking
`lastProcessedBlockNumber` allows resuming from any point.
Backfill with `/indexer/backfill` endpoint.

### Status Monitoring
`/indexer/status` shows:
- Current block number
- Per-contract progress
- Event counts
- Error states

## Testing

```bash
# Unit tests
npm test

# E2E tests (requires running service)
npm run test:e2e

# With coverage
npm run test:cov
```

## Next Steps

1. ✅ Service indexing events
2. 📝 Build reward syncing module
3. 📝 Build stake syncing module
4. 📝 Add GraphQL API for queries
5. 📝 Add WebSocket updates

## Documentation

- **Full Documentation**: See [EVENT_INDEXER.md](EVENT_INDEXER.md)
- **Implementation Details**: See [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)
- **API Reference**: See [EVENT_INDEXER.md#api-endpoints](EVENT_INDEXER.md#api-endpoints)
