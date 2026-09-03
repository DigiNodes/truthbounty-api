import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ClaimFeedService } from './claim-feed.service';
import { ClaimFeedQueryDto } from './dto/claim-feed-query.dto';
import { ClaimDetailParamsDto } from './dto/claim-detail-params.dto';

@ApiTags('v2-claims')
@Controller('api/v2/claims')
export class ClaimFeedController {
  constructor(private readonly claimFeedService: ClaimFeedService) {}

  @Get()
  @ApiOperation({
    summary: 'Paginated claim feed with lifecycle state and filters',
    description:
      'Returns a cursor-paginated list of claims ordered by effectiveAt DESC. ' +
      'Supports filtering by lifecycle state, creator wallet, and date range.',
  })
  @ApiResponse({ status: 200, description: 'Paginated claim feed' })
  @ApiResponse({ status: 400, description: 'Invalid cursor or query parameters' })
  async getFeed(@Query() query: ClaimFeedQueryDto) {
    return this.claimFeedService.getFeed(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Full claim detail with lifecycle, confirmations, and resource links',
    description:
      'Returns complete claim data including lifecycle state, confirmation/finality ' +
      'metadata, and links to related resources (evidence, stakes).',
  })
  @ApiResponse({ status: 200, description: 'Claim detail' })
  @ApiResponse({ status: 404, description: 'Claim not found' })
  async getDetail(@Param() params: ClaimDetailParamsDto) {
    return this.claimFeedService.getDetail(params.id);
  }
}
