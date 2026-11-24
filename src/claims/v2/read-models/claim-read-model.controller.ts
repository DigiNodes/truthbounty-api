import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../decorators/public.decorator';
import { ClaimReadModelService } from './claim-read-model.service';
import { ClaimListQuery } from './dto/claim-list-query.dto';
import {
  ClaimReadModelDetailResponseDto,
  ClaimReadModelErrorDto,
  ClaimReadModelListResponseDto,
} from './dto/claim-read-model-response.dto';

/**
 * Read-only, versioned claim read models (PREWAVE-BE-005).
 *
 * Deliberately GET-only: every field is derived from canonical contract events
 * via the claim projection. The API relays a read model; it never settles
 * protocol state and never accepts writes here.
 */
@ApiTags('V2 Claim Read Models')
@Public()
@Controller('api/v2/claim-read-models')
export class ClaimReadModelController {
  constructor(private readonly readModels: ClaimReadModelService) {}

  @Get()
  @ApiOperation({
    summary: 'Versioned, cursor-paginated claim list read model',
    description:
      'Returns canonical claim read models ordered deterministically by claimId. ' +
      'Every response binds the release provenance and freshness of the served ' +
      'snapshot and fails closed when that provenance or finality is unavailable.',
  })
  @ApiResponse({
    status: 200,
    description: 'Claim list read model page',
    type: ClaimReadModelListResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid cursor, filter, chain, or release',
    type: ClaimReadModelErrorDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Provenance or finality unavailable; failing closed',
    type: ClaimReadModelErrorDto,
  })
  async getList(@Query() query: ClaimListQuery) {
    return this.readModels.getList(query);
  }

  @Get(':claimId')
  @ApiOperation({
    summary: 'Versioned canonical claim detail read model',
    description:
      'Returns the canonical read model for a single claim, including its ' +
      'phase-separated outcome, deadlines, evidence availability, and release binding.',
  })
  @ApiParam({ name: 'claimId', description: 'Canonical claim id' })
  @ApiResponse({
    status: 200,
    description: 'Claim detail read model',
    type: ClaimReadModelDetailResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Claim is not projected',
    type: ClaimReadModelErrorDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Provenance or finality unavailable; failing closed',
    type: ClaimReadModelErrorDto,
  })
  async getDetail(@Param('claimId') claimId: string) {
    return this.readModels.getDetail(claimId);
  }
}
