import { Controller, Get, Param, Query } from '@nestjs/common';
import { DisputesQueryService } from './disputes-query.service';

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
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.queryService.listForClaim(claimId, limit ? parseInt(limit, 10) : 20, cursor);
  }

  @Get(':originalRoundId')
  async getByOriginalRound(
    @Param('claimId') claimId: string,
    @Param('originalRoundId') originalRoundId: string,
  ) {
    return this.queryService.getByOriginalRound(claimId, originalRoundId);
  }
}