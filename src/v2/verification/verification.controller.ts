import { Controller, Get, Param, Query } from '@nestjs/common';
import { VerificationQueryService } from './verification-query.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

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
    @Query() query: PaginationQueryDto,
  ) {
    return this.queryService.listRounds(claimId, query.limit, query.cursor);
  }

  @Get('verification-rounds/:roundId')
  async getRound(@Param('roundId') roundId: string) {
    return this.queryService.getRound(roundId);
  }

  @Get('verification-rounds/:roundId/positions')
  async listPositions(
    @Param('roundId') roundId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.queryService.listPositions(roundId, query.limit, query.cursor);
  }
}
