import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectDispute } from './entities/project-dispute.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { DataState } from '../common/data-state.enum';
import {
  CursorPage,
  clampPageSize,
  decodeCursor,
  pageResult,
} from '../common/cursor-pagination';

@Injectable()
export class DisputesQueryService {
  constructor(
    @InjectRepository(ProjectDispute)
    private readonly disputeRepo: Repository<ProjectDispute>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
  ) {}

  /**
   * Calculate the data state for a block number based on chain's safe and finalized blocks
   */
  private async calculateDataState(blockNumber: string): Promise<DataState> {
    // Get the latest checkpoint (assuming single chain for simplicity)
    const checkpoints = await this.checkpointRepo.find({
      order: { updatedAt: 'DESC' },
      take: 1,
    });
    const checkpoint = checkpoints[0];

    if (!checkpoint) {
      return DataState.OBSERVED;
    }

    const blockNum = BigInt(blockNumber);
    const lastSafe = BigInt(checkpoint.lastSafeBlock);
    const lastFinalized = BigInt(checkpoint.lastFinalizedBlock);

    if (blockNum <= lastFinalized) {
      return DataState.FINALIZED;
    } else if (blockNum <= lastSafe) {
      return DataState.SAFE;
    }
    return DataState.OBSERVED;
  }

  async listForClaim(
    claimId: string,
    limit = 20,
    cursor?: string,
  ): Promise<CursorPage<ProjectDispute & { computedDataState: DataState }>> {
    if (!claimId) {
      throw new BadRequestException('claimId is required');
    }

    const pageSize = clampPageSize(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;

    const query = this.disputeRepo.createQueryBuilder('dispute')
      .where('dispute.claimId = :claimId', { claimId })
      .orderBy('dispute.blockNumber', 'ASC')
      .addOrderBy('dispute.eventLogIndex', 'ASC')
      .addOrderBy('dispute.disputeId', 'ASC')
      .limit(pageSize + 1);

    if (decoded) {
      query.andWhere(
        '(dispute.blockNumber > :blockNumber OR ' +
        '(dispute.blockNumber = :blockNumber AND dispute.eventLogIndex > :logIndex) OR ' +
        '(dispute.blockNumber = :blockNumber AND dispute.eventLogIndex = :logIndex AND dispute.disputeId > :id))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex, id: decoded.id }
      );
    }

    const rows = await query.getMany();

    // Add computed data states
    const disputesWithState = await Promise.all(
      rows.map(async (dispute) => ({
        ...dispute,
        computedDataState: await this.calculateDataState(dispute.blockNumber),
      }))
    );

    return pageResult(disputesWithState, pageSize, (dispute) => ({
      blockNumber: dispute.blockNumber,
      logIndex: dispute.eventLogIndex,
      id: dispute.disputeId,
    }));
  }

  async getByOriginalRound(
    claimId: string,
    originalRoundId: string,
  ): Promise<ProjectDispute & { computedDataState: DataState }> {
    const disputeId = `${claimId}:${originalRoundId}`;
    const dispute = await this.disputeRepo.findOne({ where: { disputeId } });
    if (!dispute)
      throw new NotFoundException(
        `No dispute projected for round ${originalRoundId} on claim ${claimId}`,
      );
    const computedDataState = await this.calculateDataState(dispute.blockNumber);
    return {
      ...dispute,
      computedDataState
    };
  }
}