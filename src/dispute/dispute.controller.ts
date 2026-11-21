import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DisputeService } from './dispute.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { RejectDisputeDto } from './dto/reject-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { ProjectDisputeOutcomeDto } from './dto/project-dispute-outcome.dto';
import { DisputeStatus, DisputeTrigger } from './entities/dispute.entity';
import { Idempotent } from '../common/idempotency';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * DisputeController — read model plus explicit workflow metadata.
 *
 * READ routes            → PUBLIC (chain-derived projections are openly readable).
 * CREATE                 → AUTHN. The initiator is the verified JWT principal;
 *                          a canonical DisputeRaised log may be supplied, but
 *                          client-supplied identity/confidence never are.
 * PROJECT OUTCOME        → ROLE(moderator | admin). Only path that writes a
 *                          terminal outcome, and only from a finalized
 *                          canonical DisputeResolved/DisputeExpired event.
 * START REVIEW / triage  → ROLE(moderator | admin). Non-authoritative workflow
 *                          labels/notes; the legacy resolve/reject routes are
 *                          deprecated and can no longer settle a dispute.
 *
 * @see src/auth/authorization-matrix.ts
 */
@ApiTags('disputes')
@Controller('disputes')
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

  private principal(request: AuthenticatedRequest): string {
    const address = request?.user?.address;
    if (typeof address !== 'string' || address.trim() === '') {
      throw new UnauthorizedException('Verified principal is required');
    }
    return address;
  }

  // ── READ endpoints (public) ───────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Get all disputes with optional filters' })
  @ApiResponse({ status: 200, description: 'List of disputes' })
  async findAll(
    @Query('status') status?: DisputeStatus,
    @Query('trigger') trigger?: DisputeTrigger,
  ) {
    return this.disputeService.findAll({ status, trigger });
  }

  @Get('expired')
  @ApiOperation({
    summary: 'Get workflow records past the attention deadline',
  })
  @ApiResponse({ status: 200, description: 'List of disputes needing review' })
  async getExpired() {
    return this.disputeService.getExpiredDisputes();
  }

  @Get('claim/:claimId')
  @ApiOperation({ summary: 'Get dispute by claim ID' })
  @ApiResponse({ status: 200, description: 'Dispute found' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async getByClaimId(@Param('claimId') claimId: string) {
    return this.disputeService.getDisputeByClaimId(claimId);
  }

  // ── CREATE (authenticated users only) ────────────────────────────────────

  @Post()
  @Idempotent()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Open a workflow dispute (optionally from a canonical raise log)',
  })
  @ApiResponse({ status: 201, description: 'Dispute created' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateDisputeDto,
  ) {
    return this.disputeService.createDispute({
      claimId: dto.claimId,
      principal: this.principal(request),
      canonicalEvent: dto.canonicalEvent,
      metadata: dto.metadata,
    });
  }

  // ── WORKFLOW LABELS (moderator or admin only) ────────────────────────────

  @Patch(':id/start-review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start dispute review process (workflow only)' })
  @ApiResponse({ status: 200, description: 'Review started' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async startReview(@Param('id') id: string) {
    return this.disputeService.startReview(id);
  }

  // ── CANONICAL TERMINAL PROJECTION (moderator or admin only) ──────────────

  @Post(':id/project-outcome')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Project a finalized canonical dispute outcome (authoritative)',
  })
  @ApiResponse({
    status: 201,
    description: 'Terminal state projected from canonical evidence',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or non-finalized evidence',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  @ApiResponse({ status: 409, description: 'Canonical event already recorded' })
  async projectOutcome(
    @Param('id') id: string,
    @Body() dto: ProjectDisputeOutcomeDto,
  ) {
    return this.disputeService.projectOutcome({
      disputeId: id,
      canonicalEvent: dto.canonicalEvent,
      metadata: dto.metadata,
    });
  }

  // ── DEPRECATED triage-only routes ────────────────────────────────────────

  /** @deprecated Use POST /disputes/:id/project-outcome for terminal outcomes. */
  @Patch(':id/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    deprecated: true,
    summary: 'DEPRECATED: record a non-authoritative triage note only',
  })
  @ApiResponse({ status: 200, description: 'Triage note recorded' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async resolve(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.disputeService.recordTriage({
      disputeId: id,
      principal: this.principal(request),
      note: dto.note,
      metadata: dto.metadata,
    });
  }

  /** @deprecated Use POST /disputes/:id/project-outcome for terminal outcomes. */
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    deprecated: true,
    summary: 'DEPRECATED: record a non-authoritative rejection triage note',
  })
  @ApiResponse({ status: 200, description: 'Triage note recorded' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async reject(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: RejectDisputeDto,
  ) {
    return this.disputeService.recordTriage({
      disputeId: id,
      principal: this.principal(request),
      reason: dto.reason,
    });
  }
}
