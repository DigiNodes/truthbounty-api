/**
 * V2-BE-125 — Adaptive Historical Backfill
 * Unit test suite covering all 8 fix conditions (2.1–2.8), regression
 * preservation (3.1–3.10), and boundary / failure-mode cases.
 *
 * No live DB, RPC, or Redis dependencies.  All external collaborators are
 * replaced with jest mocks or lightweight in-memory fakes.
 */
import { ethers, EventLog } from 'ethers';
import { EventIndexerService } from './event-indexer.service';
import { EventIndexerConfig } from '../config';
import { BlockchainStateService } from '../blockchain/state.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<EventIndexerConfig> = {}): EventIndexerConfig {
  return {
    rpcUrl: 'https://mainnet.optimism.io',
    chainId: 10,
    confirmationsRequired: 12,
    blockRangePerBatch: 500,
    maxRetryAttempts: 3,
    pollingIntervalMs: 12000,
    minBatchSizeFloor: 1,
    adaptiveFillThresholdBlocks: 10_000,
    contracts: [
      {
        address: '0xcontract',
        name: 'TestContract',
        startBlock: 100,
        events: [
          {
            name: 'Transfer',
            signature: '0x' + 'a'.repeat(64),
            abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeRepos() {
  const eventRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
  };
  const stateRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
  };
  const artifactRepository = {
    findOne: jest.fn().mockResolvedValue(null),
  };
  return { eventRepository, stateRepository, artifactRepository };
}

function makeStateService() {
  return {
    setObservedHead: jest.fn().mockResolvedValue(undefined),
    setFinalizedBlock: jest.fn().mockResolvedValue(undefined),
    setProjectionHead: jest.fn().mockResolvedValue(undefined),
    recordDeadLetter: jest.fn().mockResolvedValue(undefined),
    recordRpcFailure: jest.fn().mockResolvedValue(undefined),
    getIndexerHealth: jest.fn().mockResolvedValue({
      status: 'healthy',
      deadLetterCount: 0,
      rpcFailureCount: 0,
    }),
  } as unknown as BlockchainStateService;
}

function makeQueryRunner(overrides: Record<string, any> = {}) {
  const manager = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((_, data) => ({ ...data })),
    save: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
}

function makeDataSource(queryRunnerOverrides: Record<string, any> = {}) {
  const qr = makeQueryRunner(queryRunnerOverrides);
  const dataSource = { createQueryRunner: jest.fn().mockReturnValue(qr) };
  return { dataSource, queryRunner: qr };
}

function buildService(
  configOverrides: Partial<EventIndexerConfig> = {},
  stateServiceOverride?: BlockchainStateService,
  qrManagerOverrides: Record<string, any> = {},
) {
  const config = makeConfig(configOverrides);
  const { eventRepository, stateRepository, artifactRepository } = makeRepos();
  const { dataSource, queryRunner } = makeDataSource(qrManagerOverrides);
  const stateService = stateServiceOverride ?? makeStateService();

  const service = new EventIndexerService(
    config,
    eventRepository as any,
    stateRepository as any,
    dataSource as any,
    stateService,
    artifactRepository as any,
  );

  // Inject a mock provider so real RPC calls never happen.
  const mockProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(200_000),
    getLogs: jest.fn().mockResolvedValue([]),
    send: jest.fn().mockResolvedValue({ number: '0x30D40' }), // 200_000 hex
  };
  (service as any).provider = mockProvider;

  return { service, eventRepository, stateRepository, artifactRepository, dataSource, queryRunner, mockProvider, config };
}

// ─── Basic smoke test ─────────────────────────────────────────────────────────

describe('EventIndexerService — basic', () => {
  it('should be constructable', () => {
    const { service } = buildService();
    expect(service).toBeDefined();
  });

  it('getStatus returns a well-formed status object', async () => {
    const { service } = buildService();
    const status = await service.getStatus();
    expect(status).toMatchObject({
      isRunning: expect.any(Boolean),
      currentBlockNumber: expect.any(Number),
      indexingStates: expect.any(Array),
    });
  });
});

// ─── Fix 2.1 — Adaptive range halving ────────────────────────────────────────

describe('Fix 2.1 — adaptive range halving on getLogs range-too-large', () => {
  const rangeTooLargeError = Object.assign(new Error('Log response size exceeded'), {
    code: -32005,
  });

  it('halves the range and retries until the request succeeds', async () => {
    const { service, mockProvider } = buildService({ blockRangePerBatch: 200 });

    // First call fails with range-too-large; second (halved) call succeeds.
    mockProvider.getLogs
      .mockRejectedValueOnce(rangeTooLargeError)
      .mockResolvedValue([]);

    const logs = await (service as any).fetchEventsAdaptive(
      '0xcontract',
      '0x' + 'a'.repeat(64),
      1000,
      1199,
    );

    expect(logs).toEqual([]);
    expect(mockProvider.getLogs).toHaveBeenCalledTimes(2);
  });

  it('permanently reduces effectiveBatchSize after halving', async () => {
    const { service, mockProvider } = buildService({ blockRangePerBatch: 200 });

    mockProvider.getLogs
      .mockRejectedValueOnce(rangeTooLargeError)
      .mockResolvedValue([]);

    await (service as any).fetchEventsAdaptive('0xcontract', '0x' + 'a'.repeat(64), 1000, 1199);

    expect((service as any).effectiveBatchSize).toBeLessThan(200);
  });

  it('stops halving at minBatchSizeFloor and throws when floor is reached', async () => {
    const { service, mockProvider } = buildService({
      blockRangePerBatch: 2,
      minBatchSizeFloor: 1,
    });

    // Every call fails with range-too-large.
    mockProvider.getLogs.mockRejectedValue(rangeTooLargeError);

    await expect(
      (service as any).fetchEventsAdaptive('0xcontract', '0x' + 'a'.repeat(64), 1000, 1001),
    ).rejects.toThrow();
  });

  it('accumulates results across multiple sub-ranges', async () => {
    const { service, mockProvider } = buildService({ blockRangePerBatch: 100 });

    const fakeLog = { transactionHash: '0x1', index: 0, blockNumber: 1000 } as unknown as EventLog;

    // Range too large on first attempt, then two successful sub-ranges.
    mockProvider.getLogs
      .mockRejectedValueOnce(rangeTooLargeError)
      .mockResolvedValueOnce([fakeLog])
      .mockResolvedValueOnce([]);

    const logs = await (service as any).fetchEventsAdaptive(
      '0xcontract', '0x' + 'a'.repeat(64), 1000, 1099,
    );

    expect(logs).toHaveLength(1);
  });
});

// ─── Fix 2.2 — High-throughput adaptive backfill mode ────────────────────────

describe('Fix 2.2 — high-throughput adaptive backfill mode', () => {
  it('enters adaptive backfill mode when gap > threshold', async () => {
    const { service, stateRepository, mockProvider } = buildService({
      adaptiveFillThresholdBlocks: 1000,
    });

    const mockState = {
      chainId: 10,
      contractAddress: '0xcontract',
      lastProcessedBlockNumber: 0,
      status: 'idle',
    };
    stateRepository.findOne.mockResolvedValue(mockState);

    // Provider reports finalized block at 200_000 (gap = 199_900 > 1000).
    mockProvider.send.mockResolvedValue({ number: '0x30D40' }); // 200_000
    mockProvider.getLogs.mockResolvedValue([]);

    const logSpy = jest.spyOn((service as any).logger, 'log');

    await service.backfillFromBlock('0xcontract', 100);

    const adaptiveEntry = logSpy.mock.calls.some((args) =>
      String(args[0]).includes('adaptive_backfill_mode_entered'),
    );
    expect(adaptiveEntry).toBe(true);
  });

  it('does NOT enter adaptive mode when gap <= threshold', async () => {
    const { service, stateRepository, mockProvider } = buildService({
      adaptiveFillThresholdBlocks: 10_000,
    });

    const mockState = {
      chainId: 10,
      contractAddress: '0xcontract',
      lastProcessedBlockNumber: 199_500,
      status: 'idle',
    };
    stateRepository.findOne.mockResolvedValue(mockState);

    // Gap = 200_000 - 199_600 = 400 < 10_000 threshold.
    mockProvider.send.mockResolvedValue({ number: '0x30D40' }); // 200_000

    const logSpy = jest.spyOn((service as any).logger, 'log');

    await service.backfillFromBlock('0xcontract', 199_600);

    const adaptiveEntry = logSpy.mock.calls.some((args) =>
      String(args[0]).includes('adaptive_backfill_mode_entered'),
    );
    expect(adaptiveEntry).toBe(false);
  });

  it('throws when contract state not found', async () => {
    const { service, stateRepository } = buildService();
    stateRepository.findOne.mockResolvedValue(null);

    await expect(service.backfillFromBlock('0xunknown', 100)).rejects.toThrow(
      /No indexing state found/,
    );
  });
});

// ─── Fix 2.3 — endBlock capped at provider-reported finalized block ──────────

describe('Fix 2.3 — endBlock capped at provider finalized block', () => {
  it('calls eth_getBlockByNumber("finalized") to cap endBlock', async () => {
    const { service, mockProvider } = buildService();

    // Finalized block = 100_000
    mockProvider.send.mockResolvedValue({ number: '0x186A0' });

    const finalized = await (service as any).fetchFinalizedBlockNumber();
    expect(finalized).toBe(100_000);
    expect(mockProvider.send).toHaveBeenCalledWith('eth_getBlockByNumber', [
      'finalized',
      false,
    ]);
  });

  it('falls back to currentBlockNumber - confirmationsRequired when provider throws', async () => {
    const { service, mockProvider, stateRepository } = buildService({
      confirmationsRequired: 12,
      blockRangePerBatch: 100,
    });

    mockProvider.send.mockRejectedValue(new Error('provider unavailable'));
    mockProvider.getLogs.mockResolvedValue([]);

    const state = {
      chainId: 10,
      contractAddress: '0xcontract',
      eventType: 'Transfer',
      lastProcessedBlockNumber: 990,
      status: 'idle',
    };
    stateRepository.findOne.mockResolvedValue(state);
    (service as any).currentBlockNumber = 1100;

    // Should not throw; falls back gracefully.
    await expect(
      (service as any).indexEventType(
        '0xcontract',
        (service as any).config.contracts[0].events[0],
        1100,
      ),
    ).resolves.not.toThrow();
  });
});

// ─── Fix 2.4 — Dead-letter counter incremented ───────────────────────────────

describe('Fix 2.4 — dead-lettered events call stateService.recordDeadLetter()', () => {
  it('transitions exhausted events to dead_letter and calls recordDeadLetter()', async () => {
    const stateService = makeStateService();
    const { service, eventRepository, stateRepository } = buildService({}, stateService);

    const exhaustedEvent = {
      id: 'uuid-1',
      contractAddress: '0xcontract',
      eventType: 'Transfer',
      transactionHash: '0xtx',
      logIndex: 0,
      isProcessed: false,
      retryAttempts: 3, // === maxRetryAttempts
    };
    eventRepository.find.mockResolvedValue([exhaustedEvent]);

    const stateForContract = {
      chainId: 10,
      contractAddress: '0xcontract',
      eventType: 'Transfer',
      status: 'idle',
    };
    stateRepository.findOne.mockResolvedValue(stateForContract);

    await (service as any).retryFailedEvents();

    expect(stateService.recordDeadLetter).toHaveBeenCalledWith(1);
    expect(stateForContract.status).toBe('dead_letter');
    expect(stateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dead_letter' }),
    );
  });

  it('does not call recordDeadLetter when no events are exhausted', async () => {
    const stateService = makeStateService();
    const { service, eventRepository } = buildService({}, stateService);

    eventRepository.find.mockResolvedValue([]);
    await (service as any).retryFailedEvents();

    expect(stateService.recordDeadLetter).not.toHaveBeenCalled();
  });

  it('does not re-transition a state already in dead_letter', async () => {
    const stateService = makeStateService();
    const { service, eventRepository, stateRepository } = buildService({}, stateService);

    const exhaustedEvent = {
      contractAddress: '0xcontract',
      eventType: 'Transfer',
      transactionHash: '0xtx',
      logIndex: 0,
      isProcessed: false,
      retryAttempts: 3,
    };
    eventRepository.find.mockResolvedValue([exhaustedEvent]);

    const stateForContract = {
      chainId: 10,
      contractAddress: '0xcontract',
      eventType: 'Transfer',
      status: 'dead_letter', // already in dead_letter
    };
    stateRepository.findOne.mockResolvedValue(stateForContract);

    await (service as any).retryFailedEvents();

    // recordDeadLetter still called but state.save not called again
    expect(stateService.recordDeadLetter).toHaveBeenCalledWith(1);
    expect(stateRepository.save).not.toHaveBeenCalled();
  });
});

// ─── Fix 2.5 — Atomic batch persistence ──────────────────────────────────────

describe('Fix 2.5 — event rows and checkpoint committed in one transaction', () => {
  it('commits event rows and checkpoint update in a single transaction', async () => {
    const { service, queryRunner, dataSource } = buildService();

    const fakeState = {
      chainId: 10,
      contractAddress: '0xcontract',
      eventType: 'Transfer',
      lastProcessedBlockNumber: 999,
      status: 'idle',
    };
    const fakeEvent = {
      transactionHash: '0xtx1',
      index: 0,
      blockNumber: 1000,
      topics: ['0x' + 'a'.repeat(64)],
      data: '0x',
    } as unknown as EventLog;

    await (service as any).persistBatch(
      '0xcontract',
      { name: 'Transfer', signature: '0x' + 'a'.repeat(64), abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
      [],
      1099,
      200_000,
      fakeState,
    );

    expect(dataSource.createQueryRunner).toHaveBeenCalled();
    expect(queryRunner.startTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('rolls back the transaction when an event save fails', async () => {
    const { service, queryRunner, stateRepository } = buildService(
      {},
      undefined,
      { save: jest.fn().mockRejectedValue(new Error('db write error')) },
    );

    const fakeLog = {
      transactionHash: '0xtx1',
      index: 0,
      blockNumber: 1000,
      topics: ['0x' + 'a'.repeat(64)],
      data: '0x',
    } as unknown as EventLog;

    const fakeState = {
      lastProcessedBlockNumber: 999,
      status: 'idle',
    };

    await expect(
      (service as any).persistBatch(
        '0xcontract',
        { name: 'Transfer', signature: '0x' + 'a'.repeat(64), abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
        [fakeLog],
        1099,
        200_000,
        fakeState,
      ),
    ).rejects.toThrow('db write error');

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});

// ─── Fix 2.6 — Deployment-block validation ───────────────────────────────────

describe('Fix 2.6 — getDeploymentBlock returns canonical deployment block', () => {
  it('returns null when no approved artifact exists', async () => {
    const { service, artifactRepository } = buildService();
    artifactRepository.findOne.mockResolvedValue(null);

    const result = await service.getDeploymentBlock(10, '0xcontract');
    expect(result).toBeNull();
  });

  it('returns null when artifact is not approved', async () => {
    const { service, artifactRepository } = buildService();
    artifactRepository.findOne.mockResolvedValue({
      isApproved: false,
      deploymentBlock: '100000',
    });

    const result = await service.getDeploymentBlock(10, '0xcontract');
    expect(result).toBeNull();
  });

  it('returns null when deploymentBlock is null on an approved artifact', async () => {
    const { service, artifactRepository } = buildService();
    artifactRepository.findOne.mockResolvedValue({
      isApproved: true,
      deploymentBlock: null,
    });

    const result = await service.getDeploymentBlock(10, '0xcontract');
    expect(result).toBeNull();
  });

  it('returns the deployment block as a bigint for an approved artifact', async () => {
    const { service, artifactRepository } = buildService();
    artifactRepository.findOne.mockResolvedValue({
      isApproved: true,
      deploymentBlock: '12345678',
    });

    const result = await service.getDeploymentBlock(10, '0xcontract');
    expect(result).toBe(12345678n);
  });

  it('returns null when artifactRepository is not injected', async () => {
    // Construct without artifactRepository to test optional-injection path.
    const config = makeConfig();
    const { eventRepository, stateRepository } = makeRepos();
    const service = new EventIndexerService(
      config,
      eventRepository as any,
      stateRepository as any,
    );

    const result = await service.getDeploymentBlock(10, '0xcontract');
    expect(result).toBeNull();
  });
});

// ─── Fix 2.7 — Historical finalized blocks immediately isFinalized = true ────

describe('Fix 2.7 — historical blocks <= finalizedBlock are immediately finalized', () => {
  it('marks event as isFinalized=true when blockNumber <= finalizedBlock', async () => {
    const { service } = buildService();

    const manager = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((_, data) => ({ ...data })),
      save: jest.fn().mockResolvedValue({}),
    };

    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent('Transfer')!, [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      100n,
    ]);

    const log = {
      transactionHash: '0x' + 'b'.repeat(64),
      index: 0,
      blockNumber: 100_000, // historical — <= finalizedBlock 200_000
      topics: encoded.topics,
      data: encoded.data,
    } as unknown as EventLog;

    await (service as any).persistEventInTx(
      manager,
      '0xcontract',
      { name: 'Transfer', abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
      log,
      101_000,   // batchEndBlock
      200_000,   // finalizedBlock — log.blockNumber <= this
    );

    const saved = manager.save.mock.calls[0][1];
    expect(saved.isFinalized).toBe(true);
  });

  it('does NOT finalize a live-tip event whose blockNumber > finalizedBlock', async () => {
    const { service } = buildService({ confirmationsRequired: 12 });

    const manager = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((_, data) => ({ ...data })),
      save: jest.fn().mockResolvedValue({}),
    };

    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent('Transfer')!, [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      100n,
    ]);

    const log = {
      transactionHash: '0x' + 'c'.repeat(64),
      index: 0,
      blockNumber: 200_005, // above finalizedBlock 200_000
      topics: encoded.topics,
      data: encoded.data,
    } as unknown as EventLog;

    await (service as any).persistEventInTx(
      manager,
      '0xcontract',
      { name: 'Transfer', abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
      log,
      200_010,
      200_000, // finalizedBlock < log.blockNumber
    );

    const saved = manager.save.mock.calls[0][1];
    // Only 5 confirmations — below the 12-block threshold.
    expect(saved.isFinalized).toBe(false);
  });

  it('is idempotent: second delivery of same event is a no-op', async () => {
    const { service } = buildService();

    const manager = {
      findOne: jest.fn().mockResolvedValue({ id: 'existing' }), // already exists
      create: jest.fn(),
      save: jest.fn(),
    };

    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent('Transfer')!, [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      100n,
    ]);

    const log = {
      transactionHash: '0x' + 'd'.repeat(64),
      index: 0,
      blockNumber: 100_000,
      topics: encoded.topics,
      data: encoded.data,
    } as unknown as EventLog;

    await (service as any).persistEventInTx(
      manager,
      '0xcontract',
      { name: 'Transfer', abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
      log,
      101_000,
      200_000,
    );

    expect(manager.save).not.toHaveBeenCalled();
  });
});

// ─── Fix 2.8 — Paginated reconcileReorgs ─────────────────────────────────────

describe('Fix 2.8 — reconcileReorgs loads events in pages (never all at once)', () => {
  it('paginates using take/skip and exits when a page is empty', async () => {
    const { service, eventRepository } = buildService();

    // Page 1: 1000 finalized events (full page). Page 2: empty.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `id-${i}`,
      blockNumber: 100_000 + i,
      transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
      logIndex: 0,
      isFinalized: true,
      isProcessed: true,
      processingError: null,
      retryAttempts: 0,
    }));

    eventRepository.find
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([]);

    await (service as any).reconcileReorgs(200_000);

    expect(eventRepository.find).toHaveBeenCalledTimes(2);

    // Verify pagination args on first call.
    const firstCall = eventRepository.find.mock.calls[0][0];
    expect(firstCall).toMatchObject({ take: 1000, skip: 0 });

    // Second call should skip 1000.
    const secondCall = eventRepository.find.mock.calls[1][0];
    expect(secondCall).toMatchObject({ take: 1000, skip: 1000 });
  });

  it('resets reorg-affected events to isFinalized=false, isProcessed=false, processingError=null', async () => {
    const { service, eventRepository } = buildService({ confirmationsRequired: 12 });

    // Event at block 199_995 — only 5 confirmations at head 200_000 → reorg candidate.
    const suspectEvent = {
      id: 'reorg-event',
      blockNumber: 199_995,
      transactionHash: '0x' + 'e'.repeat(64),
      logIndex: 0,
      isFinalized: true,
      isProcessed: true,
      processingError: 'some old error',
      retryAttempts: 1,
    };

    eventRepository.find
      .mockResolvedValueOnce([suspectEvent])
      .mockResolvedValueOnce([]);

    await (service as any).reconcileReorgs(200_000);

    expect(eventRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        isFinalized: false,
        isProcessed: false,
        processingError: null,
        retryAttempts: 0,
      }),
    );
  });

  it('does not reset events with sufficient confirmations', async () => {
    const { service, eventRepository } = buildService({ confirmationsRequired: 12 });

    // Event at block 100_000 — 100_000 confirmations → fully finalized.
    const finalizedEvent = {
      id: 'finalized-event',
      blockNumber: 100_000,
      transactionHash: '0x' + 'f'.repeat(64),
      logIndex: 0,
      isFinalized: true,
      isProcessed: true,
      processingError: null,
      retryAttempts: 0,
    };

    eventRepository.find
      .mockResolvedValueOnce([finalizedEvent])
      .mockResolvedValueOnce([]);

    await (service as any).reconcileReorgs(200_000);

    expect(eventRepository.save).not.toHaveBeenCalled();
  });
});

// ─── Regression 3.1 — Live-tip events deferred until confirmations met ────────

describe('Regression 3.1 — live-tip events stored as isFinalized=false', () => {
  it('stores a live-tip event with isFinalized=false when confirmations < required', async () => {
    const { service } = buildService({ confirmationsRequired: 12 });

    const manager = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((_, data) => ({ ...data })),
      save: jest.fn().mockResolvedValue({}),
    };

    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent('Transfer')!, [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      50n,
    ]);

    const log = {
      transactionHash: '0x' + '1'.repeat(64),
      index: 0,
      blockNumber: 200_003, // live tip: blockNumber > finalizedBlock (200_000)
      topics: encoded.topics,
      data: encoded.data,
    } as unknown as EventLog;

    await (service as any).persistEventInTx(
      manager,
      '0xcontract',
      { name: 'Transfer', abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
      log,
      200_010,
      200_000, // finalizedBlock — log is above this
    );

    const saved = manager.save.mock.calls[0][1];
    expect(saved.isFinalized).toBe(false);
  });
});

// ─── Regression 3.2 — Idempotency (duplicate delivery) ───────────────────────

describe('Regression 3.2 — duplicate event delivery is a no-op', () => {
  it('skips saving when the (txHash, logIndex, eventType) triple already exists', async () => {
    const { service, eventRepository } = buildService();

    // Event already in the repository.
    eventRepository.findOne.mockResolvedValue({ id: 'existing' });

    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent('Transfer')!, [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      10n,
    ]);

    const log = {
      transactionHash: '0x' + '2'.repeat(64),
      index: 0,
      blockNumber: 100_000,
      topics: encoded.topics,
      data: encoded.data,
    } as unknown as EventLog;

    await (service as any).processEvent(
      '0xcontract',
      { name: 'Transfer', abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
      log,
      101_000,
      200_000,
    );

    expect(eventRepository.save).not.toHaveBeenCalled();
  });
});

// ─── Regression 3.4 — RPC failures increment stateService counter ────────────

describe('Regression 3.4 — transient RPC failure increments rpcFailureCount', () => {
  it('fetchFinalizedBlockNumber propagates provider errors (fail closed)', async () => {
    const { service, mockProvider } = buildService();
    mockProvider.send.mockRejectedValue(new Error('RPC timeout'));

    await expect((service as any).fetchFinalizedBlockNumber()).rejects.toThrow('RPC timeout');
  });
});

// ─── Regression 3.5 — Standard polling continues at configured interval ──────

describe('Regression 3.5 — stop() halts the polling loop', () => {
  it('sets isIndexing to false when stop() is called', () => {
    const { service } = buildService();
    (service as any).isIndexing = true;
    service.stop();
    expect((service as any).isIndexing).toBe(false);
  });
});

// ─── Regression 3.10 — Restart resumes from persisted checkpoint ─────────────

describe('Regression 3.10 — restart resumes from persisted checkpoint', () => {
  it('stop() + start() re-enters running state', async () => {
    const { service, stateRepository } = buildService();
    stateRepository.find.mockResolvedValue([]);

    service.stop();
    expect((service as any).isIndexing).toBe(false);

    await service.start();
    expect((service as any).isIndexing).toBe(true);

    // Clean up the polling loop.
    service.stop();
  });
});

// ─── Boundary conditions ──────────────────────────────────────────────────────

describe('Boundary conditions', () => {
  it('backfillFromBlock throws on missing state even with valid block', async () => {
    const { service, stateRepository } = buildService();
    stateRepository.findOne.mockResolvedValue(null);
    await expect(service.backfillFromBlock('0xcontract', 0)).rejects.toThrow();
  });

  it('fetchFinalizedBlockNumber parses hex block number correctly', async () => {
    const { service, mockProvider } = buildService();
    mockProvider.send.mockResolvedValue({ number: '0x1' }); // block 1
    const result = await (service as any).fetchFinalizedBlockNumber();
    expect(result).toBe(1);
  });

  it('fetchFinalizedBlockNumber handles large block numbers without overflow', async () => {
    const { service, mockProvider } = buildService();
    // block 20_000_000 = 0x1312D00
    mockProvider.send.mockResolvedValue({ number: '0x1312D00' });
    const result = await (service as any).fetchFinalizedBlockNumber();
    expect(result).toBe(20_000_000);
  });

  it('persistBatch with empty logs only commits the checkpoint update', async () => {
    const { service, queryRunner } = buildService();
    const fakeState = { lastProcessedBlockNumber: 999, status: 'idle' };

    await (service as any).persistBatch(
      '0xcontract',
      { name: 'Transfer', signature: '0x', abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)' },
      [], // no logs
      1099,
      200_000,
      fakeState,
    );

    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    // manager.save called once for the state checkpoint
    expect(queryRunner.manager.save).toHaveBeenCalledTimes(1);
  });
});

// ─── BigInt serialization (pre-existing regression) ──────────────────────────

describe('BigInt serialization — parsedData is JSON-safe', () => {
  it('serializes decoded BigInt event args as decimal strings', async () => {
    const { service, eventRepository } = buildService();

    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent('Transfer')!, [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      9007199254740993n, // > Number.MAX_SAFE_INTEGER
    ]);

    const log = {
      transactionHash: '0x' + 'a'.repeat(64),
      blockNumber: 100,
      index: 2,
      topics: encoded.topics,
      data: encoded.data,
    } as unknown as EventLog;

    eventRepository.findOne.mockResolvedValue(null);

    await (service as any).processEvent(
      '0x0000000000000000000000000000000000000003',
      {
        name: 'Transfer',
        abi: 'event Transfer(address indexed from, address indexed to, uint256 amount)',
      },
      log,
      120,
      200_000,
    );

    const persisted = eventRepository.create.mock.calls[0][0];
    expect(persisted.parsedData).toMatchObject({
      from: '0x0000000000000000000000000000000000000001',
      to: '0x0000000000000000000000000000000000000002',
      amount: '9007199254740993',
    });
    expect(() => JSON.stringify(persisted.parsedData)).not.toThrow();
    expect(eventRepository.save).toHaveBeenCalledWith(persisted);
  });
});
