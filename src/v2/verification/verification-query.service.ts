import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ProjectVerificationRound,
  RoundType,
} from './entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './entities/project-participant-position.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { DataState } from '../common/data-state.enum';
import {
  CursorPage,
  clampPageSize,
  decodeCursor,
  pageResult,
} from '../common/cursor-pagination';


@Injectable()
export class VerificationQueryService {
  constructor(
    @InjectRepository(ProjectVerificationRound)
    private readonly roundRepo: Repository<ProjectVerificationRound>,
    @InjectRepository(ProjectParticipantPosition)
    private readonly positionRepo: Repository<ProjectParticipantPosition>,
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

  /** First-round and appeal-round records are always returned separately with cursor pagination. */
  async listRounds(
    claimId: string,
    limit = 20,
    cursor?: string,
  ): Promise<{
    firstInstanceRounds: CursorPage<ProjectVerificationRound & { computedDataState: DataState }>;
    appealRounds: CursorPage<ProjectVerificationRound & { computedDataState: DataState }>;
  }> {
    if (!claimId) {
      throw new BadRequestException('claimId is required');
    }

    const pageSize = clampPageSize(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;

    // Get first instance rounds with pagination
    const firstRoundQuery = this.roundRepo.createQueryBuilder('round')
      .where('round.claimId = :claimId', { claimId })
      .andWhere('round.roundType = :type', { type: RoundType.FIRST })
      .orderBy('round.openedAtBlock', 'ASC')
      .addOrderBy('round.eventLogIndex', 'ASC')
      .addOrderBy('round.roundId', 'ASC')
      .limit(pageSize + 1);

    if (decoded) {
      firstRoundQuery.andWhere(
        '(round.openedAtBlock > :blockNumber OR ' +
        '(round.openedAtBlock = :blockNumber AND round.eventLogIndex > :logIndex) OR ' +
        '(round.openedAtBlock = :blockNumber AND round.eventLogIndex = :logIndex AND round.roundId > :id))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex, id: decoded.id }
      );
    }

    const firstRounds = await firstRoundQuery.getMany();

    // Calculate data states for first rounds
    const firstRoundsWithState = await Promise.all(
      firstRounds.map(async (round) => ({
        ...round,
        computedDataState: await this.calculateDataState(round.openedAtBlock),
      }))
    );

    // Get appeal rounds
    const appealRoundQuery = this.roundRepo.createQueryBuilder('round')
      .where('round.claimId = :claimId', { claimId })
      .andWhere('round.roundType = :type', { type: RoundType.APPEAL })
      .orderBy('round.openedAtBlock', 'ASC')
      .addOrderBy('round.eventLogIndex', 'ASC')
      .addOrderBy('round.roundId', 'ASC')
      .limit(pageSize + 1);

    if (decoded) {
      appealRoundQuery.andWhere(
        '(round.openedAtBlock > :blockNumber OR ' +
        '(round.openedAtBlock = :blockNumber AND round.eventLogIndex > :logIndex) OR ' +
        '(round.openedAtBlock = :blockNumber AND round.eventLogIndex = :logIndex AND round.roundId > :id))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex, id: decoded.id }
      );
    }

    const appealRounds = await appealRoundQuery.getMany();

    // Calculate data states for appeal rounds
    const appealRoundsWithState = await Promise.all(
      appealRounds.map(async (round) => ({
        ...round,
        computedDataState: await this.calculateDataState(round.openedAtBlock),
      }))
    );

    return {
      firstInstanceRounds: pageResult(firstRoundsWithState, pageSize, (round) => ({
        blockNumber: round.openedAtBlock,
        logIndex: round.eventLogIndex,
        id: round.roundId,
      })),
      appealRounds: pageResult(appealRoundsWithState, pageSize, (round) => ({
        blockNumber: round.openedAtBlock,
        logIndex: round.eventLogIndex,
        id: round.roundId,
      })),
    };
  }

  async getRound(roundId: string): Promise<ProjectVerificationRound & { computedDataState: DataState }> {
    if (!roundId) {
      throw new BadRequestException('roundId is required');
    }
    
    const round = await this.roundRepo.findOne({ where: { roundId } });
    if (!round) {
      throw new NotFoundException(`No verification round projected for id ${roundId}`);
    }
    
    const computedDataState = await this.calculateDataState(round.openedAtBlock);
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
  ): Promise<CursorPage<ProjectParticipantPosition & { computedDataState: DataState }>> {
    if (!roundId) {
      throw new BadRequestException('roundId is required');
    }

    const pageSize = clampPageSize(limit);
    const decoded = cursor ? decodeCursor(cursor) : null;

    const query = this.positionRepo.createQueryBuilder('position')
      .where('position.roundId = :roundId', { roundId })
      .orderBy('position.blockNumber', 'ASC')
      .addOrderBy('position.eventLogIndex', 'ASC')
      .addOrderBy('position.id', 'ASC')
      .limit(pageSize + 1);

    if (decoded) {
      query.andWhere(
        '(position.blockNumber > :blockNumber OR ' +
        '(position.blockNumber = :blockNumber AND position.eventLogIndex > :logIndex) OR ' +
        '(position.blockNumber = :blockNumber AND position.eventLogIndex = :logIndex AND position.id > :id))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex, id: decoded.id }
      );
    }

    const positions = await query.getMany();

    // Add computed data states
    const positionsWithState = await Promise.all(
      positions.map(async (pos) => ({
        ...pos,
        computedDataState: await this.calculateDataState(pos.blockNumber),
      }))
    );

    return pageResult(positionsWithState, pageSize, (pos) => ({
      blockNumber: pos.blockNumber,
      logIndex: pos.eventLogIndex,
      id: pos.id,
    }));
  }
}