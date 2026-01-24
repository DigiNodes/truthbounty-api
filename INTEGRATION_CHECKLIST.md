# Integration Checklist

## Pre-Setup Verification

- [ ] Node.js 18+ installed (`node --version`)
- [ ] PostgreSQL installed and running (`psql --version`)
- [ ] Git initialized (`git status`)
- [ ] Currently on `feat/EventIndexer` branch

## Installation & Configuration

### Step 1: Install Dependencies
- [ ] Run `npm install`
- [ ] Verify all dependencies installed (`npm list`)

### Step 2: Database Setup
- [ ] Create PostgreSQL database: `createdb truthbounty`
- [ ] Verify connection: `psql -h localhost -U postgres -d truthbounty -c "\dt"`
- [ ] (Optional) Create dedicated PostgreSQL user for app

### Step 3: Environment Configuration
- [ ] Copy `.env.example` to `.env.local`
- [ ] Update database credentials:
  - [ ] `DATABASE_HOST`
  - [ ] `DATABASE_PORT`
  - [ ] `DATABASE_USER`
  - [ ] `DATABASE_PASSWORD`
  - [ ] `DATABASE_NAME`
- [ ] Set RPC endpoint:
  - [ ] `OPTIMISM_RPC_URL` (use public RPC or Alchemy/Infura)
  - [ ] `CHAIN_ID=10` (or 11155420 for Sepolia)
- [ ] Verify other config values:
  - [ ] `CONFIRMATIONS_REQUIRED` (default: 12)
  - [ ] `BLOCK_RANGE_PER_BATCH` (default: 5000)
  - [ ] `MAX_RETRY_ATTEMPTS` (default: 3)
  - [ ] `POLLING_INTERVAL_MS` (default: 12000)

### Step 4: Add Contract Configurations
- [ ] Gather contract details:
  - [ ] Contract address (e.g., `0x...`)
  - [ ] Event ABIs
  - [ ] Event signatures (keccak256 hash)
  - [ ] Start block for indexing
- [ ] Format as JSON and add to `INDEXED_CONTRACTS` env var
- [ ] Validate JSON format: `node -e "console.log(JSON.parse(process.env.INDEXED_CONTRACTS))"`

### Step 5: Build & Compile
- [ ] Run `npm run build`
- [ ] Verify TypeScript compilation succeeds
- [ ] Check `dist/` folder created

### Step 6: Test Database Connection
- [ ] Start service: `npm run start:dev`
- [ ] Check console for "Starting event indexer..." message
- [ ] Verify no database connection errors
- [ ] Check TypeORM logs for table creation

### Step 7: Verify API Endpoints
- [ ] Open new terminal
- [ ] Test status endpoint: `curl http://localhost:3000/indexer/status`
- [ ] Verify response contains `isRunning: true`
- [ ] Check indexing states for configured contracts

### Step 8: Monitor Initial Indexing
- [ ] Watch logs for polling messages
- [ ] Verify events are being fetched
- [ ] Check database tables for data:
  ```sql
  SELECT COUNT(*) FROM indexed_events;
  SELECT COUNT(*) FROM indexing_state;
  ```

---

## Integration with Downstream Modules

### For Reward Syncing Module
- [ ] Subscribe to `indexed_events` table
- [ ] Filter by `eventType = 'RewardClaimed'` (or your event)
- [ ] Query by `isFinalized = true` for reorg safety
- [ ] Use `parsedData` for decoded parameters
- [ ] Track `processedAt` for sync state

### For Stake Syncing Module
- [ ] Subscribe to `indexed_events` table
- [ ] Filter by `eventType = 'Staked'` (or your event)
- [ ] Query by `isProcessed = false` for unsynced events
- [ ] Calculate balances from `parsedData`
- [ ] Mark `isProcessed = true` after syncing

### For GraphQL API (Future)
- [ ] Create resolvers for indexed events
- [ ] Add filtering: `eventType`, `contractAddress`, `blockNumber`
- [ ] Add pagination: `first`, `after`, `before`
- [ ] Add sorting: `blockNumber`, `timestamp`
- [ ] Expose via GraphQL schema

### For WebSocket Updates (Future)
- [ ] Subscribe to new finalized events
- [ ] Emit to connected clients
- [ ] Use `RxJS` Observables for stream management
- [ ] Handle reconnection logic

---

## Testing & Validation

### Manual Testing
- [ ] Test `/indexer/status` endpoint
- [ ] Test `/indexer/restart` endpoint
- [ ] Test `/indexer/backfill` endpoint with valid contract
- [ ] Verify events are stored in database
- [ ] Check event deduplication (index same block twice)

### Automated Testing
- [ ] Run unit tests: `npm test`
- [ ] Run E2E tests: `npm run test:e2e`
- [ ] Check coverage: `npm run test:cov`
- [ ] Verify all tests pass

### Database Validation
```sql
-- Check table structure
\d indexed_events
\d indexing_state

-- Verify unique constraints
SELECT constraint_name, constraint_type 
FROM information_schema.table_constraints 
WHERE table_name = 'indexed_events';

-- Check indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'indexed_events';

-- Verify data is being inserted
SELECT COUNT(*) FROM indexed_events;
SELECT event_type, COUNT(*) FROM indexed_events GROUP BY event_type;

-- Check processing status
SELECT event_type, is_finalized, COUNT(*) 
FROM indexed_events 
GROUP BY event_type, is_finalized;
```

