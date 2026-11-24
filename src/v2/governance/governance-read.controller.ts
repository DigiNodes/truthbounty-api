import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { GovernanceReadService } from './governance-read.service';
import { ProposalChainState } from './entities/governance-proposal.entity';

/**
 * GovernanceReadController — V2-BE-067
 *
 * READ-ONLY. Exposes chain-derived governance state under /v2/governance.
 * No state-changing endpoint exists here; mutations remain the smart
 * contract's authority. Every response is a projection of CanonicalEvent
 * rows that were decoded under an approved artifact version.
 */
@ApiTags('governance-v2')
@Controller('v2/governance')
export class GovernanceReadController {
  constructor(private readonly read: GovernanceReadService) {}

  @Get('proposals')
  @ApiOperation({ summary: 'List governance proposals (cursor-paginated)' })
  @ApiQuery({ name: 'chainId', type: Number })
  @ApiQuery({ name: 'state', required: false, enum: ProposalChainState })
  @ApiQuery({ name: 'proposer', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated proposal list' })
  async list(
    @Query('chainId', ParseIntPipe) chainId: number,
    @Query('state') state?: ProposalChainState,
    @Query('proposer') proposer?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.read.listProposals({
      chainId,
      state,
      proposer,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? null,
    });
  }

  @Get('proposals/:proposalId')
  @ApiOperation({ summary: 'Get a proposal by ID (chain-derived)' })
  @ApiParam({ name: 'proposalId', type: String })
  @ApiQuery({ name: 'chainId', type: Number })
  @ApiResponse({ status: 200, description: 'Proposal read model' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async getProposal(
    @Param('proposalId') proposalId: string,
    @Query('chainId', ParseIntPipe) chainId: number,
  ) {
    return this.read.getProposal(chainId, proposalId);
  }

  @Get('proposals/:proposalId/timelock')
  @ApiOperation({
    summary:
      'Get the timelock projection for a proposal (state + ETA from chain)',
  })
  @ApiParam({ name: 'proposalId', type: String })
  @ApiQuery({ name: 'chainId', type: Number })
  @ApiResponse({ status: 200, description: 'Timelock read model' })
  @ApiResponse({ status: 404, description: 'Proposal not found' })
  async getTimelock(
    @Param('proposalId') proposalId: string,
    @Query('chainId', ParseIntPipe) chainId: number,
  ) {
    return this.read.getTimelock(chainId, proposalId);
  }

  @Get('role-changes')
  @ApiOperation({
    summary: 'Audit trail of RoleGranted / RoleRevoked events',
  })
  @ApiQuery({ name: 'chainId', type: Number })
  @ApiQuery({ name: 'account', required: false, type: String })
  @ApiQuery({ name: 'role', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated role-change audit' })
  async listRoleChanges(
    @Query('chainId', ParseIntPipe) chainId: number,
    @Query('account') account?: string,
    @Query('role') role?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.read.listRoleChanges({
      chainId,
      account,
      role,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? null,
    });
  }
}
