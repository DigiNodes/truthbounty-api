import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { DisputeService } from './dispute.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { RejectDisputeDto } from './dto/reject-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import {
  DisputeStatus,
  DisputeTrigger,
} from './entities/dispute.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * DisputeController — authorization aligned with the V2 API Authorization Matrix.
 *
 * READ routes  → PUBLIC (GET; chain-derived projections are openly readable).
 * CREATE route → AUTHN  (any authenticated wallet-holder may open a dispute).
 * STATE TRANSITIONS (start-review, resolve, reject) → ROLE(moderator | admin).
 *   Rationale: These operations influence which dispute outcome is *recorded* in the
 *   API layer. The protocol-authoritative outcome is always the finalized on-chain
 *   event; the API layer must never settle or mutate protocol state unilaterally.
 *   Restricting to moderator/admin prevents anonymous abuse of the review pipeline.
 *
 * @see src/auth/authorization-matrix.ts
 */
@ApiTags('disputes')
@Controller('disputes')
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

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
  @ApiOperation({ summary: 'Get expired disputes' })
  @ApiResponse({ status: 200, description: 'List of expired disputes' })
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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new dispute' })
  @ApiResponse({ status: 201, description: 'Dispute created' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async create(@Body() dto: CreateDisputeDto) {
    return this.disputeService.createDispute(dto);
  }

  // ── STATE TRANSITIONS (moderator or admin only) ───────────────────────────

  @Patch(':id/start-review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start dispute review process' })
  @ApiResponse({ status: 200, description: 'Review started' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async startReview(@Param('id') id: string) {
    return this.disputeService.startReview(id);
  }

  @Patch(':id/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resolve a dispute' })
  @ApiResponse({ status: 200, description: 'Dispute resolved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async resolve(@Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return this.disputeService.resolveDispute({
      disputeId: id,
      outcome: dto.outcome,
      finalConfidence: dto.finalConfidence,
      metadata: dto.metadata,
    });
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject a dispute as spam/invalid' })
  @ApiResponse({ status: 200, description: 'Dispute rejected' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async reject(@Param('id') id: string, @Body() dto: RejectDisputeDto) {
    return this.disputeService.rejectDispute({
      disputeId: id,
      reason: dto.reason,
      rejectedBy: dto.rejectedBy,
    });
  }
}