### Performance Testing
- [ ] Verify polling interval is reasonable (12s default)
- [ ] Monitor database query performance
- [ ] Check memory usage under load
- [ ] Verify RPC rate limits not exceeded

---

## Documentation Review

- [ ] Read [QUICK_START.md](QUICK_START.md) for quick reference
- [ ] Read [EVENT_INDEXER.md](EVENT_INDEXER.md) for complete details
- [ ] Read [ARCHITECTURE.md](ARCHITECTURE.md) for system design
- [ ] Review [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for technical details
- [ ] Share [DELIVERY_SUMMARY.md](DELIVERY_SUMMARY.md) with team

---

## Production Deployment

### Pre-Production
- [ ] Move to separate PostgreSQL instance (RDS/Cloud)
- [ ] Update production RPC endpoint
- [ ] Configure environment secrets (not in `.env`)
- [ ] Set `DATABASE_SYNCHRONIZE=false` (use migrations)
- [ ] Increase `CONFIRMATIONS_REQUIRED` for safety
- [ ] Reduce `POLLING_INTERVAL_MS` for faster updates

### Deployment
- [ ] Build Docker image (if containerized)
- [ ] Deploy to production environment
- [ ] Configure health checks
- [ ] Set up monitoring/alerting
- [ ] Configure log aggregation

### Post-Deployment
- [ ] Monitor `/indexer/status` endpoint
- [ ] Check database growth over time
- [ ] Verify event counts match blockchain
- [ ] Test failover/recovery
- [ ] Collect performance metrics

---

## Troubleshooting Checklist

### If service won't start:
- [ ] Check Node.js version: `node --version`
- [ ] Check npm cache: `npm cache clean --force`
- [ ] Remove `node_modules` and reinstall: `rm -rf node_modules && npm install`
- [ ] Check `dist` folder exists after build
- [ ] Verify TypeScript compilation: `npm run build`

### If database connection fails:
- [ ] Verify PostgreSQL is running
- [ ] Check database exists: `psql -h localhost -U postgres -lqt`
- [ ] Verify credentials in `.env.local`
- [ ] Test raw connection: `psql -h localhost -U postgres -d truthbounty`
- [ ] Check firewall rules if remote database

### If events not indexing:
- [ ] Verify contract address format (0x + 40 hex chars)
- [ ] Check contract address is on correct chain
- [ ] Verify event signature is correct
- [ ] Check `startBlock` is before first event
- [ ] Test RPC endpoint directly with `eth_getLogs`
- [ ] Review `/indexer/status` for error messages

### If events not finalizing:
- [ ] Check current block number vs event block
- [ ] Verify `CONFIRMATIONS_REQUIRED` setting
- [ ] Check for active chain reorganization
- [ ] Monitor blockchain network status

### If high memory usage:
- [ ] Reduce `BLOCK_RANGE_PER_BATCH`
- [ ] Increase `POLLING_INTERVAL_MS`
- [ ] Check for memory leaks: `node --inspect`
- [ ] Monitor long-running queries in database

---

## Rollback Plan

If issues occur during deployment:

1. [ ] Stop the indexing service
2. [ ] Backup database: `pg_dump truthbounty > backup.sql`
3. [ ] Check git status: `git status`
4. [ ] Review recent commits: `git log --oneline -5`
5. [ ] If critical: `git revert <commit-hash>`
6. [ ] Restore database if needed: `psql truthbounty < backup.sql`
7. [ ] Restart service with previous version

---

## Monitoring & Maintenance

### Daily
- [ ] Check `/indexer/status` endpoint
- [ ] Review error logs
- [ ] Verify event counts growing

### Weekly
- [ ] Check database size: `SELECT pg_database.datname, pg_size_pretty(pg_database_size(pg_database.datname)) FROM pg_database;`
- [ ] Review slow queries
- [ ] Check RPC provider health

### Monthly
- [ ] Analyze disk usage
- [ ] Optimize database indexes
- [ ] Archive old events if needed
- [ ] Review and update documentation

---

## Signoff Checklist

- [ ] All dependencies installed
- [ ] Database configured and tested
- [ ] Environment variables set
- [ ] Service starts successfully
- [ ] API endpoints responding
- [ ] Events being indexed
- [ ] Database constraints verified
- [ ] Tests passing
- [ ] Documentation reviewed
- [ ] Team notified

---

## Next Steps After Integration

1. **Reward Syncing Module**
   - [ ] Create new module in `src/reward-syncing/`
   - [ ] Subscribe to `indexed_events` with `eventType = 'RewardClaimed'`
   - [ ] Implement reward distribution logic
   - [ ] Add tests and documentation

2. **Stake Syncing Module**
   - [ ] Create new module in `src/stake-syncing/`
   - [ ] Subscribe to `indexed_events` with `eventType = 'Staked'`
   - [ ] Calculate and track stake balances
   - [ ] Add tests and documentation

3. **GraphQL API**
   - [ ] Add `@nestjs/graphql` dependency
   - [ ] Create event resolvers
   - [ ] Expose indexed events via GraphQL
   - [ ] Add filtering and pagination

4. **Real-time Updates**
   - [ ] Add WebSocket support
   - [ ] Emit finalized events to subscribers
   - [ ] Add GraphQL subscriptions
   - [ ] Test with multiple clients

---

**Last Updated**: January 21, 2026
**Branch**: feat/EventIndexer
**Status**: ✅ Ready for Integration
