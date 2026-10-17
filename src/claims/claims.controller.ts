import { Controller, Get, Param, Query, Post, Body, Put, Headers, Header, BadRequestException } from '@nestjs/common';
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

const CURSOR_HEADER = 'x-pagination-cursor';

@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly evidenceService: EvidenceService,
    private readonly cursorService: PaginationCursorService,
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
  async createOne(@Body() createClaimDto: CreateClaimDto) {
    return this.claimsService.createClaim(createClaimDto);
  }

  // Evidence endpoints
  @Post(':claimId/evidence')
  @Idempotent()
  @ApiOperation({ summary: 'Add evidence to a claim' })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 201, description: 'Evidence created' })
  async createEvidence(
    @Param('claimId') claimId: string,
    @Body() body: { cid: string },
  ) {
    return this.evidenceService.createEvidence(claimId, body.cid);
  }

  @Put('evidence/:evidenceId')
  @ApiOperation({ summary: 'Update evidence with new version' })
  @ApiParam({ name: 'evidenceId', description: 'Evidence ID' })
  @ApiResponse({ status: 200, description: 'Evidence updated' })
  async updateEvidence(
    @Param('evidenceId') evidenceId: string,
    @Body() body: { cid: string },
  ) {
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
