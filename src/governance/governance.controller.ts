import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
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
import { ProposalStatus, ProposalCategory } from './entities/proposal.entity';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest } from '../auth/types/authenticated-request';

/**
 * GovernanceController — authorization aligned with the V2 API Authorization Matrix.
 *
 * This surface is a READ MODEL plus OFF-CHAIN DRAFT API. It is not a
 * transaction-submission endpoint and never executes governance. The smart
 * contract is the source of protocol truth.
 *
 * READ routes        → PUBLIC (chain-derived governance projections).
 * CREATE proposal    → AUTHN. Proposer is the verified JWT principal. Without
 *                      canonical evidence the row is an OFFCHAIN_DRAFT/DRAFT;
 *                      with a validated ProposalCreated log it is a canonical
 *                      projection bound to chain + deployment + artifact.
 * CAST vote          → AUTHN. The request carries only a pointer to a
 *                      finalized canonical VoteCast log. Voter, support and
 *                      weight are re-derived from that log; body identity and
 *                      weight fields are deliberately absent and ignored.
 * ACTIVATE / CANCEL  → ROLE(moderator | admin). Index labels for canonical
 *                      rows only; drafts cannot be activated as protocol
 *                      proposals.
 * EXECUTE            → ROLE(admin) only. Records that a passed canonical
 *                      proposal was actioned on-chain; it never settles
 *                      anything locally.
 *
 * @see src/auth/authorization-matrix.ts
 */
@ApiTags('governance')
@Controller('governance')
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  private principal(request: AuthenticatedRequest): string {
    const address = request?.user?.address;
    if (typeof address !== 'string' || address.trim() === '') {
      throw new UnauthorizedException('Verified principal is required');
    }
    return address;
  }

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
  @ApiOperation({
    summary: 'Create an off-chain draft (or project a canonical proposal)',
  })
  @ApiResponse({
    status: 201,
    description:
      'Draft/projection created, labelled with recordKind and dataState',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input or canonical evidence',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateProposalDto,
  ) {
    return this.governanceService.create({
      title: dto.title,
      description: dto.description,
      proposer: this.principal(request),
      category: dto.category,
      canonicalEvent: dto.canonicalEvent,
      metadata: dto.metadata,
    });
  }

  @Post('proposals/:id/votes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Project a finalized canonical VoteCast log' })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 201, description: 'Canonical vote projected' })
  @ApiResponse({
    status: 400,
    description: 'Invalid or non-canonical vote evidence',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  @ApiResponse({ status: 409, description: 'Already voted' })
  async castVote(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: CastVoteDto,
  ) {
    return this.governanceService.castVote(
      id,
      this.principal(request),
      dto.canonicalEvent,
      dto.metadata,
    );
  }

  // ── STATE TRANSITIONS — moderator / admin ────────────────────────────────

  @Patch('proposals/:id/activate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Activate a pending canonical proposal (index label)',
  })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({ status: 200, description: 'Proposal activated' })
  @ApiResponse({
    status: 400,
    description: 'Invalid status transition or draft',
  })
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
  @ApiOperation({
    summary: 'Confirm on-chain execution of a passed canonical proposal',
  })
  @ApiParam({ name: 'id', description: 'Proposal ID' })
  @ApiResponse({
    status: 200,
    description: 'Proposal execution confirmed locally',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid status transition or draft',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async execute(@Param('id') id: string) {
    return this.governanceService.execute(id);
  }
}
