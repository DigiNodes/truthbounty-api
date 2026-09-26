import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ProjectVerificationRound,
  RoundType,
} from './entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './entities/project-participant-position.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { DataState } from '../common/data-state.enum';
import { CursorPage, encodeCursor, decodeCursor } from '../common/cursor-pagination';
import { FinalityPolicyService } from '../../config/finality-policy.service';


@Injectable()
export class VerificationQueryService {
  constructor(
    @InjectRepository(ProjectVerificationRound)
    private readonly roundRepo: Repository<ProjectVerificationRound>,
    @InjectRepository(ProjectParticipantPosition)
    private readonly positionRepo: Repository<ProjectParticipantPosition>,
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

  /** First-round and appeal-round records are always returned separately with cursor pagination. */
  async listRounds(
    claimId: string,
    limit = 20,
    cursor?: string,
  ): Promise<{
    firstInstanceRounds: CursorPage<
      ProjectVerificationRound & { computedDataState: DataState }
    >;
    appealRounds: CursorPage<
      ProjectVerificationRound & { computedDataState: DataState }
    >;
  }> {
    if (!claimId) {
      throw new BadRequestException('claimId is required');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    // Fail closed: round state is protocol state, so it is only served while
    // the projection provably reproduces canonical events.
    await this.readiness.assertReady(V2_PROJECTORS.VERIFICATION);

    const decoded = cursor ? decodeCursor(cursor) : null;

    // Get first instance rounds with pagination
    const firstRoundQuery = this.roundRepo
      .createQueryBuilder('round')
      .where('round.claimId = :claimId', { claimId })
      .andWhere('round.roundType = :type', { type: RoundType.FIRST })
      .orderBy('round.openedAtBlock', 'ASC')
      .addOrderBy('round.eventLogIndex', 'ASC');

    if (decoded) {
      firstRoundQuery.andWhere(
        '(round.openedAtBlock > :blockNumber OR ' +
          '(round.openedAtBlock = :blockNumber AND round.eventLogIndex > :logIndex))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex },
      );
    }

    const firstRounds = await firstRoundQuery.limit(limit).getMany();

    // Single checkpoint fetch for the whole request, reused below for both
    // first-instance and appeal rounds (was previously re-fetched once per
    // row via a private calculateDataState — an N+1 against v2_event_checkpoints).
    const checkpoint = await this.getLatestCheckpoint();

    const firstRoundsWithState = firstRounds.map((round) => ({
      ...round,
      computedDataState: this.finalityPolicy.classifyByCheckpoint(round.openedAtBlock, checkpoint),
    }));
    
    // Get appeal rounds
    const appealRoundQuery = this.roundRepo
      .createQueryBuilder('round')
      .where('round.claimId = :claimId', { claimId })
      .andWhere('round.roundType = :type', { type: RoundType.APPEAL })
      .orderBy('round.openedAtBlock', 'ASC')
      .addOrderBy('round.eventLogIndex', 'ASC');

    if (decoded) {
      appealRoundQuery.andWhere(
        '(round.openedAtBlock > :blockNumber OR ' +
          '(round.openedAtBlock = :blockNumber AND round.eventLogIndex > :logIndex))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex },
      );
    }

    const appealRounds = await appealRoundQuery.limit(limit).getMany();

    const appealRoundsWithState = appealRounds.map((round) => ({
      ...round,
      computedDataState: this.finalityPolicy.classifyByCheckpoint(round.openedAtBlock, checkpoint),
    }));
    
    // Generate next cursors
    const firstNextCursor =
      firstRoundsWithState.length === limit
        ? encodeCursor({
            blockNumber:
              firstRoundsWithState[firstRoundsWithState.length - 1]
                .openedAtBlock,
            logIndex:
              firstRoundsWithState[firstRoundsWithState.length - 1]
                .eventLogIndex,
            id: firstRoundsWithState[firstRoundsWithState.length - 1].roundId,
          })
        : null;

    const appealNextCursor =
      appealRoundsWithState.length === limit
        ? encodeCursor({
            blockNumber:
              appealRoundsWithState[appealRoundsWithState.length - 1]
                .openedAtBlock,
            logIndex:
              appealRoundsWithState[appealRoundsWithState.length - 1]
                .eventLogIndex,
            id: appealRoundsWithState[appealRoundsWithState.length - 1].roundId,
          })
        : null;

    return {
      firstInstanceRounds: {
        items: firstRoundsWithState,
        nextCursor: firstNextCursor,
      },
      appealRounds: {
        items: appealRoundsWithState,
        nextCursor: appealNextCursor,
      },
    };
  }

  async getRound(
    roundId: string,
  ): Promise<ProjectVerificationRound & { computedDataState: DataState }> {
    if (!roundId) {
      throw new BadRequestException('roundId is required');
    }

    // Fail closed: see listRounds.
    await this.readiness.assertReady(V2_PROJECTORS.VERIFICATION);

    const round = await this.roundRepo.findOne({ where: { roundId } });
    if (!round) {
      throw new NotFoundException(
        `No verification round projected for id ${roundId}`,
      );
    }
    
    const checkpoint = await this.getLatestCheckpoint();
    const computedDataState = this.finalityPolicy.classifyByCheckpoint(round.openedAtBlock, checkpoint);
    return {
      ...round,
      computedDataState,
    };
  }

  /** Participant positions for a single round, e.g. all stakers on round 123, with cursor pagination. */
  async listPositions(
    roundId: string,
    limit = 20,
    cursor?: string,
  ): Promise<
    CursorPage<ProjectParticipantPosition & { computedDataState: DataState }>
  > {
    if (!roundId) {
      throw new BadRequestException('roundId is required');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    // Fail closed: see listRounds.
    await this.readiness.assertReady(V2_PROJECTORS.VERIFICATION);

    const decoded = cursor ? decodeCursor(cursor) : null;

    const query = this.positionRepo
      .createQueryBuilder('position')
      .where('position.roundId = :roundId', { roundId })
      .orderBy('position.blockNumber', 'ASC')
      .addOrderBy('position.eventLogIndex', 'ASC');

    if (decoded) {
      query.andWhere(
        '(position.blockNumber > :blockNumber OR ' +
          '(position.blockNumber = :blockNumber AND position.eventLogIndex > :logIndex))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex },
      );
    }

    const positions = await query.limit(limit).getMany();

    const checkpoint = await this.getLatestCheckpoint();
    const positionsWithState = positions.map((pos) => ({
      ...pos,
      computedDataState: this.finalityPolicy.classifyByCheckpoint(pos.blockNumber, checkpoint),
    }));
    
    // Generate next cursor
    const nextCursor =
      positionsWithState.length === limit
        ? encodeCursor({
            blockNumber:
              positionsWithState[positionsWithState.length - 1].blockNumber,
            logIndex:
              positionsWithState[positionsWithState.length - 1].eventLogIndex,
            id: positionsWithState[positionsWithState.length - 1].id,
          })
        : null;

    return {
      items: positionsWithState,
      nextCursor,
    };
  }
}
