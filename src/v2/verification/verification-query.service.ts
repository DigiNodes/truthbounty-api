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
import { CursorPage, encodeCursor, decodeCursor } from '../common/cursor-pagination';


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
    const checkpoint = await this.checkpointRepo.findOne({
      order: { updatedAt: 'DESC' },
    });

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
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    const decoded = cursor ? decodeCursor(cursor) : null;
    
    // Get first instance rounds with pagination
    const firstRoundQuery = this.roundRepo.createQueryBuilder('round')
      .where('round.claimId = :claimId', { claimId })
      .andWhere('round.roundType = :type', { type: RoundType.FIRST })
      .orderBy('round.openedAtBlock', 'ASC')
      .addOrderBy('round.eventLogIndex', 'ASC');
    
    if (decoded) {
      firstRoundQuery.andWhere(
        '(round.openedAtBlock > :blockNumber OR ' +
        '(round.openedAtBlock = :blockNumber AND round.eventLogIndex > :logIndex))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex }
      );
    }
    
    const firstRounds = await firstRoundQuery.limit(limit).getMany();
    
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
      .addOrderBy('round.eventLogIndex', 'ASC');
    
    if (decoded) {
      appealRoundQuery.andWhere(
        '(round.openedAtBlock > :blockNumber OR ' +
        '(round.openedAtBlock = :blockNumber AND round.eventLogIndex > :logIndex))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex }
      );
    }
    
    const appealRounds = await appealRoundQuery.limit(limit).getMany();
    
    // Calculate data states for appeal rounds
    const appealRoundsWithState = await Promise.all(
      appealRounds.map(async (round) => ({
        ...round,
        computedDataState: await this.calculateDataState(round.openedAtBlock),
      }))
    );
    
    // Generate next cursors
    const firstNextCursor = firstRoundsWithState.length === limit 
      ? encodeCursor({
          blockNumber: firstRoundsWithState[firstRoundsWithState.length - 1].openedAtBlock,
          logIndex: firstRoundsWithState[firstRoundsWithState.length - 1].eventLogIndex,
          id: firstRoundsWithState[firstRoundsWithState.length - 1].roundId,
        })
      : null;
    
    const appealNextCursor = appealRoundsWithState.length === limit
      ? encodeCursor({
          blockNumber: appealRoundsWithState[appealRoundsWithState.length - 1].openedAtBlock,
          logIndex: appealRoundsWithState[appealRoundsWithState.length - 1].eventLogIndex,
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
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    const decoded = cursor ? decodeCursor(cursor) : null;
    
    const query = this.positionRepo.createQueryBuilder('position')
      .where('position.roundId = :roundId', { roundId })
      .orderBy('position.blockNumber', 'ASC')
      .addOrderBy('position.eventLogIndex', 'ASC');
    
    if (decoded) {
      query.andWhere(
        '(position.blockNumber > :blockNumber OR ' +
        '(position.blockNumber = :blockNumber AND position.eventLogIndex > :logIndex))',
        { blockNumber: decoded.blockNumber, logIndex: decoded.logIndex }
      );
    }
    
    const positions = await query.limit(limit).getMany();
    
    // Add computed data states
    const positionsWithState = await Promise.all(
      positions.map(async (pos) => ({
        ...pos,
        computedDataState: await this.calculateDataState(pos.blockNumber),
      }))
    );
    
    // Generate next cursor
    const nextCursor = positionsWithState.length === limit
      ? encodeCursor({
          blockNumber: positionsWithState[positionsWithState.length - 1].blockNumber,
          logIndex: positionsWithState[positionsWithState.length - 1].eventLogIndex,
          id: positionsWithState[positionsWithState.length - 1].id,
        })
      : null;
    
    return {
      items: positionsWithState,
      nextCursor,
    };
  }
}