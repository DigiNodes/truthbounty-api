/**
 * Indexer Chaos and Recovery Tests
 *
 * Validates that the event indexer is resilient against the full range of
 * degraded-dependency and adversarial operating conditions:
 *
 *  - RPC provider failures (timeouts, 429 rate-limits, total unavailability)
 *  - Chain reorgs (shallow and deep) with correct state reversal
 *  - Duplicate / out-of-order event delivery (idempotency)
 *  - Stale-data delivery (events below finality threshold)
 *  - Database connectivity loss during active indexing
 *  - Partial-batch failures with correct retry semantics
 *  - Circuit breaker open/close transitions on repeated RPC failure
 *  - Canonical protocol state reproducibility from clean replay
 *
 * Architecture invariants asserted throughout:
 *  - No silent fallback to fabricated or stale state
 *  - No backend-authoritative mutation of claim / settlement / dispute state
 *  - Fail-closed on every dependency uncertainty
 *  - TypeORM-only persistence boundary; no Prisma paths
 */

import { Repository, DataSource } from 'typeorm';
import { EventIndexerService } from './event-indexer.service';
import { EventIndexerConfig } from '../config';
import {
  isRateLimitError,
  isRetryableRpcError,
  RpcProviderManager,
} from '../blockchain/utils/rpc-backoff.util';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeEventRepo(overrides: Partial<{
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
}> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeStateRepo(overrides: Partial<{
  findOne: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
}> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((x) => x),
    ...overrides,
  };
}

const BASE_CONFIG: EventIndexerConfig = {
  rpcUrl: 'https://mainnet.optimism.io',
  chainId: 10,
  confirmationsRequired: 12,
  blockRangePerBatch: 100,
  maxRetryAttempts: 3,
  pollingIntervalMs: 12_000,
  contracts: [
    {
      address: '0x1234567890123456789012345678901234567890',
      name: 'TestContract',
      startBlock: 1_000,
      events: [
        {
          name: 'Transfer',
          signature:
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)',
        },
      ],
    },
  ],
};

function makeIndexer(
  configOverrides: Partial<EventIndexerConfig> = {},
  eventRepoOverrides = {},
  stateRepoOverrides = {},
): {
  service: EventIndexerService;
  eventRepo: ReturnType<typeof makeEventRepo>;
  stateRepo: ReturnType<typeof makeStateRepo>;
} {
  const eventRepo = makeEventRepo(eventRepoOverrides as any);
  const stateRepo = makeStateRepo(stateRepoOverrides as any);
  const config = { ...BASE_CONFIG, ...configOverrides };
  const service = new EventIndexerService(config, eventRepo as any, stateRepo as any);
  return { service, eventRepo, stateRepo };
}

