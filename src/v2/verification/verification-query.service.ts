import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ProjectVerificationRound,
  RoundType,
} from './entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './entities/project-participant-position.entity';

@Injectable()
export class VerificationQueryService {
  constructor(
    @InjectRepository(ProjectVerificationRound)
    private readonly roundRepo: Repository<ProjectVerificationRound>,
    @InjectRepository(ProjectParticipantPosition)
    private readonly positionRepo: Repository<ProjectParticipantPosition>,
  ) {}

  /** First-round and appeal-round records are always returned separately. */
  async listRounds(claimId: string): Promise<{
    first: ProjectVerificationRound[];
    appeal: ProjectVerificationRound[];
  }> {
    const rounds = await this.roundRepo.find({
      where: { claimId },
      order: { roundNumber: 'ASC' },
    });
    return {
      first: rounds.filter((r) => r.roundType === RoundType.FIRST),
      appeal: rounds.filter((r) => r.roundType === RoundType.APPEAL),
    };
  }

  async getRound(roundId: string): Promise<ProjectVerificationRound> {
    const round = await this.roundRepo.findOne({ where: { roundId } });
    if (!round)
      throw new NotFoundException(
        `No verification round projected for id ${roundId}`,
      );
    return round;
  }

  async listPositions(roundId: string): Promise<ProjectParticipantPosition[]> {
    return this.positionRepo.find({
      where: { roundId },
      order: { createdAt: 'ASC' },
    });
  }
}
