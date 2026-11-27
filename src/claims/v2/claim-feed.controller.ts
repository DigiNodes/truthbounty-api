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
    summary: 'Paginated claim metadata feed',
    description:
      'Returns claim metadata ordered by effectiveAt DESC. This legacy feed does not ' +
      'publish protocol verdict or finality; use the release-bound claim read-model endpoint.',
    deprecated: true,
  })
  @ApiResponse({ status: 200, description: 'Paginated claim feed' })
  @ApiResponse({
    status: 400,
    description: 'Invalid cursor or query parameters',
  })
  async getFeed(@Query() query: ClaimFeedQueryDto) {
    return this.claimFeedService.getFeed(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Legacy claim metadata detail',
    description:
      'Returns claim metadata and resource links only. It does not publish ' +
      'protocol verdict or finality; use the release-bound claim read-model endpoint.',
    deprecated: true,
  })
  @ApiResponse({ status: 200, description: 'Claim detail' })
  @ApiResponse({ status: 404, description: 'Claim not found' })
  async getDetail(@Param() params: ClaimDetailParamsDto) {
    return this.claimFeedService.getDetail(params.id);
  }
}