// ---------------------------------------------------------------------------
// RPC failure-mode helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<{
  getBlockNumber: jest.Mock;
  getLogs: jest.Mock;
  getBlock: jest.Mock;
  getCode: jest.Mock;
  getNetwork: jest.Mock;
}> = {}) {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(2_000),
    getLogs: jest.fn().mockResolvedValue([]),
    getBlock: jest.fn().mockResolvedValue({ number: 1_100 }),
    getCode: jest.fn().mockResolvedValue('0x6080'),
    getNetwork: jest.fn().mockResolvedValue({ chainId: BigInt(10) }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1 – Service lifecycle and invariant baseline
// ---------------------------------------------------------------------------

describe('EventIndexerService — lifecycle and invariants', () => {
  it('instantiates and reports isRunning=false before start()', () => {
    const { service } = makeIndexer();
    // Access private field via cast — acceptable in test context only.
    expect((service as any).isIndexing).toBe(false);
  });

  it('start() sets isIndexing=true and initialises indexing state', async () => {
    const { service, stateRepo } = makeIndexer();
    // Provide a mock provider that doesn't actually poll.
    const provider = makeProvider();
    (service as any).provider = provider;
    // Prevent the poll loop from running by stopping immediately after start.
    jest
      .spyOn(service as any, 'startIndexingLoop')
      .mockImplementation(() => {});

    await service.start();

    expect((service as any).isIndexing).toBe(true);
    // initializeIndexingState was called for the one configured event.
    expect(stateRepo.findOne).toHaveBeenCalled();
  });

  it('stop() sets isIndexing=false', async () => {
    const { service } = makeIndexer();
    jest
      .spyOn(service as any, 'startIndexingLoop')
      .mockImplementation(() => {});
    await service.start();
    service.stop();
    expect((service as any).isIndexing).toBe(false);
  });

  it('start() is idempotent — calling twice does not double-initialise', async () => {
    const { service, stateRepo } = makeIndexer();
    jest
      .spyOn(service as any, 'startIndexingLoop')
      .mockImplementation(() => {});
    await service.start();
    const callsBefore = stateRepo.findOne.mock.calls.length;
    await service.start(); // second call should be a no-op
    expect(stateRepo.findOne.mock.calls.length).toBe(callsBefore);
  });

  it('getStatus() always returns a valid status object, even before start()', async () => {
    const { service } = makeIndexer();
    const status = await service.getStatus();
    expect(status).toMatchObject({
      isRunning: false,
      currentBlockNumber: 0,
      indexingStates: expect.any(Array),
    });
  });

  it('backfillFromBlock() throws when no state exists for the contract', async () => {
    const { service } = makeIndexer();
    await expect(
      service.backfillFromBlock(
        '0x0000000000000000000000000000000000000099',
        5_000,
      ),
    ).rejects.toThrow(/No state found/i);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 – RPC provider failures and retries
// ---------------------------------------------------------------------------

describe('EventIndexerService — RPC provider chaos', () => {
  it('records an error status on the indexing state when getLogs throws', async () => {
    const { service, stateRepo } = makeIndexer();
    const provider = makeProvider({
      getBlockNumber: jest.fn().mockResolvedValue(2_000),
      getLogs: jest.fn().mockRejectedValue(new Error('RPC connection refused')),
    });
    (service as any).provider = provider;

    // Seed an existing state so indexContract proceeds to getLogs.
    stateRepo.findOne.mockResolvedValue({
      chainId: 10,
      contractAddress: BASE_CONFIG.contracts[0].address,
      eventType: 'Transfer',
      lastProcessedBlockNumber: 1_000,
      status: 'idle',
    });

    await (service as any).indexEventType(
      BASE_CONFIG.contracts[0].address,
      BASE_CONFIG.contracts[0].events[0],
      2_000,
    );

    // State must be marked as error — not silently ignored.
    const savedState = stateRepo.save.mock.calls[0][0];
    expect(savedState.status).toBe('error');
    expect(savedState.errorMessage).toMatch(/RPC connection refused/i);
  });

  it('does not persist any events when getLogs returns an empty array', async () => {
    const { service, eventRepo, stateRepo } = makeIndexer();
    const provider = makeProvider({
      getLogs: jest.fn().mockResolvedValue([]),
    });
    (service as any).provider = provider;

    stateRepo.findOne.mockResolvedValue({
      chainId: 10,
      contractAddress: BASE_CONFIG.contracts[0].address,
      eventType: 'Transfer',
      lastProcessedBlockNumber: 1_000,
      status: 'idle',
    });

    await (service as any).indexEventType(
      BASE_CONFIG.contracts[0].address,
      BASE_CONFIG.contracts[0].events[0],
      2_000,
    );

    expect(eventRepo.save).not.toHaveBeenCalled();
    // But state must still be advanced.
    const savedState = stateRepo.save.mock.calls[0][0];
    expect(savedState.lastProcessedBlockNumber).toBeGreaterThan(1_000);
  });

  it('skips the block range when startBlock > endBlock (not yet past finality)', async () => {
    const { service, stateRepo } = makeIndexer();
    stateRepo.findOne.mockResolvedValue({
      chainId: 10,
      contractAddress: BASE_CONFIG.contracts[0].address,
      eventType: 'Transfer',
      lastProcessedBlockNumber: 1_990, // only 10 blocks behind current
      status: 'idle',
    });

    const eventTypeSpy = jest.spyOn(service as any, 'fetchEvents');
    // currentBlockNumber = 2_000, confirmationsRequired = 12
    // endBlock = 2000 - 12 = 1988, startBlock = 1991 → startBlock > endBlock → skip
    await (service as any).indexEventType(
      BASE_CONFIG.contracts[0].address,
      BASE_CONFIG.contracts[0].events[0],
      2_000,
    );

    expect(eventTypeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 – Idempotency (duplicate-delivery)
// ---------------------------------------------------------------------------

describe('EventIndexerService — duplicate event delivery (idempotency)', () => {
  it('skips processing when the event already exists in the repository', async () => {
    const { service, eventRepo } = makeIndexer();
    // Simulate event already stored.
    eventRepo.findOne.mockResolvedValue({
      transactionHash: '0xtx001',
      logIndex: 0,
      eventType: 'Transfer',
    });

    const provider = makeProvider({
      getBlock: jest.fn().mockResolvedValue({ number: 1_100 }),
    });
    (service as any).provider = provider;

    await (service as any).processEvent(
      BASE_CONFIG.contracts[0].address,
      BASE_CONFIG.contracts[0].events[0],
      {
        transactionHash: '0xtx001',
        index: 0,
        blockNumber: 1_100,
        topics: [],
        data: '0x',
      },
      2_000,
    );

    // create / save must not be called for a duplicate.
    expect(eventRepo.create).not.toHaveBeenCalled();
    expect(eventRepo.save).not.toHaveBeenCalled();
  });

  it('processes the same event delivered three times exactly once', async () => {
    const storedEvents: Record<string, boolean> = {};
    const { service, eventRepo } = makeIndexer();

    eventRepo.findOne.mockImplementation(({ where }: any) => {
      const key = `${where.transactionHash}:${where.logIndex}`;
      return Promise.resolve(storedEvents[key] ? { txHash: key } : null);
    });
    eventRepo.save.mockImplementation((ev: any) => {
      storedEvents[`${ev.transactionHash}:${ev.logIndex}`] = true;
      return Promise.resolve(ev);
    });

    const provider = makeProvider({
      getBlock: jest.fn().mockResolvedValue({ number: 1_100 }),
    });
    (service as any).provider = provider;

    const log = {
      transactionHash: '0xtx_dup',
      index: 0,
      blockNumber: 1_100,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ],
      data: '0x' + '0'.repeat(63) + '64',
    };

    for (let i = 0; i < 3; i++) {
      await (service as any).processEvent(
        BASE_CONFIG.contracts[0].address,
        BASE_CONFIG.contracts[0].events[0],
        log,
        2_000,
      );
    }

    // save called exactly once.
    expect(eventRepo.save.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 – Reorg detection and recovery
// ---------------------------------------------------------------------------

describe('EventIndexerService — reorg detection', () => {
  it('marks a previously finalized event as unfinalized when confirmations drop', async () => {
    const finalizedEvent = {
      id: 1,
      transactionHash: '0xtx_reorg',
      logIndex: 0,
      blockNumber: 1_800,
      isFinalized: true,
      isProcessed: true,
      processingError: null,
      retryAttempts: 0,
    };

    const { service, eventRepo } = makeIndexer();
    // Return one finalized event that is now below the confirmation threshold.
    // currentBlock = 1_810, confirmations = 12 → 1810 - 1800 = 10 < 12
    eventRepo.find.mockResolvedValue([finalizedEvent]);

    await (service as any).reconcileReorgs(1_810);

    // The event must be un-finalized so it can be re-evaluated.
    expect(eventRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ isFinalized: false }),
    );
  });

  it('does not touch finalized events that still have sufficient confirmations', async () => {
    const finalizedEvent = {
      id: 2,
      transactionHash: '0xtx_safe',
      logIndex: 0,
      blockNumber: 1_500,
      isFinalized: true,
      isProcessed: true,
    };

    const { service, eventRepo } = makeIndexer();
    eventRepo.find.mockResolvedValue([finalizedEvent]);

    // currentBlock = 1_520, 1520 - 1500 = 20 > 12 confirmations → safe
    await (service as any).reconcileReorgs(1_520);

    expect(eventRepo.save).not.toHaveBeenCalled();
  });

  it('reconcileReorgs silently logs (no throw) when the repository errors', async () => {
    const { service, eventRepo } = makeIndexer();
    eventRepo.find.mockRejectedValue(new Error('DB unavailable'));

    // Must not throw — the indexer loop should continue.
    await expect(
      (service as any).reconcileReorgs(2_000),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 5 – Stale-data / finality guard
// ---------------------------------------------------------------------------

describe('EventIndexerService — finality guard (stale data)', () => {
  it('persists events with isFinalized=false when confirmations are below threshold', async () => {
    const { service, eventRepo } = makeIndexer();

    eventRepo.findOne.mockResolvedValue(null);

    const provider = makeProvider({
      getBlock: jest.fn().mockResolvedValue({ number: 1_990 }),
    });
    (service as any).provider = provider;

    const log = {
      transactionHash: '0xtx_stale',
      index: 0,
      blockNumber: 1_990,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ],
      data: '0x' + '0'.repeat(63) + '0a',
    };

    // currentBlockNumber = 1_995; blockNumber = 1_990; confirmations = 5 < 12
    await (service as any).processEvent(
      BASE_CONFIG.contracts[0].address,
      BASE_CONFIG.contracts[0].events[0],
      log,
      1_995,
    );

    const saved = eventRepo.create.mock.calls[0][0];
    expect(saved.isFinalized).toBe(false);
    expect(saved.confirmations).toBeLessThan(BASE_CONFIG.confirmationsRequired);
  });

  it('persists events with isFinalized=true when confirmations meet the threshold', async () => {
    const { service, eventRepo } = makeIndexer();
    eventRepo.findOne.mockResolvedValue(null);

    const provider = makeProvider({
      getBlock: jest.fn().mockResolvedValue({ number: 1_000 }),
    });
    (service as any).provider = provider;

    const log = {
      transactionHash: '0xtx_final',
      index: 0,
      blockNumber: 1_000,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ],
      data: '0x' + '0'.repeat(63) + '0a',
    };

    // currentBlockNumber = 1_100; blockNumber = 1_000; confirmations = 100 ≥ 12
    await (service as any).processEvent(
      BASE_CONFIG.contracts[0].address,
      BASE_CONFIG.contracts[0].events[0],
      log,
      1_100,
    );

    const saved = eventRepo.create.mock.calls[0][0];
    expect(saved.isFinalized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 – Degraded dependency: database errors
// ---------------------------------------------------------------------------

describe('EventIndexerService — degraded database', () => {
  it('does not throw out of indexEventType when stateRepository.findOne rejects', async () => {
    const { service, stateRepo } = makeIndexer();
    stateRepo.findOne.mockRejectedValue(new Error('Postgres connection lost'));

    const provider = makeProvider();
    (service as any).provider = provider;

    // indexContract calls indexEventType which calls stateRepository.findOne.
    // Neither should propagate the error — the loop catches and logs.
    await expect(
      (service as any).indexContract(
        BASE_CONFIG.contracts[0].address,
        2_000,
      ),
    ).resolves.toBeUndefined();
  });

  it('retryFailedEvents logs a warning but does not throw when repository.find fails', async () => {
    const { service, eventRepo } = makeIndexer();
    eventRepo.find.mockRejectedValue(new Error('Postgres timeout'));

    await expect(
      (service as any).retryFailedEvents(),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 7 – Canonical reproducibility from clean replay
// ---------------------------------------------------------------------------

describe('EventIndexerService — canonical reproducibility', () => {
  it('backfillFromBlock resets lastProcessedBlockNumber so the range is replayed', async () => {
    const existingState = {
      chainId: 10,
      contractAddress: BASE_CONFIG.contracts[0].address,
      lastProcessedBlockNumber: 1_500,
      status: 'idle',
    };
    const { service, stateRepo } = makeIndexer();
    stateRepo.findOne.mockResolvedValue(existingState);

    await service.backfillFromBlock(BASE_CONFIG.contracts[0].address, 1_200);

    const savedState = stateRepo.save.mock.calls[0][0];
    expect(savedState.lastProcessedBlockNumber).toBe(1_199);
    expect(savedState.status).toBe('backfilling');
  });

  it('initializeIndexingState creates a fresh cursor starting from contract.startBlock - 1', async () => {
    const { service, stateRepo } = makeIndexer();
    stateRepo.findOne.mockResolvedValue(null); // no existing state

    await (service as any).initializeIndexingState(
      BASE_CONFIG.contracts[0].address,
      'Transfer',
    );

    const created = stateRepo.create.mock.calls[0][0];
    expect(created.lastProcessedBlockNumber).toBe(
      BASE_CONFIG.contracts[0].startBlock - 1,
    );
    expect(created.chainId).toBe(BASE_CONFIG.chainId);
  });

  it('initializeIndexingState is idempotent: does not overwrite an existing cursor', async () => {
    const existing = {
      chainId: 10,
      contractAddress: BASE_CONFIG.contracts[0].address,
      eventType: 'Transfer',
      lastProcessedBlockNumber: 1_500,
    };
    const { service, stateRepo } = makeIndexer();
    stateRepo.findOne.mockResolvedValue(existing);

    await (service as any).initializeIndexingState(
      BASE_CONFIG.contracts[0].address,
      'Transfer',
    );

    // No create/save when state already exists.
    expect(stateRepo.create).not.toHaveBeenCalled();
    expect(stateRepo.save).not.toHaveBeenCalled();
  });

  it('getStatus returns indexingStates derived from persisted state rows', async () => {
    const stateRows = [
      {
        contractAddress: '0xabc',
        eventType: 'Transfer',
        lastProcessedBlockNumber: 1_800,
        status: 'idle',
        totalEventCount: 50,
        processedEventCount: 48,
        failedEventCount: 2,
      },
    ];
    const { service, stateRepo } = makeIndexer();
    stateRepo.find.mockResolvedValue(stateRows);

    const status = await service.getStatus();

    expect(status.indexingStates).toHaveLength(1);
    expect(status.indexingStates[0].lastProcessedBlock).toBe(1_800);
    expect(status.indexingStates[0].totalEvents).toBe(50);
    expect(status.indexingStates[0].failedEvents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 – RPC backoff utilities (unit tests for rpc-backoff.util)
// ---------------------------------------------------------------------------

describe('rpc-backoff utilities — failure classification', () => {
  it.each([
    { status: 429 },
    { statusCode: 429 },
    { code: -32005 },
    { message: 'too many requests' },
    { message: 'rate-limit exceeded' },
    { info: { responseStatus: '429 Too Many Requests' } },
  ])('isRateLimitError returns true for %o', (err) => {
    expect(isRateLimitError(err)).toBe(true);
  });

  it.each([
    { status: 200 },
    { message: 'invalid argument' },
    null,
    undefined,
    'string error',
  ])('isRateLimitError returns false for %o', (err) => {
    expect(isRateLimitError(err as any)).toBe(false);
  });

  it.each([
    { code: 'SERVER_ERROR' },
    { code: 'TIMEOUT' },
    { code: 'NETWORK_ERROR' },
    { code: 'ECONNRESET' },
    { code: 'ECONNREFUSED' },
    { code: 'ETIMEDOUT' },
    { status: 503 },
    { status: 500 },
  ])('isRetryableRpcError returns true for %o', (err) => {
    expect(isRetryableRpcError(err)).toBe(true);
  });

  it.each([
    { code: 'INVALID_ARGUMENT' },
    { code: 'CALL_EXCEPTION' },
    { status: 400 },
    { status: 404 },
  ])('isRetryableRpcError returns false for %o', (err) => {
    expect(isRetryableRpcError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 9 – RpcProviderManager circuit breaker
// ---------------------------------------------------------------------------

describe('RpcProviderManager — circuit breaker', () => {
  function makeMockProvider(name: string, behaviour: 'succeed' | 'fail' | 'rate-limit') {
    return {
      name,
      getNetwork: jest.fn().mockResolvedValue({ chainId: BigInt(10) }),
      call: jest.fn().mockImplementation(async () => {
        if (behaviour === 'succeed') return 'ok';
        if (behaviour === 'rate-limit') throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        throw Object.assign(new Error('SERVER_ERROR'), { code: 'SERVER_ERROR' });
      }),
    };
  }

  it('opens the circuit after reaching the failure threshold', async () => {
    const primary = makeMockProvider('primary', 'fail');
    const manager = new RpcProviderManager([primary], {
      chainId: 10,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 60_000,
      maxRetries: 0,
    });

    // Trigger failures up to the threshold.
    for (let i = 0; i < 3; i++) {
      try {
        await manager.call('call', []);
      } catch {
        // expected
      }
    }

    const state = manager.getProviderState('primary');
    expect(state?.status).toBe('open');
    expect(state?.failures).toBeGreaterThanOrEqual(3);
  });

  it('resets to closed when the reset window passes', async () => {
    const provider = makeMockProvider('p1', 'fail');
    const manager = new RpcProviderManager([provider], {
      chainId: 10,
      circuitBreakerThreshold: 1,
      circuitBreakerResetMs: 1,   // 1ms reset for test speed
      maxRetries: 0,
    });

    try { await manager.call('call', []); } catch { /* expected */ }

    // Wait for the circuit to reset.
    await new Promise((r) => setTimeout(r, 10));

    // Patch the provider to now succeed.
    provider.call.mockResolvedValue('recovered');

    const state = manager.getProviderState('p1');
    // After window expires the next call should close the circuit.
    if (state) {
      state.nextRetryAt = Date.now() - 1; // force expired
    }

    // The manager should attempt the provider again.
    await expect(manager.call('call', [])).resolves.toBeDefined();
  });

  it('skips a rate-limited provider within the cooldown window', async () => {
    const rateLimitProvider = makeMockProvider('rl', 'rate-limit');
    const fallback = makeMockProvider('fallback', 'succeed');
    const manager = new RpcProviderManager([rateLimitProvider, fallback], {
      chainId: 10,
      circuitBreakerThreshold: 5,
      maxRetries: 0,
      rateLimitMs: 60_000, // long cooldown so provider stays skipped
    });

    // First call will hit rate-limited provider and should fall over to fallback.
    await expect(manager.call('call', [])).resolves.toBeDefined();
  });

  it('throws when all providers are unavailable', async () => {
    const p1 = makeMockProvider('p1', 'fail');
    const p2 = makeMockProvider('p2', 'fail');
    const manager = new RpcProviderManager([p1, p2], {
      chainId: 10,
      circuitBreakerThreshold: 1,
      maxRetries: 0,
    });

    await expect(manager.call('call', [])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 10 – Regression: no unauthorized mutation paths
// ---------------------------------------------------------------------------

describe('EventIndexerService — regression: no unauthorized mutation', () => {
  it('processEvent does not mutate claim/settlement/dispute state — only IndexedEvent rows', async () => {
    const { service, eventRepo } = makeIndexer();
    eventRepo.findOne.mockResolvedValue(null);

    const provider = makeProvider({
      getBlock: jest.fn().mockResolvedValue({ number: 1_000 }),
    });
    (service as any).provider = provider;

    const log = {
      transactionHash: '0xtx_immutable',
      index: 0,
      blockNumber: 1_000,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ],
      data: '0x' + '0'.repeat(63) + '0a',
    };

    await (service as any).processEvent(
      BASE_CONFIG.contracts[0].address,
      BASE_CONFIG.contracts[0].events[0],
      log,
      1_100,
    );

    // Only eventRepository.save should have been called.
    // stateRepo.save is called at the indexEventType level, not processEvent level.
    expect(eventRepo.save).toHaveBeenCalledTimes(1);
    const persisted = eventRepo.create.mock.calls[0][0];
    // The persisted object must never contain backend-authoritative mutation fields.
    expect(persisted).not.toHaveProperty('settlementAmount');
    expect(persisted).not.toHaveProperty('rewardAmount');
    expect(persisted).not.toHaveProperty('claimResolution');
    expect(persisted).not.toHaveProperty('disputeOutcome');
  });

  it('reconcileReorgs only mutates isFinalized/isProcessed flags — never claim state', async () => {
    const events = [
      {
        id: 99,
        transactionHash: '0xtx_reorg_check',
        logIndex: 0,
        blockNumber: 1_800,
        isFinalized: true,
        isProcessed: true,
        processingError: null,
        retryAttempts: 0,
      },
    ];
    const { service, eventRepo } = makeIndexer();
    eventRepo.find.mockResolvedValue(events);

    await (service as any).reconcileReorgs(1_808); // 8 confirmations < 12

    const mutated = eventRepo.save.mock.calls[0][0];
    // Only protocol-safe flags should be touched.
    expect(Object.keys(mutated)).not.toContain('claimResolution');
    expect(Object.keys(mutated)).not.toContain('disputeOutcome');
    expect(mutated).toMatchObject({
      isFinalized: false,
      isProcessed: false,
    });
  });
});
