import {
  Controller,
  Post,
  Param,
  Body,
  Get,
  Query,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { EvidenceFlagService } from './evidence-flag.service';
import { rejectLegacyProtocolOperation } from './protocol-authority';
import {
  EvidenceListQueryDto,
  EvidenceVersionQueryDto,
  EvidenceVersionSelectionDto,
} from './dto/evidence-query.dto';

class CreateFlagDto {
  reason: string;
  flaggedBy?: string;
}

@ApiTags('evidence')
@Controller('evidence')
export class EvidenceController {
  constructor(
    private readonly flagService: EvidenceFlagService,
  ) {}

  // POST /evidence/:id/flag
  @Post(':id/flag')
  async flagEvidence(@Param('id') id: string, @Body() body: CreateFlagDto) {
    if (!body || !body.reason) {
      throw new BadRequestException('reason is required');
    }

    return this.flagService.createFlag(id, body.reason, body.flaggedBy);
  }

  // GET /evidence/:id/flags?admin=true
  @Get(':id/flags')
  async getFlags(@Param('id') id: string, @Query('admin') admin?: string) {
    if (!admin || admin !== 'true') {
      throw new ForbiddenException('Flags are restricted to admins');
    }

    return this.flagService.getFlagsForEvidence(id);
  }

  // GET /evidence
  @Get()
  @ApiOperation({ summary: 'Deprecated legacy evidence list', deprecated: true })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'claimId', required: false, type: String })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async listEvidence(@Query() _query: EvidenceListQueryDto) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence rows are not canonical. Query evidence by canonical claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  // GET /evidence/:id
  @Get(':id')
  @ApiOperation({ summary: 'Deprecated legacy evidence detail', deprecated: true })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async getEvidence(@Param('id') _id: string) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence IDs are not canonical. Query evidence by canonical claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  // GET /evidence/:id/versions
  @Get(':id/versions')
  @ApiOperation({ summary: 'Deprecated legacy evidence versions', deprecated: true })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async listVersions(
    @Param('id') _id: string,
    @Query() _query: EvidenceVersionQueryDto,
  ) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence versions are not canonical. Query versions by canonical claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  // GET /evidence/:id/digest?version=n
  @Get(':id/digest')
  @ApiOperation({ summary: 'Deprecated legacy evidence digest', deprecated: true })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiQuery({ name: 'version', required: false, type: Number })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async getDigest(
    @Param('id') _id: string,
    @Query() _query: EvidenceVersionSelectionDto,
  ) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence digests are not canonical. Query evidence by canonical claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  // GET /evidence/:id/gateway?version=n
  @Get(':id/gateway')
  @ApiOperation({
    summary: 'Deprecated legacy evidence gateway', deprecated: true,
  })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiQuery({ name: 'version', required: false, type: Number })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async getGateway(
    @Param('id') _id: string,
    @Query() _query: EvidenceVersionSelectionDto,
  ) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence gateway metadata is not canonical. Query evidence by canonical claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  // GET /evidence/:id/status
  @Get(':id/status')
  @ApiOperation({
    summary: 'Deprecated legacy evidence status', deprecated: true,
  })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiResponse({ status: 410, description: 'Use canonical V2 evidence' })
  async getStatus(@Param('id') _id: string) {
    return rejectLegacyProtocolOperation(
      'Legacy evidence status is not canonical. Query evidence by canonical claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }
}
