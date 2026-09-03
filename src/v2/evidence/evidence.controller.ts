import { Controller, Get, Param, Query } from '@nestjs/common';
import { EvidenceQueryService } from './evidence-query.service';
import { ListEvidenceVersionsQueryDto } from './dto/list-evidence-versions-query.dto';

/**
 * Read-only V2 evidence endpoints. Intentionally has no POST/PUT/DELETE:
 * evidence state is derived exclusively from canonical contract events by
 * EvidenceProjectorService, never mutated through this API (V2-BE-013 AC:
 * "No backend-authoritative protocol mutation is introduced").
 */
@Controller('v2/claims/:claimId/evidence')
export class EvidenceController {
  constructor(private readonly queryService: EvidenceQueryService) {}

  @Get()
  async getEvidence(@Param('claimId') claimId: string) {
    return this.queryService.getEvidence(claimId);
  }

  @Get('versions')
  async listVersions(
    @Param('claimId') claimId: string,
    @Query() query: ListEvidenceVersionsQueryDto,
  ) {
    const evidence = await this.queryService.getEvidence(claimId);
    return this.queryService.listVersions(
      evidence.evidenceId,
      query.cursor,
      query.limit,
    );
  }
}
