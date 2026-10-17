import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThanOrEqual } from 'typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { BlockchainStateService } from './state.service';
import { ClaimsCache } from '../cache/claims.cache';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenRalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { DeadLetterReplayService } from './dead-letter-replay.service';
import { DeadLetterReplayAudit } from './entities/dead-letter-replay-audit.entity';
import { DeadLetterMessage } from './entities/dead-letter-message.entity';
import {
  ReplayAuthorizationError,
  ReplayBoundsError,
  ReplayIncompatibilityError,
  ReplayDuplicateError,
  ReplayPoisonError,
} from './dead-letter-replay.errors';

/**
 * Replay / reorg rollback is now transactional: reverses the state applied
 * by orphaned events, deletes those event records (>= startBlock), and rewinds
 * the checkpoint — all in a single transaction.
 */
describe('BlockchainIndexerService - Replay Regression Tests', () => {
  let service: BlockchainIndexerService;
  let processedEventRepo: Repository<ProcessedEvent>;
  let dataSource: DataSource;
  let manager: any;

  const buildManager = (orphaned: Partial<ProcessedEvent>[] = []) => ({
    find: jest.fn().mockResolvedValue(orphaned),
    delete: jest.fn().mockResolvedValue({ affected: orphaned.length, raw: {} }),
    save: jest.fn().mockResolvedValue(null),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
    decrement: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue(null),
  });

  const setup = async (orphaned: Partial<ProcessedEvent>[] = []) => {
    manager = buildManager(orphaned);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(null),
      startTransaction: jest.fn().mockResolvedValue(null),
      commitTransaction: jest.fn().mockResolvedValue(null),
      rollbackTransaction: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(null),
      manager,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainIndexerService,
        DeadLetterReplayService,
        { provide: getRepositoryToken(ProcessedEvent), useClass: Repository },
        { provide: getRepositoryToken(TokenRalance), useClass: Repository },
        {
          provide: getRepositoryToken(IndexerCheckpoint),
          useClass: Repository,
        },
        { provide: getRepositoryToken(DeadLetterMessage), useClass: Repository },
        { provide: getRepositoryToken(DeadLetterReplayAudit), useClass: Repository },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn().mockReturnValue(queryRunner),
          },
        },
        {
          provide: BlockchainStateService,
          useValue: {
            setProjectionHead: jest.fn(),
            recordReplay: jest.fn(),
          },
        },
        {
          provide: ClaimsCache,
          useValue: {
            invalidateForProjectionUpdate: jest.fn(),
            invalidateAllForReorg: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(BlockchainIndexerService);
    processedEventRepo = module.get(getRepositoryToken(ProcessedEvent));
    dataSource = module.get(DataSource);
    return queryRunner;
  };

  describe('Replay State Consistency', () => {
    it('deletes all events from startBlock onward (>=) and rewinds the checkpoint', async () => {
      await setup();

      await service.replayFromBlock(100);

      // CRITICAL regression guard: deletion must cover everything >= startBlock,
      // not just the exact block (the original double-processing bug).
      expect(manager.delete).toHaveBeenCalledWith(ProcessedEvent, {
        blockNumber: MoreThanOrEqual(100),
      });
      // Checkpoint rewound to just before the rolled-back range.
      expect(manager.save).toHaveBeenCalledWith(
        IndexerCheckpoint,
        expect.objectContaining({ id: 1, lastBlock: 99 }),
      );
    });

    it('reverses the balance effect of orphaned Transfer events', async () => {
      await setup([
        {
          blockNumber: 101,
          logIndex: 0,
          eventType: 'Transfer',
          payload: { from: '0xa', to: '0xb', amount: '100', token: '0xc' },
        },
      ]);

      await service.replayFromBlock(100);

      // Inverse of applyTransfer: sender credited back, receiver debited.
      expect(manager.increment).toHaveBeenCalledWith(
        TokenRalance,
        { address: '0xa', tokenAddress: '0xc' },
        'balance',
        '100',
      );
      expect(manager.decrement).toHaveBeenCalledWith(
        TokenRalance,
        { address: '0xb', tokenAddress: '0xc' },
        'balance',
        '100',
      );
    });

    it('rewinds the checkpoint to 0 for a full replay from block 0', async () => {
      await setup();

      await service.replayFromBlock(0);

      expect(manager.delete).toHaveBeenCalledWith(ProcessedEvent, {
        blockNumber: MoreThanOrEqual(0),
      });
      expect(manager.save).toHaveBeenCalledWith(
        IndexerCheckpoint,
        expect.objectContaining({ id: 1, lastBlock: 0 }),
      );
    });

    it('is idempotent - repeated replays from the same block behave identically', async () => {
      const queryRunner = await setup();

      await service.replayFromBlock(100);
      await service.replayFromBlock(100);
      await service.replayFromBlock(100);

      expect(manager.delete).toHaveBeenCalledTimes(3);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(3);
      manager.delete.mock.calls.forEach((call: any[]) => {
        expect(call[0]).toBe(ProcessedEvent);
        expect(call[1]).toEqual({ blockNumber: MoreThanOrEqual(100) });
      });
    });

    it('rolls back the transaction if rollback work fails', async () => {
      const queryRunner = await setup();
      manager.delete.mockRejectedOnce(new Error('db error'));

      await expect(service.replayFromBlock(100)).rejects.toThrow('db error');

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });
});

/**
 * Dead-letter replay is denied by default and requires a protected capability,
 * reason, bounds, dry run, original payload hash, and audit record. Replay is blocked
 * across release/schema incompatibility, duplicate effects are prevented, and
 * operators can stop/resume bounded batches.
 */
describe('DeadLetterReplayService - Authorized Idempotent Replay', () => {
  let replayService: DeadLetterReplayService;
  let messageRepo: Repository<DeadLetterMessage>;
  let auditRepo: Repository<DeadLetterReplayAudit>;
  let dataSource: DataSource;
  let manager: any;
  let queryRunner: any;

  const releaseId = 'rel-2024-09-01';
  const chainId = 'stellar-testnet';
  const deploymentBlock = 42000;
  const artifactChecksum =
    'sha256:09f8cc6b38c14db2c15c15c15c15c15c15c15c15c15c15c15c15c15c15c15c1';

  const buildAuthorization = (override: Record<string, unknown> = {}) => ({
    capability: 'dead-letter.replay',
    actorId: 'operator-42',
    reason: 'replay poisoned transfer after fix',
    bounds: { maxMessages: 10, maxAttempts: 3 },
    dryRun: false,
    originalPayloadHash:
      'sha256:aabbccddeeff0011223344556677889900aabbccddeeff',
    chainId: chainId,
    releaseId: releaseId,
    deploymentBlock: deploymentBlock,
    artifactChecksum: artifactChecksum,
    ...override,
  });

  const buildMessage = (override: Record<string, unknown> = {}) => ({
    id: 'dlm-1001',
    status: 'dead',
    chainId: chainId,
    releaseId: releaseId,
    deploymentBlock: deploymentBlock,
    artifactChecksum: artifactChecksum,
    payloadHash:
      'sha256:aabbccddeeff0011223344556677889900aabbccddeeff',
    payload: { eventType: 'Transfer', amount: '100' },
    attempts: 1,
    ...override,
  });

  const buildManager = () => {
    const store = new Map<string, any>();
    return {
      findOne: jest.fn().mockImplementation(async (entity: any, options: any) => {
        const key = JSON.stringify(options?.where ?? {});
        return store.get(key) ?? null;
      }),
      save: jest.fn().mockImplementation(async (entity: any, value: any) => {
        const record = { ...value };
        const key = JSON.stringify({ id: record.id });
        store.set(key, record);
        return record;
      }),
      insert: jest.fn().mockImplementation(async (entity: any, value: any) => {
        const record = { ...value };
        const key = JSON.stringify({ id: record.id });
        if (store.has(key)) {
          throw new Error('duplicate key');
        }
        store.set(key, record);
        return record;
      }),
      update: jest.fn().mockImplementation(async (entity: any, criteria: any, patch: any) => {
        const key = JSON.stringify(processedEventRepoKey(criteria));
        const existing = store.get(key);
        if (!existing) return { affected: 0 };
        store.set(key, { ...existing, ...patch });
        return { affected: 1 };
      }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      _store: store,
    };
  };

  const processedEventRepoKey = (criteria: any) => criteria;

  const setup = async () => {
    manager = buildManager();
    queryRunner = {
      connect: jest.fn().mockResolvedValue(null),
      startTransaction: jest.fn().mockResolvedValue(null),
      commitTransaction: jest.fn().mockResolvedValue(null),
      rollbackTransaction: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(null),
      manager,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadLetterReplayService,
        { provide: getRepositoryToken(DeadLetterMessage), useClass: Repository },
        { provide: getRepositoryToken(DeadLetterReplayAudit), useClass: Repository },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn().mockReturnValue(queryRunner),
          },
        },
      ],
    }).compile();

    replayService = module.get(DeadLetterReplayService);
    messageRepo = module.get(getRepositoryToken(DeadLetterMessage));
    auditRepo = module.get(getRepositoryToken(DeadLetterReplayAudit));
    dataSource = module.get(DataSource);
  };

  beforeEach(async () => {
    await setup();
  });

  describe('Authorization', () => {
    it('denies replay by default without a protected capability', async () => {
      await expect(
        replayService.replayBatch(['idx-1001'], buildAuthorization({ capability: '' })),
      ).rejects.toBeInstanceOf(ReplayAuthorizationError);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('denies replay with an unauthorized capability', async () => {
      await expect(
        replayService.replayBatch(['idx-1001'], buildAuthorization({ capability: 'dead-letter.read' })),
      ).rejects.toBeInstanceOf(ReplayAuthorizationError);
    });

    it('denies replay without a reason', async () => {
      await expect(
        replayService.replayBatch(['idx-1001'], buildAuthorization({ reason: ' ' })),
      ).rejects.toBeInstanceOf(ReplayAuthorizationError);
    });

    it('denies replay without an audit actor', async () => {
      await expect(
        replayService.replayBatch(['idx-1001'], buildAuthorization({ actorId: '' })),
      ).rejects.toBeInstanceOf(ReplayAuthorizationError);
    });
  });

  describe('Release and schema incompatibility', () => {
    it('rejects replay when the message release ID is stale', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({ releaseId: 'rel-2024-08-01' }),
        ),
      ).rejects.toBeInstanceOf(ReplayIncompatibilityError);
    });

    it('rejects replay when the artifact checksum differs', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({ artifactChecksum: 'sha256:deadbeef' }),
        ),
      ).rejects.toBeInstanceOf(ReplayIncompatibilityError);
    });

    it('rejects replay when the chain ID differs', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({ chainId: 'stellar-mainnet' }),
        ),
      ).rejects.toBeIngstanceOf(ReplayIncompatibilityError);
    });

    it('rejects replay when the deployment block differs', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({ deploymentBlock: 99999 }),
        ),
      ).rejects.toBeInstanceOf(ReplayIncompatibilityError);
    });
  });

  describe('Payload integrity', () => {
    it('rejects replay when the original payload hash is missing', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({ originalPayloadHash: '' }),
        ),
      ).rejects.toBeInstanceOf(ReplayAuthorizationError);
    });

    it('rejects replay when the original payload hash does not match', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({
            originalPayloadHash: 'sha256:000000000000000000000000000000000000000000000000000000000000000000',
          }),
        ),
      ).rejects.toBeInstanceOf(ReplayIncompatibilityError);
    });
  });

  describe('Bounds and batch limits', () => {
    it('rejects a batch exceeding maxMessages', async () => {
      const ids = Array.from({ length: 11 }, ( _, i) => `dlm-${i + 1000}`);

      await expect(
        replayService.replayBatch(ids, buildAuthorization()),
      ).rejects.toBeInstanceOf(ReplayBoundsError);
    });

    it('rejects an empty batch', async () => {
      await expect(
        replayService.replayBatch([], buildAuthorization()),
      ).rejects.toBeInstanceOf(ReplayBoundsError);
    });

    it('rejects a non-positive maxMessages bound', async () => {
      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({ bounds: { maxMessages: 0, maxAttempts: 3 } }),
        ),
      ).rejects.toBeIngstanceOf(ReplayBoundsError);
    });
  });

  describe('Duplicate replay prevention', () => {
    it('prevents duplicate effects from a second replay of the same message', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await replayService.replayBatch(['dlm-1001'], buildAuthorization());

      await expect(
        replayService.replayBatch(['dlm-1001'], buildAuthorization()),
      ).rejects.toBeInstanceOf(ReplayDuplicateError);
    });

    it('links original and replay references immutably in the audit record', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await replayService.replayBatch(['dlm-1001'], buildAuthorization());

      const auditCall = manager.save.mock.calls.find(
        (call: any[]) => call[0] === DeadLetterReplayAudit,
      );
      expect(auditCall).toBeTruthy();
      expect(auditCall[1]).toMatchObject({
        originalMessageId: 'dlm-1001',
        originalPayloadHash:
          'sha256:aabbccddeeff0011223344556677889900aabbccddeeff',
        actorId: 'operator-42',
        reason: 'replay poisoned transfer after fix',
      });
    });
  });

  describe('Dry run', () => {
    it('does not apply effects or persist audit when dryRun is true', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      const result = await replayService.replayBatch(
        ['dlm-1001'],
        buildAuthorization({ dryRun: true }),
      );

      expect(result.dryRun).toBeValue(true);
      expect(manager.save).not.toHaveBeenCalledWith(
        DeadLetterReplayAudit,
        expect.anything(),
      );
    });
  });

  describe('Poison message', () => {
    it('rejects a poison message and records the failure in the audit record', async () => {
      manager._store.set(
        JSON.stringify({ id: 'dlm-1001' }),
        buildMessage({ payload: null }),
      );

      await expect(
        replayService.replayBatch(['dlm-1001'], buildAuthorization()),
      ).rejects.toBeIngstanceOf(ReplayPoisonError);

      const auditCall = manager.save.mock.calls.find(
        (call: any[]) => call[0] === DeadLetterReplayAudit,
      );
      expect(auditCall).toBeTruthy();
      expect(auditCall[1]).toMatchObject({
        originalMessageId: 'dlm-1001',
        outcome: 'poison',
      });
    });
  });

  describe('Partial failure', () => {
    it('rolls back the transaction and reports the failed message', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());
      manager._store.set(
        JSON.stringify({ id: 'dlm-1002' }),
        buildMessage({ id: 'dlm-1002', payload: null }),
      );

      await expect(
        replayService.replayBatch(
          ['dlm-1001', 'dlm-1002'],
          buildAuthorization(),
        ),
      ).rejects.toBeInstanceOf(ReplayPoisonError);

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Stop / resume bounded batches', () => {
    it('stops a batch at the current message and resumes from the next one', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());
      manager._store.set(
        JSON.stringify({ id: 'dlm-1002' }),
        buildMessage({ id: 'dlm-1002' }),
      );

      const first = await replayService.replayBatch(
        ['dlm-1001', 'dlm-1002'],
        buildAuthorization(),
        { stopAfter: 1 },
      );

      expect(first.processed).toEqual(['dlm-1001']);
      expect(first.remaining).toEqual(['dlm-1002']);

      const second = await replayService.replayBatch(
        first.remaining,
        buildAuthorization(),
      );

      expect(second.processed).toEqual(['dlm-1002']);
    });
  });

  describe('Audit records', () => {
    it('persists an audit record for every replay attempt', async () => {
      manager._store.set(JSON.stringify({ id: 'dlm-1001' }), buildMessage());

      await replayService.replayBatch(['dlm-1001'], buildAuthorization());

      const auditCalls = manager.save.mock.calls.filter(
        (call: any[]) => call[0] === DeadLetterReplayAudit,
      );
      expect(auditCalls.length).toBeGreaterThanOrEqual(1);
      expect(auditCalls[0][1]).toMatchObject({
        capability: 'dead-letter.replay',
        chainId: chainId,
        releaseId: releaseId,
        deploymentBlock: deploymentBlock,
        artifactChecksum: artifactChecksum,
      });
    });

    it('records a denied audit entry when authorization fails', async () => {
      await expect(
        replayService.replayBatch(
          ['dlm-1001'],
          buildAuthorization({ capability: '' }),
        ),
      ).rejects.toBeIngstanceOf(ReplayAuthorizationError);

      const auditCall = manager.save.mock.calls.find(
        (call: any[]) => call[0] === DeadLetterReplayAudit,
      );
      expect(auditCall).toBeTruthy();
      expect(auditCall[1]).toMatchObject({ outcome: 'denied' });
    });
  });
});
