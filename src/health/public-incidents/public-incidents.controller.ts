import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../decorators/public.decorator';
import {
  PUBLIC_INCIDENTS_SCHEMA_VERSION,
  PublicIncidentDetailDto,
  PublicIncidentListResponseDto,
  PublicIncidentQueryDto,
} from './public-incidents.dto';
import { PublicIncidentRateLimitGuard } from './public-incidents-rate-limit.guard';
import { PublicIncidentService } from './public-incidents.service';

/**
 * Sanitized public incident projection controller (UX-BE-002).
 * Exposes unauthenticated, sanitized incident listings and detail projections
 * for public status screens, free from protected investigation notes or internal metadata.
 */
@ApiTags('Public Incidents')
@Public()
@Controller(['status/incidents', 'status/public/incidents'])
export class PublicIncidentController {
  constructor(private readonly publicIncidentService: PublicIncidentService) {}

  @Get()
  @UseGuards(PublicIncidentRateLimitGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'List published sanitized incidents',
    description:
      'Returns a paginated list of published, sanitized incidents with immutable timestamps, ' +
      'affected public components, impact, and current status. Draft and unapproved records are omitted.',
  })
  @ApiOkResponse({ type: PublicIncidentListResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'Per-client rate limit exceeded.',
  })
  async getPublicIncidents(
    @Query() query: PublicIncidentQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicIncidentListResponseDto> {
    const { body, maxAgeSeconds } =
      await this.publicIncidentService.findAll(query);
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
      res.setHeader('X-Public-Incidents-Schema', PUBLIC_INCIDENTS_SCHEMA_VERSION);
    }
    return body;
  }

  @Get(':incidentId')
  @UseGuards(PublicIncidentRateLimitGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Get published sanitized incident details',
    description:
      'Returns sanitized incident details including narrative, mitigation, approved post-incident links, ' +
      'and immutable publication audit history. Unknown or unapproved IDs return 404.',
  })
  @ApiParam({
    name: 'incidentId',
    description: 'Public incident identifier or slug',
    example: 'inc-9b2f6c01-7e8a-4d2a-a5c3-1289fe943201',
  })
  @ApiOkResponse({ type: PublicIncidentDetailDto })
  @ApiNotFoundResponse({
    description: 'Incident not found, unapproved, or unconfigured.',
  })
  @ApiTooManyRequestsResponse({
    description: 'Per-client rate limit exceeded.',
  })
  async getPublicIncidentDetail(
    @Param('incidentId') incidentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicIncidentDetailDto> {
    const { body, maxAgeSeconds } =
      await this.publicIncidentService.findById(incidentId);
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
      res.setHeader('X-Public-Incidents-Schema', PUBLIC_INCIDENTS_SCHEMA_VERSION);
    }
    return body;
  }
}
