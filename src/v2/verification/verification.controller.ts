import { Controller, Get, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { VerificationQueryService } from './verification-query.service';

/**
 * Read-only V2 verification endpoints. No write handlers: round and
 * position state is derived exclusively from canonical contract events by
 * VerificationProjectorService.
 */
@Controller('v2')
export class VerificationController {
  constructor(private readonly queryService: VerificationQueryService) {}

  @Get('claims/:claimId/verification-rounds')
  async listRounds(
    @Param('claimId') claimId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.queryService.listRounds(claimId, limit ? parseInt(limit, 10) : 20, cursor);
  }

  @Get('verification-rounds/:roundId')
  async getRound(@Param('roundId') roundId: string) {
    return this.queryService.getRound(roundId);
  }

  @Get('verification-rounds/:roundId/positions')
  async listPositions(
    @Param('roundId') roundId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.queryService.listPositions(roundId, limit ? parseInt(limit, 10) : 20, cursor);
  }
}