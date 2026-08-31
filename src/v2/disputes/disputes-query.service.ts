import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectDispute } from './entities/project-dispute.entity';

@Injectable()
export class DisputesQueryService {
  constructor(
    @InjectRepository(ProjectDispute)
    private readonly disputeRepo: Repository<ProjectDispute>,
  ) {}

  async listForClaim(claimId: string): Promise<ProjectDispute[]> {
    return this.disputeRepo.find({
      where: { claimId },
      order: { createdAt: 'ASC' },
    });
  }

  async getByOriginalRound(
    claimId: string,
    originalRoundId: string,
  ): Promise<ProjectDispute> {
    const disputeId = `${claimId}:${originalRoundId}`;
    const dispute = await this.disputeRepo.findOne({ where: { disputeId } });
    if (!dispute)
      throw new NotFoundException(
        `No dispute projected for round ${originalRoundId} on claim ${claimId}`,
      );
    return dispute;
  }
}
