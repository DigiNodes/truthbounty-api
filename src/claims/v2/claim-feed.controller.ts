import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ClaimFeedQueryDto } from './dto/claim-feed-query.dto';
import { ClaimDetailParamsDto } from './dto/claim-detail-params.dto';
import { rejectLegacyProtocolOperation } from '../protocol-authority';

@ApiTags('v2-claims')
@Controller('api/v2/claims')
export class ClaimFeedController {
  @Get()
  @ApiOperation({
    summary: 'Deprecated legacy claim feed',
    description:
      'Returns 410 because this feed read legacy local claim records. Use the canonical claim read model.',
    deprecated: true,
  })
  @ApiResponse({ status: 410, description: 'Use canonical claim read models' })
  getFeed(@Query() _query: ClaimFeedQueryDto): never {
    return rejectLegacyProtocolOperation(
      'This feed reads legacy local claim records and is retired. Use /api/v2/claim-read-models.',
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Deprecated legacy claim detail',
    description:
      'Returns 410 because this detail reads legacy local claim records. Use the canonical claim read model.',
    deprecated: true,
  })
  @ApiResponse({ status: 410, description: 'Use canonical claim read models' })
  getDetail(@Param() _params: ClaimDetailParamsDto): never {
    return rejectLegacyProtocolOperation(
      'This detail reads legacy local claim records and is retired. Use /api/v2/claim-read-models/{claimId}.',
    );
  }
}
