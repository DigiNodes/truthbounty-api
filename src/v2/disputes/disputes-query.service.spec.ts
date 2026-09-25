import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { DisputesQueryService } from './disputes-query.service';
import { ProjectDispute, DisputeStatus } from './entities/project-dispute.entity';
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

function makeDispute(overrides: Partial<ProjectDispute> = {}): ProjectDispute {
  return {
    disputeId: 'claim-1:round-1',
    claimId: 'claim-1',
    originalRoundId: 'round-1',
    appealRoundId: null,
    challengeBond: null,
    challengeBondAsset: null,
    status: DisputeStatus.RAISED,
    deadline: null,
    resolvedOutcome: null,
    dataState: DataState.OBSERVED,
    blockNumber: '100',
    eventTxHash: '0x' + 'a'.repeat(64),
    eventLogIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as ProjectDispute;
}

function queryBuilderMock(getManyResult: unknown[]) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(getManyResult),
  };
}

describe('DisputesQueryService', () => {
  let service: DisputesQueryService;
  let disputeRepo: Repository<ProjectDispute>;
  let checkpointRepo: Repository<EventCheckpoint>;
  let finalityPolicy: FinalityPolicyService;

  beforeEach(() => {
    disputeRepo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
    } as unknown as Repository<ProjectDispute>;
    checkpointRepo = { findOne: jest.fn() } as unknown as Repository<EventCheckpoint>;
    finalityPolicy = buildFinalityPolicy();
    service = new DisputesQueryService(disputeRepo, checkpointRepo, finalityPolicy);
  });

  describe('listForClaim', () => {
    it('throws BadRequestException when claimId is missing', async () => {
      await expect(service.listForClaim('')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when limit is out of bounds (boundary)', async () => {
      await expect(service.listForClaim('claim-1', 0)).rejects.toThrow(BadRequestException);
      await expect(service.listForClaim('claim-1', 101)).rejects.toThrow(BadRequestException);
    });

    it('fetches the checkpoint exactly once per call, regardless of row count (N+1 regression guard)', async () => {
      const disputes = [
        makeDispute({ disputeId: 'd1', blockNumber: '50' }),
        makeDispute({ disputeId: 'd2', blockNumber: '90' }),
        makeDispute({ disputeId: 'd3', blockNumber: '200' }),
      ];
      jest.spyOn(disputeRepo, 'createQueryBuilder').mockReturnValue(queryBuilderMock(disputes) as any);
      const checkpointSpy = jest
        .spyOn(checkpointRepo, 'findOne')
        .mockResolvedValue({ lastSafeBlock: '150', lastFinalizedBlock: '80' } as EventCheckpoint);

      const result = await service.listForClaim('claim-1', 20);

      expect(checkpointSpy).toHaveBeenCalledTimes(1);
      expect(result.items.map((d) => d.computedDataState)).toEqual([
        DataState.FINALIZED,
        DataState.SAFE,
        DataState.OBSERVED,
      ]);
    });

    it('returns OBSERVED for all rows when no checkpoint exists yet', async () => {
      jest
        .spyOn(disputeRepo, 'createQueryBuilder')
        .mockReturnValue(queryBuilderMock([makeDispute()]) as any);
      jest.spyOn(checkpointRepo, 'findOne').mockResolvedValue(null);

      const result = await service.listForClaim('claim-1', 20);
      expect(result.items[0].computedDataState).toBe(DataState.OBSERVED);
    });
  });

  describe('getByOriginalRound', () => {
    it('throws NotFoundException when the dispute does not exist', async () => {
      jest.spyOn(disputeRepo, 'findOne').mockResolvedValue(null);
      await expect(service.getByOriginalRound('claim-1', 'round-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the dispute with computedDataState', async () => {
      jest.spyOn(disputeRepo, 'findOne').mockResolvedValue(makeDispute({ blockNumber: '80' }));
      jest
        .spyOn(checkpointRepo, 'findOne')
        .mockResolvedValue({ lastSafeBlock: '150', lastFinalizedBlock: '80' } as EventCheckpoint);

      const result = await service.getByOriginalRound('claim-1', 'round-1');
      expect(result.computedDataState).toBe(DataState.FINALIZED);
    });
  });
});
