import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectDispute } from './entities/project-dispute.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { DataState } from '../common/data-state.enum';
import { CursorPage, encodeCursor, decodeCursor } from '../common/cursor-pagination';
import { FinalityPolicyService } from '../../config/finality-policy.service';

@Injectable()
export class DisputesQueryService {
  constructor(
    @InjectRepository(ProjectDispute)
    private readonly disputeRepo: Repository<ProjectDispute>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
    private readonly finalityPolicy: FinalityPolicyService,
  ) {}

  /**
   * Fetch the latest checkpoint once (assuming single chain for simplicity)
   * so callers can classify a whole batch of rows without re-querying per row.
   */
  private async getLatestCheckpoint(): Promise<EventCheckpoint | null> {
    return this.checkpointRepo.findOne({
      order: { updatedAt: 'DESC' },
      take: 1,
    });
  }

  async listForClaim(
    claimId: string,
    limit = 20,
    cursor?: string,
  ): Promise<CursorPage<ProjectDispute & { computedDataState: DataState }>> {
    if (!claimId) {
      throw new BadRequestException('claimId is required');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    // Fail closed: dispute state is protocol state, so it is only served
    // while the projection provably reproduces canonical events.
    await this.readiness.assertReady(V2_PROJECTORS.DISPUTES);

    const decoded = cursor ? decodeCursor(cursor) : null;

    const query = this.disputeRepo
      .createQueryBuilder('dispute')
      .where('dispute.claimId = :claimId', { claimId })
      .orderBy('dispute.blockNumber', 'ASC')
      .addOrderBy('dispute.eventLogIndex', 'ASC');

    if (decoded) {
      query.andWhere(
        '(dispute.blockNumber > :blockNumber OR ' +
          '(dispute.blockNumber = :blockNumber AND dispute.eventLogIndex > :logIndex))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex },
      );
    }

    const disputes = await query.limit(limit).getMany();

    // Single checkpoint fetch for the whole page (was previously re-fetched
    // once per row via a private calculateDataState — an N+1).
    const checkpoint = await this.getLatestCheckpoint();
    const disputesWithState = disputes.map((dispute) => ({
      ...dispute,
      computedDataState: this.finalityPolicy.classifyByCheckpoint(dispute.blockNumber, checkpoint),
    }));
    
    // Generate next cursor
    const nextCursor =
      disputesWithState.length === limit
        ? encodeCursor({
            blockNumber:
              disputesWithState[disputesWithState.length - 1].blockNumber ??
              '0',
            logIndex:
              disputesWithState[disputesWithState.length - 1].eventLogIndex,
            id: disputesWithState[disputesWithState.length - 1].disputeId,
          })
        : null;

    return {
      items: disputesWithState,
      nextCursor,
    };
  }

  async getByOriginalRound(
    claimId: string,
    originalRoundId: string,
  ): Promise<ProjectDispute & { computedDataState: DataState }> {
    // Fail closed: see listForClaim.
    await this.readiness.assertReady(V2_PROJECTORS.DISPUTES);

    const disputeId = `${claimId}:${originalRoundId}`;
    const dispute = await this.disputeRepo.findOne({ where: { disputeId } });
    if (!dispute)
      throw new NotFoundException(
        `No dispute projected for round ${originalRoundId} on claim ${claimId}`,
      );
    const checkpoint = await this.getLatestCheckpoint();
    const computedDataState = this.finalityPolicy.classifyByCheckpoint(dispute.blockNumber, checkpoint);
    return {
      ...dispute,
      computedDataState,
    };
  }
}
