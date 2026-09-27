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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { GovernanceService } from './governance.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { CastVoteDto } from './dto/cast-vote.dto';
import {
  ProposalStatus,
  ProposalCategory,
} from './entities/proposal.entity';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * GovernanceController — authorization aligned with the V2 API Authorization Matrix.
 *
 * READ routes        → PUBLIC (chain-derived governance projections).
 * CREATE proposal    → AUTHN (any authenticated user).
 * CAST vote          → AUTHN (any authenticated user).
 * ACTIVATE / CANCEL  → ROLE(moderator | admin).
 * EXECUTE            → ROLE(admin) only.
 *   Rationale: execute() records that a passed proposal was actioned on-chain.
 *   This is the highest-impact state transition in the governance pipeline;
 *   moderators may not execute — only admins may confirm execution.
 *   The smart contract remains authoritative; this is an indexing confirmation only.
 *
 * @see src/auth/authorization-matrix.ts
 */
@ApiTags('governance')
@Controller('governance')
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  // ── READ (public with optional auth context) ──────────────────────────────

  @Get('proposals')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get all proposals with optional filters' })
  @ApiQuery({ name: 'status', required: false, enum: ProposalStatus })
  @ApiQuery({ name: 'category', required: false, enum: ProposalCategory })
  @ApiQuery({ name: 'proposer', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['newest', 'oldest', 'most_votes', 'highest_participation'],
  })
  @ApiResponse({ status: 200, description: 'List of proposals' })
  async findAll(
    @Query('status') status?: ProposalStatus,
    @Query('category') category?: ProposalCategory,
    @Query('proposer') proposer?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('sort')
    sort?: 'newest' | 'oldest' | 'most_votes' | 'highest_participation',
  ) {
    return this.governanceService.findAll({
      status,
      category,
      proposer,
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      sort,
    });
  }

  @Get('proposals/active')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get active proposals' })
  @ApiResponse({ status: 200, description: 'List of active proposals' })
  async findActive() {
    return this.governanceService.findActive();
  }

  @Get('proposals/:id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get a single proposal by ID' })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 200, description: 'Proposal details' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async findOne(@Param('id') id: string) {
    return this.governanceService.findOne(id);
  }

  @Get('proposals/:id/votes')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get votes for a proposal' })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 200, description: 'List of votes' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async getVotes(@Param('id') id: string) {
    return this.governanceService.getVotesForProposal(id);
  }

  @Get('stats')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get governance statistics' })
  @ApiResponse({ status: 200, description: 'Governance stats' })
  async getStats() {
    return this.governanceService.getStats();
  }

  // ── CREATE / VOTE (any authenticated user) ────────────────────────────────

  @Post('proposals')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new proposal' })
  @ApiResponse({ status: 201, description: 'Proposal created' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async create(@Body() dto: CreateProposalDto) {
    return this.governanceService.create({
      title: dto.title,
      description: dto.description,
      proposer: dto.proposer,
      category: dto.category,
      blockchainTxHash: dto.blockchainTxHash,
      metadata: dto.metadata,
    });
  }

  @Post('proposals/:id/votes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cast a vote on a proposal' })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 201, description: 'Vote cast' })
  @ApiResponse({ status: 400, description: 'Invalid vote data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  @ApiResponse({ status: 409, description: 'Already voted' })
  async castVote(@Param('id') id: string, @Body() dto: CastVoteDto) {
    return this.governanceService.castVote(
      id,
      dto.voter,
      dto.support,
      dto.weight,
      dto.metadata,
    );
  }

  // ── STATE TRANSITIONS — moderator / admin ────────────────────────────────

  @Patch('proposals/:id/activate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Activate a pending proposal' })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 200, description: 'Proposal activated' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async activate(@Param('id') id: string) {
    return this.governanceService.activate(id);
  }

  @Patch('proposals/:id/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel a proposal' })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 200, description: 'Proposal cancelled' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async cancel(@Param('id') id: string) {
    return this.governanceService.cancel(id);
  }

  // ── EXECUTE — admin only ──────────────────────────────────────────────────

  @Patch('proposals/:id/execute')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Execute a passed proposal (admin only)' })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 200, description: 'Proposal executed' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async execute(@Param('id') id: string) {
    return this.governanceService.execute(id);
  }
}
