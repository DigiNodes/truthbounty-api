import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../decorators/public.decorator';
import { DisputeReadModelService } from './dispute-read-model.service';
import { DisputeListQuery } from './dto/dispute-read-model-query.dto';
import {
  DisputeReadModelDetailResponseDto,
  DisputeReadModelErrorDto,
  DisputeReadModelListResponseDto,
} from './dto/dispute-read-model-response.dto';

/**
 * Read-only, versioned dispute read models (PREWAVE-BE-007).
 *
 * Deliberately GET-only: every field is derived from canonical contract events
 * via the dispute projection. The API relays a read model; it never settles
 * protocol state and never accepts writes here.
 */
@ApiTags('V2 Dispute Read Models')
@Public()
@Controller('api/v2/dispute-read-models')
export class DisputeReadModelController {
  constructor(private readonly readModels: DisputeReadModelService) {}

  @Get()
  @ApiOperation({
    summary: 'Versioned, cursor-paginated dispute register read model',
    description:
      'Returns canonical dispute read models ordered deterministically by disputeId. ' +
      'Every response binds the release provenance and freshness of the served ' +
      'snapshot and fails closed when that provenance or finality is unavailable.',
  })
  @ApiResponse({
    status: 200,
    description: 'Dispute register read model page',
    type: DisputeReadModelListResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid cursor, filter, chain, or release',
    type: DisputeReadModelErrorDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Provenance or finality unavailable; failing closed',
    type: DisputeReadModelErrorDto,
  })
  async getList(@Query() query: DisputeListQuery) {
    return this.readModels.getList(query);
  }

  @Get(':disputeId')
  @ApiOperation({
    summary: 'Versioned canonical dispute detail read model',
    description:
      'Returns the canonical read model for a single dispute, including its ' +
      'phase-separated outcome, deadlines, bond disposition, appeal availability, ' +
      'and release binding.',
  })
  @ApiParam({ name: 'disputeId', description: 'Canonical dispute id (format: claimId:roundId)' })
  @ApiResponse({
    status: 200,
    description: 'Dispute detail read model',
    type: DisputeReadModelDetailResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Dispute is not projected',
    type: DisputeReadModelErrorDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Provenance or finality unavailable; failing closed',
    type: DisputeReadModelErrorDto,
  })
  async getDetail(@Param('disputeId') disputeId: string) {
    return this.readModels.getDetail(disputeId);
  }
}
