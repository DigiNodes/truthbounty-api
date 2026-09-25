import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../decorators/public.decorator';
import { ProjectionFreshnessService } from './projection-freshness.service';

/**
 * Read-only V2 projection freshness endpoints (issue408).
 *
 * Intentionally exposes only GET handlers: freshness metadata is derived
 * from projector cursors, finality checkpoints, and the indexer snapshot —
 * never mutated through this API. The API relays derived read models; it
 * never settles protocol state, signs transactions, or computes verdicts.
 */
@ApiTags('V2 Projections')
@Public()
@Controller('v2/projections')
export class ProjectionFreshnessController {
  constructor(private readonly freshness: ProjectionFreshnessService) {}

  @Get('freshness')
  @ApiOperation({
    summary:
      'List projection freshness and finality metadata for all V2 projectors',
  })
  @ApiResponse({
    status: 200,
    description: 'Freshness report for every tracked projector.',
  })
  async listFreshness() {
    return this.freshness.listFreshness();
  }

  @Get('freshness/:projectorName')
  @ApiOperation({
    summary:
      'Get projection freshness and finality metadata for one V2 projector',
  })
  @ApiParam({
    name: 'projectorName',
    example: 'v2-evidence',
    description:
      'Projector cursor name (e.g. v2-evidence, v2-verification, v2-disputes).',
  })
  @ApiResponse({
    status: 200,
    description: 'Freshness report for the projector.',
  })
  @ApiResponse({ status: 400, description: 'Invalid projector name.' })
  @ApiResponse({ status: 404, description: 'Unknown projector.' })
  async getFreshness(@Param('projectorName') projectorName: string) {
    return this.freshness.getFreshness(projectorName);
  }
}
