import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../decorators/public.decorator';
import { ProjectionReadinessService } from './projection-readiness.service';
import { V2_PROJECTOR_NAMES, isV2ProjectorName } from './projector-registry';

/**
 * Operator surface for the Projection Readiness Gate (V2-BE-100).
 *
 * GET-only by construction: readiness is derived from canonical state and can
 * never be set, forced, or cleared through the API. The endpoint is public
 * like the health probes because it exposes only chain coordinates, counts,
 * and invariant names — never claim content, user data, RPC URLs, or
 * credentials.
 *
 * A not-ready verdict is reported as HTTP 503 with the full report in the
 * body, so orchestrators and dashboards see the same failure the read paths
 * enforce instead of a green check that disagrees with them.
 */
@ApiTags('V2 Projections')
@Public()
@Controller('v2/projections/readiness')
export class ProjectionReadinessController {
  constructor(private readonly readiness: ProjectionReadinessService) {}

  @Get()
  @ApiOperation({
    summary: 'Projection readiness for every registered projector',
  })
  async getReadiness() {
    const report = await this.readiness.evaluateAll();
    if (!report.ready) {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }

  @Get(':projector')
  @ApiOperation({ summary: 'Projection readiness for a single projector' })
  async getProjectorReadiness(@Param('projector') projector: string) {
    if (!isV2ProjectorName(projector)) {
      throw new BadRequestException(
        `Unknown V2 projector "${projector}" (known: ${V2_PROJECTOR_NAMES.join(', ')})`,
      );
    }

    const readiness = await this.readiness.evaluate(projector);
    if (!readiness.ready) {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }
}
