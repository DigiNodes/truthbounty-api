import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { VerificationQueryService } from './verification-query.service';
import { ProjectVerificationRound, RoundType } from './entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './entities/project-participant-position.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { FinalityPolicyService } from '../../config/finality-policy.service';
import { DataState } from '../common/data-state.enum';

function buildFinalityPolicy(): FinalityPolicyService {
  const configService = {
    get: jest.fn((key: string, def?: unknown) =>
      ({
        'finalityPolicy.chainId': 10,
        'finalityPolicy.allowedChainIds': [10, 11155420],
        'finalityPolicy.safeConfirmations': 1,
        'finalityPolicy.finalizedConfirmations': 12,
      })[key] ?? def,
    ),
  } as unknown as ConfigService;
  return new FinalityPolicyService(configService);
}

function makeRound(overrides: Partial<ProjectVerificationRound> = {}): ProjectVerificationRound {
  return {
    roundId: 'r1',
    claimId: 'claim-1',
    roundType: RoundType.FIRST,
    roundNumber: 1,
    deadline: null,
    status: 'open',
    openedAtBlock: '100',
    dataState: DataState.OBSERVED,
    totalStake: null,
    totalEffectiveWeight: null,
    roundSnapshot: null,
    appealDeadline: null,
    eventTxHash: '0x' + 'a'.repeat(64),
    eventLogIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProjectVerificationRound;
}

function queryBuilderMock(getManyResults: unknown[][]) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };
  getManyResults.forEach((result) => qb.getMany.mockResolvedValueOnce(result));
  return qb;
}

describe('VerificationQueryService', () => {
  let service: VerificationQueryService;
  let roundRepo: Repository<ProjectVerificationRound>;
  let positionRepo: Repository<ProjectParticipantPosition>;
  let checkpointRepo: Repository<EventCheckpoint>;
  let finalityPolicy: FinalityPolicyService;

  beforeEach(() => {
    roundRepo = { createQueryBuilder: jest.fn(), findOne: jest.fn() } as unknown as Repository<ProjectVerificationRound>;
    positionRepo = { createQueryBuilder: jest.fn() } as unknown as Repository<ProjectParticipantPosition>;
    checkpointRepo = { findOne: jest.fn() } as unknown as Repository<EventCheckpoint>;
    finalityPolicy = buildFinalityPolicy();
    service = new VerificationQueryService(roundRepo, positionRepo, checkpointRepo, finalityPolicy);
  });

  describe('listRounds', () => {
    it('throws BadRequestException when claimId is missing', async () => {
      await expect(service.listRounds('')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when limit is out of bounds (boundary)', async () => {
      await expect(service.listRounds('claim-1', 0)).rejects.toThrow(BadRequestException);
      await expect(service.listRounds('claim-1', 101)).rejects.toThrow(BadRequestException);
    });

    it('accepts the limit boundaries 1 and 100', async () => {
      jest
        .spyOn(roundRepo, 'createQueryBuilder')
        .mockReturnValue(queryBuilderMock([[], []]) as any);
      jest.spyOn(checkpointRepo, 'findOne').mockResolvedValue(null);

      await expect(service.listRounds('claim-1', 1)).resolves.toBeDefined();
    });

    it('fetches the checkpoint exactly once per call, regardless of row count (N+1 regression guard)', async () => {
      const firstRounds = [
        makeRound({ roundId: 'f1', openedAtBlock: '50' }),
        makeRound({ roundId: 'f2', openedAtBlock: '90' }),
      ];
      const appealRounds = [
        makeRound({ roundId: 'a1', roundType: RoundType.APPEAL, openedAtBlock: '200' }),
      ];
      jest
        .spyOn(roundRepo, 'createQueryBuilder')
        .mockReturnValue(queryBuilderMock([firstRounds, appealRounds]) as any);
      const checkpointSpy = jest
        .spyOn(checkpointRepo, 'findOne')
        .mockResolvedValue({ lastSafeBlock: '150', lastFinalizedBlock: '80' } as EventCheckpoint);

      const result = await service.listRounds('claim-1', 20);

      // One checkpoint fetch for the whole request (both first + appeal groups),
      // not once per row across 3 total rows.
      expect(checkpointSpy).toHaveBeenCalledTimes(1);
      expect(result.firstInstanceRounds.items.map((r) => r.computedDataState)).toEqual([
        DataState.FINALIZED, // 50 <= lastFinalizedBlock(80)
        DataState.SAFE, // 80 < 90 <= lastSafeBlock(150)
      ]);
      expect(result.appealRounds.items[0].computedDataState).toBe(DataState.OBSERVED); // 200 > 150
    });
  });

  describe('getRound', () => {
    it('throws BadRequestException when roundId is missing', async () => {
      await expect(service.getRound('')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when the round does not exist', async () => {
      jest.spyOn(roundRepo, 'findOne').mockResolvedValue(null);
      await expect(service.getRound('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the round with computedDataState', async () => {
      jest.spyOn(roundRepo, 'findOne').mockResolvedValue(makeRound({ openedAtBlock: '80' }));
      jest
        .spyOn(checkpointRepo, 'findOne')
        .mockResolvedValue({ lastSafeBlock: '150', lastFinalizedBlock: '80' } as EventCheckpoint);

      const result = await service.getRound('r1');
      expect(result.computedDataState).toBe(DataState.FINALIZED);
    });
  });

  describe('listPositions', () => {
    it('throws BadRequestException when roundId is missing', async () => {
      await expect(service.listPositions('')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when limit is out of bounds (boundary)', async () => {
      await expect(service.listPositions('r1', -1)).rejects.toThrow(BadRequestException);
    });

    it('fetches the checkpoint exactly once for the whole page (N+1 regression guard)', async () => {
      const positions = Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`,
        roundId: 'r1',
        blockNumber: String(50 + i),
        eventLogIndex: i,
      })) as unknown as ProjectParticipantPosition[];
      jest
        .spyOn(positionRepo, 'createQueryBuilder')
        .mockReturnValue(queryBuilderMock([positions]) as any);
      const checkpointSpy = jest
        .spyOn(checkpointRepo, 'findOne')
        .mockResolvedValue({ lastSafeBlock: '150', lastFinalizedBlock: '80' } as EventCheckpoint);

      const result = await service.listPositions('r1', 20);

      expect(checkpointSpy).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(5);
    });

    it('returns OBSERVED for all rows when no checkpoint exists yet', async () => {
      jest
        .spyOn(positionRepo, 'createQueryBuilder')
        .mockReturnValue(
          queryBuilderMock([[{ id: 'p1', roundId: 'r1', blockNumber: '10', eventLogIndex: 0 }]]) as any,
        );
      jest.spyOn(checkpointRepo, 'findOne').mockResolvedValue(null);

      const result = await service.listPositions('r1', 20);
      expect(result.items[0].computedDataState).toBe(DataState.OBSERVED);
    });
  });
});
