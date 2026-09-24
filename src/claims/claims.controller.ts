import { Controller, Get, Param, Query, Post, Body, Put } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ClaimsService } from './claims.service';
import { EvidenceService } from './evidence.service';
import { CreateClaimDto } from './dto/create-claim.dto';

@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
    constructor(
        private readonly claimsService: ClaimsService,
        private readonly evidenceService: EvidenceService,
    ) { }

    @Get('latest')
    @ApiOperation({ summary: 'Get latest claims' })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiResponse({ status: 200, description: 'List of latest claims' })
    async getLatest(@Query('limit') limit?: number) {
        return this.claimsService.findLatest(limit ? +limit : 10);
    }

    @Get('user/:wallet')
    @ApiOperation({ summary: 'Get claims by user wallet' })
    @ApiParam({ name: 'wallet', description: 'Wallet address' })
    @ApiResponse({ status: 200, description: 'List of user claims' })
    async getByUser(@Param('wallet') wallet: string) {
        return this.claimsService.findByUser(wallet);
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
    @ApiOperation({ summary: 'Create a new claim' })
    @ApiResponse({ status: 201, description: 'Claim created' })
    @ApiResponse({ status: 400, description: 'Invalid input data' })
    async createOne(@Body() createClaimDto: CreateClaimDto) {
        return this.claimsService.createClaim(createClaimDto);
    }

    // Evidence endpoints
    @Post(':claimId/evidence')
    @ApiOperation({ summary: 'Add evidence to a claim' })
    @ApiParam({ name: 'claimId', description: 'Claim ID' })
    @ApiResponse({ status: 201, description: 'Evidence created' })
    async createEvidence(@Param('claimId') claimId: string, @Body() body: { cid: string }) {
        return this.evidenceService.createEvidence(claimId, body.cid);
    }

    @Put('evidence/:evidenceId')
    @ApiOperation({ summary: 'Update evidence with new version' })
    @ApiParam({ name: 'evidenceId', description: 'Evidence ID' })
    @ApiResponse({ status: 200, description: 'Evidence updated' })
    async updateEvidence(@Param('evidenceId') evidenceId: string, @Body() body: { cid: string }) {
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
