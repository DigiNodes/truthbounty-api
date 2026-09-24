import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectEvidence } from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';
import {
  CursorPage,
  clampPageSize,
  decodeCursor,
  encodeCursor,
} from '../common/cursor-pagination';
import { ProjectionReadinessService } from '../common/projection-readiness/projection-readiness.service';
import { V2_PROJECTORS } from '../common/projection-readiness/projector-registry';

@Injectable()
export class EvidenceQueryService {
  constructor(
    @InjectRepository(ProjectEvidence)
    private readonly evidenceRepo: Repository<ProjectEvidence>,
    @InjectRepository(ProjectEvidenceVersion)
    private readonly versionRepo: Repository<ProjectEvidenceVersion>,
    private readonly readiness: ProjectionReadinessService,
  ) {}

  async getEvidence(claimId: string): Promise<ProjectEvidence> {
    // Fail closed: evidence state is protocol state, so it is only served
    // while the projection provably reproduces canonical events.
    await this.readiness.assertReady(V2_PROJECTORS.EVIDENCE);

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
    // Fail closed: see getEvidence.
    await this.readiness.assertReady(V2_PROJECTORS.EVIDENCE);

    const pageSize = clampPageSize(limit);
    const qb = this.versionRepo
      .createQueryBuilder('v')
      .where('v.evidenceId = :evidenceId', { evidenceId })
      .orderBy('v.blockNumber', 'ASC')
      .addOrderBy('v.eventLogIndex', 'ASC')
      .limit(pageSize + 1);

    if (cursor) {
      const key = decodeCursor(cursor);
      qb.andWhere(
        '(v.blockNumber > :blockNumber OR (v.blockNumber = :blockNumber AND v.eventLogIndex > :logIndex))',
        {
          blockNumber: key.blockNumber,
          logIndex: key.logIndex,
        },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items[items.length - 1];

    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              blockNumber: String(last.blockNumber),
              logIndex: last.eventLogIndex,
              id: last.id,
            })
          : null,
    };
  }
}
