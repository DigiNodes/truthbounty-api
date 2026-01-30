# Idempotent Blockchain Data Ingestion System Design

## High-Level Architecture Explanation

The idempotent blockchain data ingestion system is designed to process blockchain events (logs, transactions) exactly once, ensuring that re-runs or restarts do not corrupt the backend state. The architecture consists of the following components:

1. **Event Listener/Streamer**: Connects to the blockchain node (e.g., via WebSocket or RPC) to fetch new blocks and events in real-time or batch mode.

2. **Event Processor**: Receives events, checks for uniqueness, and processes them atomically. It uses a database to store processed events and derived state.

3. **Database Layer**: Stores event metadata for uniqueness checks and the application's state (e.g., balances, rewards). Uses constraints to enforce uniqueness.

4. **State Manager**: Handles updates to application state in a transactional manner, ensuring atomicity.

5. **Checkpoint Manager**: Tracks the last processed block to enable safe restarts and replays.

The system ensures idempotency by:
- Using a composite unique key (txHash, logIndex, blockNumber) for events.
- Checking for existing records before processing.
- Using database transactions for atomic operations.
- Allowing replay from any block without side effects.

## Database Schema Examples

### Events Table (for uniqueness tracking)
```sql
CREATE TABLE processed_events (
    id SERIAL PRIMARY KEY,
    tx_hash VARCHAR(66) NOT NULL,  -- Ethereum tx hash (0x + 64 hex chars)
    log_index INT NOT NULL,        -- Log index within transaction
    block_number BIGINT NOT NULL,  -- Block number
    event_type VARCHAR(100) NOT NULL,  -- e.g., 'Transfer', 'Mint'
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tx_hash, log_index, block_number)  -- Enforces uniqueness
);

-- Index for fast lookups
CREATE INDEX idx_events_tx_log_block ON processed_events(tx_hash, log_index, block_number);
```

### Application State Table (e.g., Token Balances)
```sql
CREATE TABLE token_balances (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) NOT NULL,  -- Ethereum address
    token_address VARCHAR(42) NOT NULL,
    balance DECIMAL(36,18) NOT NULL DEFAULT 0,  -- High precision for tokens
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(address, token_address)  -- Prevent duplicate balances
);

-- Index for performance
CREATE INDEX idx_balances_address_token ON token_balances(address, token_address);
```

### Checkpoint Table (for restart safety)
```sql
CREATE TABLE indexer_checkpoint (
    id SERIAL PRIMARY KEY,
    last_block BIGINT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Pseudocode or Code Snippets

### Event Processing Function (in TypeScript/Node.js style)
```typescript
async function processEvent(event: BlockchainEvent): Promise<void> {
    const { txHash, logIndex, blockNumber, eventType, data } = event;

    // Check if event already processed
    const existing = await db.query(
        'SELECT id FROM processed_events WHERE tx_hash = $1 AND log_index = $2 AND block_number = $3',
        [txHash, logIndex, blockNumber]
    );

    if (existing.rows.length > 0) {
        console.log('Event already processed, skipping');
        return;
    }

    // Start transaction
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        // Insert event record (will fail if unique constraint violated)
        await client.query(
            'INSERT INTO processed_events (tx_hash, log_index, block_number, event_type) VALUES ($1, $2, $3, $4)',
            [txHash, logIndex, blockNumber, eventType]
        );

        // Process the event (e.g., update balances)
        if (eventType === 'Transfer') {
            await updateBalances(client, data.from, data.to, data.amount, data.token);
        }

        // Update checkpoint
        await client.query(
            'UPDATE indexer_checkpoint SET last_block = GREATEST(last_block, $1), updated_at = CURRENT_TIMESTAMP WHERE id = 1',
            [blockNumber]
        );

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function updateBalances(client: any, from: string, to: string, amount: string, token: string): Promise<void> {
    // Decrease sender balance
    await client.query(
        'UPDATE token_balances SET balance = balance - $1, last_updated = CURRENT_TIMESTAMP WHERE address = $2 AND token_address = $3',
        [amount, from, token]
    );

    // Increase receiver balance
    await client.query(
        'UPDATE token_balances SET balance = balance + $1, last_updated = CURRENT_TIMESTAMP WHERE address = $2 AND token_address = $3',
        [amount, to, token]
    );
}
```

### Replay Function
```typescript
async function replayFromBlock(startBlock: number): Promise<void> {
    // Clear processed events from startBlock onwards (optional, for full replay)
    await db.query('DELETE FROM processed_events WHERE block_number >= $1', [startBlock]);

    // Reset affected state if needed (depends on application)
    // e.g., await resetBalancesFromBlock(startBlock);

    // Re-process blocks
    for (let block = startBlock; ; block++) {
        const events = await fetchEventsForBlock(block);
        if (events.length === 0) break;  // No more blocks

        for (const event of events) {
            await processEvent(event);
        }
    }
}
```

## Testing Strategy

1. **Unit Tests**:
   - Test uniqueness checks and constraint enforcement.
   - Mock database operations to verify atomicity.

2. **Integration Tests**:
   - Simulate event processing with real database.
   - Test transaction rollbacks on failures.

3. **Replay Tests**:
   - Process a set of events, then replay the same range.
   - Assert that database state is identical after replay.

4. **Restart Tests**:
   - Simulate indexer crash and restart.
   - Verify resumption from last checkpoint without duplicates.

5. **Load Tests**:
   - Process high volumes of events to test performance and idempotency under load.

Example Test Case (Jest style):
```typescript
describe('Event Processing', () => {
    it('should process event exactly once', async () => {
        const event = { txHash: '0x123...', logIndex: 0, blockNumber: 100, eventType: 'Transfer', data: {...} };

        // First processing
        await processEvent(event);
        let count = await db.query('SELECT COUNT(*) FROM processed_events WHERE tx_hash = $1', [event.txHash]);
        expect(count.rows[0].count).toBe(1);

        // Duplicate processing (should be ignored)
        await processEvent(event);
        count = await db.query('SELECT COUNT(*) FROM processed_events WHERE tx_hash = $1', [event.txHash]);
        expect(count.rows[0].count).toBe(1);
    });

    it('should maintain state on replay', async () => {
        // Process initial events
        // ... setup

        const initialState = await getBalances();

        // Replay
        await replayFromBlock(100);

        const replayedState = await getBalances();
        expect(replayedState).toEqual(initialState);
    });
});
```

## Common Pitfalls and Best Practices

### Pitfalls:
- **Race Conditions**: Without transactions, concurrent processing can lead to duplicates. Always use transactions.
- **Partial Updates**: If an event updates multiple tables, ensure all or none succeed.
- **Time-Based Uniqueness**: Don't rely on timestamps; use immutable blockchain data.
- **Ignoring Reorgs**: Blockchain reorganizations can invalidate events; implement reorg handling.
- **Performance Bottlenecks**: Frequent uniqueness checks can slow down; optimize with proper indexing.

### Best Practices:
- **Use Database Constraints**: Let the DB enforce uniqueness to prevent application-level bugs.
- **Atomic Operations**: Wrap all related changes in transactions.
- **Checkpointing**: Regularly update and persist the last processed block.
- **Monitoring**: Log processing metrics and alert on duplicates or failures.
- **Versioning**: Tag events with schema versions for future compatibility.
- **Testing**: Thoroughly test replay and restart scenarios in staging environments.
- **Scalability**: Consider partitioning tables by block ranges for large datasets.
- **Error Handling**: Implement exponential backoff for transient failures, and dead-letter queues for unprocessable events.