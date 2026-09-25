import { Controller, Get, Param, Query } from '@nestjs/common';
import { DisputesQueryService } from './disputes-query.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

/**
 * Read-only V2 dispute endpoints. No write handlers: dispute state is
 * derived exclusively from canonical contract events by
 * DisputesProjectorService.
 */
@Controller('v2/claims/:claimId/disputes')
export class DisputesController {
  constructor(private readonly queryService: DisputesQueryService) {}

  @Get()
  async listForClaim(
    @Param('claimId') claimId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.queryService.listForClaim(claimId, query.limit, query.cursor);
  }

  @Get(':originalRoundId')
  async getByOriginalRound(
    @Param('claimId') claimId: string,
    @Param('originalRoundId') originalRoundId: string,
  ) {
    return this.queryService.getByOriginalRound(claimId, originalRoundId);
  }
}
