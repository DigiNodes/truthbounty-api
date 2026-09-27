import { Controller, Get, Post, Body, Param, Query, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger';
import { EvidenceQueryService } from './evidence-query.service';
import { EvidenceIntegrityService } from './evidence-integrity.service';
import { ListEvidenceVersionsQueryDto } from './dto/list-evidence-versions-query.dto';
import { VerifyBatchDto } from './dto/verify-batch.dto';

/**
 * Read-only V2 evidence endpoints. Intentionally has no POST/PUT/DELETE:
 * evidence state is derived exclusively from canonical contract events by
 * EvidenceProjectorService, never mutated through this API (V2-BE-013 AC:
 * "No backend-authoritative protocol mutation is introduced").
 *
 * V2-BE-013: Includes integrity verification endpoints for operational
 * monitoring and debugging. These endpoints do not mutate state.
 */
@ApiTags('V2 Evidence')
@Controller('v2/claims/:claimId/evidence')
export class EvidenceController {
  constructor(
    private readonly queryService: EvidenceQueryService,
    private readonly integrityService: EvidenceIntegrityService,
  ) {}

  @Get()
  async getEvidence(@Param('claimId') claimId: string) {
    return this.queryService.getEvidence(claimId);
  }

  @Get('versions')
  async listVersions(
    @Param('claimId') claimId: string,
    @Query() query: ListEvidenceVersionsQueryDto,
  ) {
    const evidence = await this.queryService.getEvidence(claimId);
    return this.queryService.listVersions(
      evidence.evidenceId,
      query.cursor,
      query.limit,
    );
  }

  @Get('integrity')
  @ApiOperation({
    summary: 'Verify integrity of evidence and all its versions',
    description:
      'Returns cryptographic integrity verification results including current state hash, version hashes, and chain-of-custody validation. Used for operational debugging and corruption detection.',
  })
  @ApiResponse({
    status: 200,
    description: 'Integrity verification completed',
  })
  @ApiResponse({
    status: 404,
    description: 'Evidence not found',
  })
  async verifyIntegrity(@Param('claimId') claimId: string) {
    const evidence = await this.queryService.getEvidence(claimId);
    const result = await this.integrityService.verifyCompleteIntegrity(
      evidence.evidenceId,
    );

    return {
      evidenceId: evidence.evidenceId,
      claimId,
      currentVersion: evidence.currentVersion,
      integrityStatus: result.evidenceValid && result.versionsValid && result.chainValid
        ? 'valid'
        : result.evidenceValid && result.versionsValid && !result.chainValid
          ? 'chain_broken'
          : 'invalid',
      currentStateIntegrity: {
        valid: result.evidenceResult.valid,
        hash: result.evidenceResult.integrityHash,
        expectedHash: result.evidenceResult.expectedHash,
        reason: result.evidenceResult.reason,
        details: result.evidenceResult.details,
        verifiedAt: new Date().toISOString(),
      },
      versionIntegrity: result.versionResults.map((v) => ({
        version: parseInt(v.entityId.split(':v')[1]),
        valid: v.valid,
        hash: v.integrityHash,
        expectedHash: v.expectedHash,
        reason: v.reason,
        details: v.details,
      })),
      chainOfCustody: {
        valid: result.chainResult.valid,
        totalVersions: result.chainResult.totalVersions,
        brokenAt: result.chainResult.brokenAt,
        reason: result.chainResult.reason,
      },
    };
  }
}

/**
 * Global evidence integrity endpoints (not claim-specific).
 */
@ApiTags('V2 Evidence Integrity')
@Controller('v2/evidence/integrity')
export class EvidenceIntegrityController {
  constructor(private readonly integrityService: EvidenceIntegrityService) {}

  @Post('verify-batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch verify integrity of multiple evidence items',
    description:
      'Verifies current-state integrity for multiple evidence items in a single request. Returns summary statistics. Maximum 100 items per request.',
  })
  @ApiResponse({
    status: 200,
    description: 'Batch verification completed',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request (e.g., too many items)',
  })
  async verifyBatch(@Body() body: VerifyBatchDto) {
    const results = await this.integrityService.verifyBatch(body.evidenceIds);

    const summary = {
      total: results.length,
      valid: results.filter((r) => r.valid).length,
      invalid: results.filter((r) => !r.valid).length,
      missingHash: results.filter((r) => r.reason === 'hash_missing').length,
      hashMismatch: results.filter((r) => r.reason === 'hash_mismatch').length,
      notFound: results.filter((r) => r.reason === 'not_found').length,
    };

    return {
      results: results.map((r) => ({
        evidenceId: r.entityId,
        valid: r.valid,
        reason: r.reason,
        details: r.details,
      })),
      summary,
    };
  }

  @Get('statistics')
  @ApiOperation({
    summary: 'Get integrity statistics for monitoring',
    description:
      'Returns aggregate statistics about integrity hash coverage across all evidence. Used for dashboards and alerts.',
  })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved',
  })
  async getStatistics() {
    return this.integrityService.getIntegrityStatistics();
  }

  @Get('health')
  @ApiOperation({
    summary: 'Evidence integrity health check',
    description:
      'Returns health status of evidence integrity system. Status is "healthy" if >99% of records are stamped, "degraded" if >95%, "critical" otherwise.',
  })
  @ApiResponse({
    status: 200,
    description: 'Health check completed',
  })
  async getHealth() {
    const stats = await this.integrityService.getIntegrityStatistics();

    const evidenceStampedPct =
      stats.totalEvidence > 0
        ? (stats.evidenceStamped / stats.totalEvidence) * 100
        : 100;
    const versionsStampedPct =
      stats.totalVersions > 0
        ? (stats.versionsStamped / stats.totalVersions) * 100
        : 100;

    const overallStampedPct = Math.min(evidenceStampedPct, versionsStampedPct);

    let status: 'healthy' | 'degraded' | 'critical';
    if (overallStampedPct >= 99) {
      status = 'healthy';
    } else if (overallStampedPct >= 95) {
      status = 'degraded';
    } else {
      status = 'critical';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      totalEvidence: stats.totalEvidence,
      totalVersions: stats.totalVersions,
      evidenceStamped: stats.evidenceStamped,
      versionsStamped: stats.versionsStamped,
      evidenceUnstamped: stats.evidenceUnstamped,
      versionsUnstamped: stats.versionsUnstamped,
      evidenceStampedPercentage: evidenceStampedPct.toFixed(2),
      versionsStampedPercentage: versionsStampedPct.toFixed(2),
      overallStampedPercentage: overallStampedPct.toFixed(2),
    };
  }
}
