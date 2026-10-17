import {
  Controller,
  Get,
  Header,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../decorators/public.decorator';
import {
  PUBLIC_STATUS_SCHEMA_VERSION,
  PublicStatusResponseDto,
} from './public-status.dto';
import {
  PUBLIC_REORG_SCHEMA_VERSION,
  PublicReorgStatusResponseDto,
} from './public-reorg-status.dto';
import { PublicStatusRateLimitGuard } from './public-status-rate-limit.guard';
import { PublicStatusService } from './public-status.service';
import { ReorgRecoveryService } from '../../v2/events/reorg-recovery.service';

/**
 * Sanitized public service-status projection (UX-BE-001). Unlike the
 * protected `/health/*` reports, this endpoint returns only the allow-listed
 * `PublicStatusResponseDto`.
 */
@ApiTags('Public Status')
@Public()
@Controller('status')
export class PublicStatusController {
  constructor(
    private readonly publicStatusService: PublicStatusService,
    private readonly reorgRecoveryService: ReorgRecoveryService,
  ) {}

  @Get('public')
  @UseGuards(PublicStatusRateLimitGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Public service status',
    description:
      'Freshness-labelled, allow-listed status for the public status page. ' +
      'Missing data is reported as `unknown` and old data as `stale`; ' +
      'neither is ever reported as `operational`.',
  })
  @ApiOkResponse({ type: PublicStatusResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'Per-client rate limit exceeded.',
  })
  async getPublicStatus(
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicStatusResponseDto> {
    const { body, maxAgeSeconds } =
      await this.publicStatusService.getSnapshot();
    res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
    res.setHeader('X-Public-Status-Schema', PUBLIC_STATUS_SCHEMA_VERSION);
    return body;
  }

  @Get('public/reorg')
  @UseGuards(PublicStatusRateLimitGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Public reorg recovery status',
    description:
      'Freshness-labelled reorg recovery status (V2-BE-003). Exposes ' +
      'STOPPED_DEEP_REORG / STOPPED_AMBIGUOUS as fail-closed signals.',
  })
  @ApiQuery({ name: 'chainId', required: false, example: 10 })
  @ApiOkResponse({ type: PublicReorgStatusResponseDto })
  @ApiTooManyRequestsResponse({
    description: 'Per-client rate limit exceeded.',
  })
  getPublicReorgStatus(
    @Query('chainId') chainIdRaw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): PublicReorgStatusResponseDto {
    const chainId = chainIdRaw ? parseInt(chainIdRaw, 10) : 10;
    if (!Number.isInteger(chainId) || chainId <= 0) {
      res.setHeader('Cache-Control', 'no-store');
      throw new Error(`Invalid chainId: ${chainIdRaw}`);
    }
    const snap = this.reorgRecoveryService.getStatus(chainId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Public-Status-Schema', PUBLIC_REORG_SCHEMA_VERSION);
    return {
      status: snap.status,
      chainId: snap.chainId,
      detectedAt: snap.detectedAt ? snap.detectedAt.toISOString() : null,
      recoveredAt: snap.recoveredAt ? snap.recoveredAt.toISOString() : null,
      forkBlockNumber: snap.forkBlockNumber,
      reorgDepth: snap.reorgDepth,
      reason: snap.reason,
    };
  }
}
