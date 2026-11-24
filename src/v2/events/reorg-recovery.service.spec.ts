import { ReorgRecoveryService } from './reorg-recovery.service';
import { ReorgRecoveryStatus } from './interfaces/reorg-recovery.interface';
import { ReorgRollbackService } from './reorg-rollback.service';
import { EventCheckpoint } from './entities/event-checkpoint.entity';

describe('ReorgRecoveryService — V2-BE-003 (#598)', () => {
  let service: ReorgRecoveryService;
  let checkpointRepo: { findOne: jest.Mock; save: jest.Mock };
  let rollbackService: {
    rollback: jest.Mock;
    reapplyLogs: jest.Mock;
  };

  const makeCheckpoint = (
    overrides: Partial<EventCheckpoint> = {},
  ): EventCheckpoint =>
    ({
      id: 'cp-1',
      chainId: 10,
      contractAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      lastSafeBlock: '100',
      lastSafeBlockHash: '0xsafe100',
      lastFinalizedBlock: '98',
      lastFinalizedBlockHash: '0xfin98',
      updatedAt: new Date(),
      ...overrides,
    }) as EventCheckpoint;

  beforeEach(() => {
    checkpointRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (c) => c),
    };
    rollbackService = {
      rollback: jest.fn().mockResolvedValue({}),
      reapplyLogs: jest.fn().mockResolvedValue({}),
    };

    service = new ReorgRecoveryService(
      checkpointRepo as any,
      rollbackService as unknown as ReorgRollbackService,
    );
  });

  describe('detectAndRecover — no reorg', () => {
    it('advances checkpoint without rollback when parent hash matches', async () => {
      checkpointRepo.findOne.mockResolvedValue(
        makeCheckpoint({ lastFinalizedBlockHash: '0xparent100' }),
      );

      await service.detectAndRecover(
        10,
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        100n,
        '0xblock101',
        '0xparent100',
      );

      expect(rollbackService.rollback).not.toHaveBeenCalled();
      expect(checkpointRepo.save).toHaveBeenCalledTimes(1);
      const saved = checkpointRepo.save.mock.calls[0][0];
      expect(saved.lastSafeBlockHash).toBe('0xblock101');
      expect(saved.lastFinalizedBlockHash).toBe('0xblock101');
      expect(service.getStatus(10).status).toBe(ReorgRecoveryStatus.HEALTHY);
    });

    it('does nothing when no checkpoint exists yet', async () => {
      checkpointRepo.findOne.mockResolvedValue(null);

      await service.detectAndRecover(
        10,
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        100n,
        '0xblock101',
        '0xparent100',
      );

      expect(rollbackService.rollback).not.toHaveBeenCalled();
      expect(checkpointRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('detectAndRecover — one-block fork', () => {
    it('detects, rolls back, replays, and marks recovered for a 1-block reorg', async () => {
      // Recorded finalized block: 98 (hash 0xfin98). Incoming chain has
      // block 99 with parentHash 0xNEWparent99 — meaning block 98's hash
      // is now different, so a reorg at height 98 happened.
      checkpointRepo.findOne.mockResolvedValue(
        makeCheckpoint({ lastFinalizedBlockHash: '0xfin98' }),
      );

      await service.detectAndRecover(
        10,
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        99n,
        '0xNEWblock99',
        '0xNEWparent99',
        [{ blockNumber: 99n, logIndex: 0 }],
      );

      expect(rollbackService.rollback).toHaveBeenCalledTimes(1);
      expect(rollbackService.rollback).toHaveBeenCalledWith(
        10,
        99n,
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      );
      expect(rollbackService.reapplyLogs).toHaveBeenCalledWith([
        { blockNumber: 99n, logIndex: 0 },
      ]);

      const saved = checkpointRepo.save.mock.calls[0][0];
      expect(saved.lastFinalizedBlock).toBe('99');
      expect(saved.lastFinalizedBlockHash).toBe('0xNEWblock99');

      const status = service.getStatus(10);
      expect(status.status).toBe(ReorgRecoveryStatus.RECOVERED);
      expect(status.reorgDepth).toBe(1);
      expect(status.recoveredAt).toBeInstanceOf(Date);
    });
  });

  describe('detectAndRecover — multi-block fork', () => {
    it('detects, rolls back, replays, and marks recovered for a 3-block reorg', async () => {
      checkpointRepo.findOne.mockResolvedValue(
        makeCheckpoint({ lastFinalizedBlockHash: '0xfin98' }),
      );

      await service.detectAndRecover(
        10,
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        101n,
        '0xNEWblock101',
        '0xNEWparent101',
      );

      expect(rollbackService.rollback).toHaveBeenCalledWith(
        10,
        101n,
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      );
      const status = service.getStatus(10);
      expect(status.status).toBe(ReorgRecoveryStatus.RECOVERED);
      expect(status.reorgDepth).toBe(3);
    });
  });

  describe('detectAndRecover — deep-reorg fail-closed', () => {
    it('throws and stops readiness when reorg depth exceeds MAX_REORG_HORIZON', async () => {
      checkpointRepo.findOne.mockResolvedValue(
        makeCheckpoint({ lastFinalizedBlock: '100' }),
      );

      // Incoming block is 200 → depth 100 > 64
      await expect(
        service.detectAndRecover(
          10,
          '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          200n,
          '0xNEWblock200',
          '0xNEWparent200',
        ),
      ).rejects.toThrow(/Deep reorg detected/);

      expect(rollbackService.rollback).not.toHaveBeenCalled();
      const status = service.getStatus(10);
      expect(status.status).toBe(ReorgRecoveryStatus.STOPPED_DEEP_REORG);
      expect(status.reorgDepth).toBe(100);
    });
  });

  describe('detectAndRecover — replay failure', () => {
    it('marks STOPPED_AMBIGUOUS if replay throws mid-recovery', async () => {
      checkpointRepo.findOne.mockResolvedValue(
        makeCheckpoint({ lastFinalizedBlockHash: '0xfin98' }),
      );
      rollbackService.reapplyLogs.mockRejectedValueOnce(
        new Error('projector crash'),
      );

      await expect(
        service.detectAndRecover(
          10,
          '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          99n,
          '0xNEWblock99',
          '0xNEWparent99',
        ),
      ).rejects.toThrow('projector crash');

      const status = service.getStatus(10);
      expect(status.status).toBe(ReorgRecoveryStatus.STOPPED_AMBIGUOUS);
      expect(status.reason).toBe('Recovery execution failed');
    });
  });

  describe('duplicate notification — no double rollback', () => {
    it('does not rollback twice when the same block is re-delivered', async () => {
      const checkpoint = makeCheckpoint({ lastFinalizedBlockHash: '0xfin98' });
      checkpointRepo.findOne.mockResolvedValue(checkpoint);

      // First delivery: block 99 with parent 0xNEWparent99 → reorg path.
      await service.detectAndRecover(
        10, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        99n, '0xNEWblock99', '0xNEWparent99',
      );
      expect(rollbackService.rollback).toHaveBeenCalledTimes(1);

      // After the first call, the checkpoint's finalized hash is 0xNEWblock99.
      // A redelivery of the SAME block 99 should now have parentHash ==
      // 0xNEWblock99 (the newly-recorded finalized hash) — i.e., no reorg.
      await service.detectAndRecover(
        10, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        100n, '0xNEWblock100', '0xNEWblock99',
      );
      // No second rollback.
      expect(rollbackService.rollback).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery digest — stable audit reference', () => {
    it('exposes recoveredAt + fork metadata after recovery', async () => {
      checkpointRepo.findOne.mockResolvedValue(
        makeCheckpoint({ lastFinalizedBlockHash: '0xfin98' }),
      );

      await service.detectAndRecover(
        10, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        99n, '0xNEWblock99', '0xNEWparent99',
      );

      const status = service.getStatus(10);
      expect(status.status).toBe(ReorgRecoveryStatus.RECOVERED);
      expect(status.recoveredAt).toBeInstanceOf(Date);
      expect(status.forkBlockHash).toBeDefined();
    });
  });

  describe('getStatus — default', () => {
    it('returns HEALTHY for a chain with no recorded events', () => {
      const status = service.getStatus(999);
      expect(status.status).toBe(ReorgRecoveryStatus.HEALTHY);
      expect(status.detectedAt).toBeNull();
      expect(status.recoveredAt).toBeNull();
    });
  });
});
