import { Controller, Get, Param, Query, Post, Body, Put, Headers, Header, BadRequestException, HttpException, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { ClaimsService } from './claims.service';
import { EvidenceService } from './evidence.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { Idempotent } from '../common/idempotency';
import { PaginationCursorService } from '../common/pagination-cursor.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { SecretQuarantineService } from '../security/secret-quarantine.service';
import { QuarantineAdminGuard } from '../security/quarantine-admin.guard';
import { SecretDetectionResult } from '../security/secret-scanner.types';

const CURSOR_HEADER = 'x-pagination-cursor';

const REMEDIATION_GUIDANCE =
  'Your submission was blocked because it appears to contain sensitive secret material (for example a seed phrase, private key, API token, auth header, or credentials). ' +
  'For your safety, the content has not been stored or forwarded. ' +
  'Remove the secret material and resubmit. If you believe you exposed a secret, rotate/revoke it immediately and never share it in support messages.';

@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly evidenceService: EvidenceService,
    private readonly cursorService: PaginationCursorService,
    private readonly secretScanner: SecretScannerService,
    private readonly quarantineService: SecretQuarantineService,
  ) {}

  private resolveCursor(
    cursor: string | undefined,
    binding: {
      route: string;
      filters: Record<string, unknown>;
      sortOrder: string;
    },
  ): Record<string, unknown> | undefined {
    if (!cursor) {
      return undefined;
    }
    try {
      return this.cursorService.verify(cursor, binding);
    } catch {
      // Never leak signing material or internal details.
      throw new BadRequestException('Invalid pagination cursor');
    }
  }

  private encodeNextCursor(
    payload: Record<string, unknown> | null | undefined,
    binding: {
      route: string;
      filters: Record<string, unknown>;
      sortOrder: string;
    },
  ): string | undefined {
    if (!payload) {
      return undefined;
    }
    return this.cursorService.sign(payload, binding);
  }

  private assertLocalRequest(host?: string): void {
    // Reject cursors replayed across deployments/hosts by binding to release context.
    if (this.cursorService.isForeignHost(host)) {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }

  private async guardSubmission(payload: unknown, context: { claimId?: string; source: string }): Promise<void> {
    const result: SecretDetectionResult = await this.secretScanner.scan(payload);
    if (!result.detected) {
      return;
    }

    // Never echo detected secret material into logs/notifications.
    await this.quarantineService.quarantine({
      claimId: context.claimId,
      source: context.source,
      findings: result.findings.map((f) => ({ type: f.type, confidence: f.confidence })),
    });

    throw new HttpException(
      {
        statusCode: 422,
        error: 'Secret Material Detected',
        message: REMEDIATION_GUIDANCE,
        code: 'SECRET_BANNED',
        findings: result.findings.map((f) => ({ type: f.type, confidence: f.confidence })),
      },
      422,
    );
  }

  @Get('latest')
  @ApiOperation({ summary: 'Get latest claims' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiHeader({ description: 'Opaque pagination cursor (alternative to query param)', required: false })
  @ApiResponse({ status: 200, description: 'List of latest claims' })
  @ApiResponse({ status: 400, description: 'Invalid pagination cursor' })
  async getLatest(
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
    @Headers(CURSOR_HEADER) headerCursor?: string,
    @Headers('host') host?: string,
  ) {
    this.assertLocalRequest(host);
    const effectiveCursor = cursor ?? headerCursor;
    const binding = {
      route: 'GET/claims/latest',
      filters: {},
      sortOrder: 'createdAt:desc,id:desc',
    };
    const position = this.resolveCursor(effectiveCursor, binding);
    const result = await this.claimsService.findLatestPaginated(limit ? +limit : 10, position);
    return {
      items: result.items,
      nextCursor: this.encodeNextCursor(result.nextPosition, binding),
    };
  }

  @Get('user/:wallet')
  @ApiOperation({ summary: 'Get claims by user wallet' })
  @ApiParam({ name: 'wallet', description: 'Wallet address' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiHeader({ description: 'Opaque pagination cursor (alternative to query param)', required: false })
  @ApiResponse({ status: 200, description: 'List of user claims' })
  @ApiResponse({ status: 400, description: 'Invalid pagination cursor' })
  async getByUser(
    @Param('wallet') wallet: string,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
    @Headers(CURSOR_HEADER) headerCursor?: string,
    @Headers('host') host?: string,
  ) {
    this.assertLocalRequest(host);
    const effectiveCursor = cursor ?? headerCursor;
    const binding = {
      route: 'GET/claims/user/:wallet',
      filters: { wallet },
      sortOrder: 'createdAt:desc,id:desc',
    };
    const position = this.resolveCursor(effectiveCursor, binding);
    const result = await this.claimsService.findByUserPaginated(
      wallet,
      limit ? +limit : 10,
      position,
    );
    return {
      items: result.items,
      nextCursor: this.encodeNextCursor(result.nextPosition, binding),
    };
  }

  // Quarantine administration endpoints (admin-only, audited)
  // NOTE: must be declared before ':id' so the admin guard is not shadowed.
  @Get('quarantine')
  @UseGuards(QuarantineAdminGuard)
  @ApiOperation({ summary: 'List quarantined hashed findings (admin)' })
  @ApiResponse({ status: 200, description: 'Quarantine entries' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async listQuarantine(@Headers('x-admin-actor') actor: string) {
    await this.quarantineService.recordAccess({ actor: actor || 'unknown', action: 'list' });
    return this.quarantineService.list();
  }

  @Get('quarantine/:entryId')
  @UseGuards(QuarantineAdminGuard)
  @ApiOperation({ summary: 'Get quarantine entry metadata (admin)' })
  @ApiParam({ name: 'entryId', description: 'Quarantine entry ID' })
  @ApiResponse({ status: 200, description: 'Quarantine entry metadata' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getQuarantineEntry(
    @Param('entryId') entryId: string,
    @Headers('x-admin-actor') actor: string,
  ) {
    await this.quarantineService.recordAccess({ actor: actor || 'unknown', action: 'read', entryId });
    return this.quarantineService.getMetadata(entryId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single claim by ID' })
  @ApiParam({ name: 'id', description: 'Claim ID' })
  @ApiResponse({ status: 200, description: 'Claim details' })
  @ApiResponse({ status: 404, description: 'Claim not found' })
  async getOne(@Param('id') id: string) {
    return this.claimsService.findOne(id);
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Create a new claim' })
  @ApiResponse({ status: 201, description: 'Claim created' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 422, description: 'Secret material detected and quarantined' })
  async createOne(@Body() createClaimDto: CreateClaimDto) {
    await this.guardSubmission(createClaimDto, { source: 'claims.create' });
    return this.claimsService.createClaim(createClaimDto);
  }

  // Evidence endpoints
  @Post(':claimId/evidence')
  @Idempotent()
  @ApiOperation({ summary: 'Add evidence to a claim' })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 201, description: 'Evidence created' })
  @ApiResponse({ status: 422, description: 'Secret material detected and quarantined' })
  async createEvidence(
    @Param('claimId') claimId: string,
    @Body() body: { cid: string; content?: string; attachments?: unknown[] },
  ) {
    await this.guardSubmission(body, { claimId: claimId, source: 'claims.evidence.create' });
    return this.evidenceService.createEvidence(claimId, body.cid);
  }

  @Put('evidence/:evidenceId')
  @ApiOperation({ summary: 'Update evidence with new version' })
  @ApiParam({ name: 'evidenceId', description: 'Evidence ID' })
  @ApiResponse({ status: 200, description: 'Evidence updated' })
  @ApiResponse({ status: 422, description: 'Secret material detected and quarantined' })
  async updateEvidence(
    @Param('evidenceId') evidenceId: string,
    @Body() body: { cid: string; content?: string; attachments?: unknown[] },
  ) {
    await this.guardSubmission(body, { source: 'claims.evidence.update' });
    return this.evidenceService.addEvidenceVersion(evidenceId, body.cid);
  }

  @Get(':claimId/evidence')
  @ApiOperation({ summary: 'Get all evidence for a claim' })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 200, description: 'List of evidence' })
  async getEvidenceForClaim(@Param('claimId') claimId: string) {
    return this.evidenceService.getEvidenceForClaim(claimId);
  }

  @Get(':claimId/evidence/latest')
  @ApiOperation({ summary: 'Get latest evidence for a claim' })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 200, description: 'Latest evidence' })
  async getLatestEvidenceForClaim(@Param('claimId') claimId: string) {
    return this.evidenceService.getLatestEvidenceForClaim(claimId);
  }

  @Get('evidence/:evidenceId')
  @ApiOperation({ summary: 'Get a single evidence by ID' })
  @ApiParam({ name: 'evidenceId', description: 'Evidence ID' })
  @ApiResponse({ status: 200, description: 'Evidence details' })
  async getEvidence(@Param('evidenceId') evidenceId: string) {
    return this.evidenceService.getEvidence(evidenceId);
  }

}