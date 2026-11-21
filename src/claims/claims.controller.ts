import { Controller, Get, Param, Query, Post, Body, Put, Headers, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { CreateClaimDTO as CreateClaimDto } from './dto/create-claim.dto';
import { SecretQuarantineService } from '../security/secret-quarantine.service';
import { QuarantineAdminGuard } from '../security/quarantine-admin.guard';
import { rejectLegacyProtocolOperation } from './protocol-authority';

@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly quarantineService: SecretQuarantineService,
  ) {}

  @Get('latest')
  @ApiOperation({ summary: 'Deprecated legacy claim list', deprecated: true })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiHeader({ description: 'Opaque pagination cursor (alternative to query param)', required: false })
  @ApiResponse({ status: 410, description: 'Use canonical claim read models' })
  async getLatest(
    @Query('limit') _limit?: number,
    @Query('cursor') _cursor?: string,
    @Headers('x-pagination-cursor') _headerCursor?: string,
    @Headers('host') _host?: string,
  ) {
    return rejectLegacyProtocolOperation(
      'Legacy claim records are not canonical. Use /api/v2/claim-read-models.',
    );
  }

  @Get('user/:wallet')
  @ApiOperation({ summary: 'Deprecated legacy wallet claim list', deprecated: true })
  @ApiParam({ name: 'wallet', description: 'Wallet address' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiHeader({ description: 'Opaque pagination cursor (alternative to query param)', required: false })
  @ApiResponse({ status: 410, description: 'Use canonical claim read models' })
  async getByUser(
    @Param('wallet') _wallet: string,
    @Query('limit') _limit?: number,
    @Query('cursor') _cursor?: string,
    @Headers('x-pagination-cursor') _headerCursor?: string,
    @Headers('host') _host?: string,
  ) {
    return rejectLegacyProtocolOperation(
      'Legacy wallet claim records are not canonical. Query canonical claim and wallet-linked protocol read models.',
    );
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
  @ApiOperation({ summary: 'Deprecated legacy claim detail', deprecated: true })
  @ApiParam({ name: 'id', description: 'Claim ID' })
  @ApiResponse({ status: 410, description: 'Use canonical claim read models' })
  async getOne(@Param('id') _id: string) {
    return rejectLegacyProtocolOperation(
      'Legacy claim IDs are not canonical. Use /api/v2/claim-read-models/{claimId}.',
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Deprecated: claim creation requires a user-signed transaction',
    description:
      'Always returns 410. Submit the claim from the user wallet, then wait for its canonical finalized event in /api/v2/claim-read-models.',
    deprecated: true,
  })
  @ApiResponse({ status: 410, description: 'Use the wallet contract flow' })
  async createOne(@Body() _createClaimDto: CreateClaimDto) {
    return rejectLegacyProtocolOperation(
      'The API cannot create claims. Submit the claim from the user wallet, then wait for its finalized event in /api/v2/claim-read-models.',
    );
  }

  // Evidence endpoints
  @Post(':claimId/evidence')
  @ApiOperation({
    summary: 'Deprecated: evidence registration requires a user-signed transaction',
    description:
      'Always returns 410. Prepare content off-chain if supported, submit registration from the user wallet, then query the canonical V2 evidence projection.',
    deprecated: true,
  })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 410, description: 'Use the wallet contract flow' })
  async createEvidence(
    @Param('claimId') _claimId: string,
    @Body() _body: { cid: string; content?: string; attachments?: unknown[] },
  ) {
    return rejectLegacyProtocolOperation(
      'The API cannot register evidence. Submit the registration from the user wallet and wait for its canonical event.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  @Put('evidence/:evidenceId')
  @ApiOperation({
    summary: 'Deprecated: evidence replacement requires a user-signed transaction',
    description:
      'Always returns 410. Submit evidence replacement from the user wallet and wait for its canonical event.',
    deprecated: true,
  })
  @ApiParam({ name: 'evidenceId', description: 'Evidence ID' })
  @ApiResponse({ status: 410, description: 'Use the wallet contract flow' })
  async updateEvidence(
    @Param('evidenceId') _evidenceId: string,
    @Body() _body: { cid: string; content?: string; attachments?: unknown[] },
  ) {
    return rejectLegacyProtocolOperation(
      'The API cannot replace registered evidence. Submit the replacement from the user wallet and wait for its canonical event.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  @Get(':claimId/evidence')
  @ApiOperation({ summary: 'Deprecated legacy evidence list', deprecated: true })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async getEvidenceForClaim(@Param('claimId') _claimId: string) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence records are not canonical. Use /v2/claims/{claimId}/evidence.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  @Get(':claimId/evidence/latest')
  @ApiOperation({ summary: 'Deprecated legacy latest evidence', deprecated: true })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async getLatestEvidenceForClaim(@Param('claimId') _claimId: string) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence records are not canonical. Use /v2/claims/{claimId}/evidence.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  @Get('evidence/:evidenceId')
  @ApiOperation({ summary: 'Deprecated legacy evidence detail', deprecated: true })
  @ApiParam({ name: 'evidenceId', description: 'Evidence ID' })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async getEvidence(@Param('evidenceId') _evidenceId: string) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence IDs are not canonical. Query by canonical claim ID using /v2/claims/{claimId}/evidence.',
      '/v2/claims/{claimId}/evidence',
    );
  }

}