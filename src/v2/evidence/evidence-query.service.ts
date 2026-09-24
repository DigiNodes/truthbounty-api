import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectEvidence } from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';
import {
  CursorPage,
  clampPageSize,
  decodeCursor,
  pageResult,
} from '../common/cursor-pagination';

@Injectable()
export class EvidenceQueryService {
  constructor(
    @InjectRepository(ProjectEvidence)
    private readonly evidenceRepo: Repository<ProjectEvidence>,
    @InjectRepository(ProjectEvidenceVersion)
    private readonly versionRepo: Repository<ProjectEvidenceVersion>,
  ) {}

  async getEvidence(claimId: string): Promise<ProjectEvidence> {
    const evidence = await this.evidenceRepo.findOne({ where: { claimId } });
    if (!evidence)
      throw new NotFoundException(`No evidence projected for claim ${claimId}`);
    return evidence;
  }

  async listVersions(
    evidenceId: string,
    cursor?: string,
    limit?: number,
  ): Promise<CursorPage<ProjectEvidenceVersion>> {
    const pageSize = clampPageSize(limit);
    const qb = this.versionRepo
      .createQueryBuilder('v')
      .where('v.evidenceId = :evidenceId', { evidenceId })
      .orderBy('v.blockNumber', 'ASC')
      .addOrderBy('v.eventLogIndex', 'ASC')
      .addOrderBy('v.id', 'ASC')
      .limit(pageSize + 1);

    if (cursor) {
      const key = decodeCursor(cursor);
      qb.andWhere(
        '(v.blockNumber > :blockNumber OR ' +
          '(v.blockNumber = :blockNumber AND v.eventLogIndex > :logIndex) OR ' +
          '(v.blockNumber = :blockNumber AND v.eventLogIndex = :logIndex AND v.id > :id))',
        {
          blockNumber: key.blockNumber,
          logIndex: key.logIndex,
          id: key.id,
        },
      );
    }

    const rows = await qb.getMany();
    return pageResult(rows, pageSize, (row) => ({
      blockNumber: row.blockNumber,
      logIndex: row.eventLogIndex,
      id: row.id,
    }));
  }
}
