import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectDispute } from './entities/project-dispute.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import {
  CursorPage,
  encodeCursor,
  decodeCursor,
} from '../common/cursor-pagination';
import { FinalityPolicyService } from '../../config/finality-policy.service';
import {
  toDisputeLifecycleView,
  DisputeLifecycleView,
} from './dispute-lifecycle';

/**
 * Read-side dispute queries.
 * PREWAVE-BE-066: responses use phase-separated lifecycle views so provisional
 * data is never serialized as final, and chain DataState is not confused with
 * dispute finality.
 */
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
   * Fetch the latest checkpoint once so a page of rows is classified without
   * an N+1 query per row.
   */
  private async getLatestCheckpoint(): Promise<EventCheckpoint | null> {
    return this.checkpointRepo.findOne({
      order: { updatedAt: 'DESC' },
    });
  }

  async listForClaim(
    claimId: string,
    limit = 20,
    cursor?: string,
  ): Promise<CursorPage<DisputeLifecycleView>> {
    if (!claimId) {
      throw new BadRequestException('claimId is required');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

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
    const checkpoint = await this.getLatestCheckpoint();

    const items: DisputeLifecycleView[] = disputes.map((dispute) => {
      const chainDataState = this.finalityPolicy.classifyByCheckpoint(
        dispute.blockNumber,
        checkpoint,
      );
      return toDisputeLifecycleView(dispute, chainDataState);
    });

    // Cursor keys still come from the projected row (canonical ordering), not
    // from the lifecycle DTO shape.
    const last = disputes.length === limit ? disputes[disputes.length - 1] : null;
    const nextCursor = last
      ? encodeCursor({
          blockNumber: last.blockNumber,
          logIndex: last.eventLogIndex,
          id: last.disputeId,
        })
      : null;

    return {
      items,
      nextCursor,
    };
  }

  async getByOriginalRound(
    claimId: string,
    originalRoundId: string,
  ): Promise<DisputeLifecycleView> {
    const disputeId = `\( {claimId}: \){originalRoundId}`;
    const dispute = await this.disputeRepo.findOne({ where: { disputeId } });
    if (!dispute) {
      throw new NotFoundException(
        `No dispute projected for round ${originalRoundId} on claim ${claimId}`,
      );
    }

    const checkpoint = await this.getLatestCheckpoint();
    const chainDataState = this.finalityPolicy.classifyByCheckpoint(
      dispute.blockNumber,
      checkpoint,
    );

    return toDisputeLifecycleView(dispute, chainDataState);
  }
                                    }
