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
import { EvidenceService } from './evidence.service';
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
    private readonly evidenceService: EvidenceService,
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
  @ApiOperation({ summary: 'List evidence with bounded pagination' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'claimId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Paginated evidence list' })
  async listEvidence(@Query() query: EvidenceListQueryDto) {
    return this.evidenceService.listEvidence(query);
  }

  // GET /evidence/:id
  @Get(':id')
  @ApiOperation({ summary: 'Get a single evidence with all versions' })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiResponse({ status: 200, description: 'Evidence detail' })
  @ApiResponse({ status: 404, description: 'Evidence not found' })
  async getEvidence(@Param('id') id: string) {
    return this.evidenceService.getEvidenceOrFail(id);
  }

  // GET /evidence/:id/versions
  @Get(':id/versions')
  @ApiOperation({ summary: 'List evidence versions (newest first)' })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated versions' })
  @ApiResponse({ status: 404, description: 'Evidence not found' })
  async listVersions(
    @Param('id') id: string,
    @Query() query: EvidenceVersionQueryDto,
  ) {
    return this.evidenceService.listEvidenceVersions(id, query);
  }

  // GET /evidence/:id/digest?version=n
  @Get(':id/digest')
  @ApiOperation({ summary: 'Get content digest for an evidence version' })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiQuery({ name: 'version', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Content digest' })
  @ApiResponse({ status: 400, description: 'Invalid stored CID' })
  @ApiResponse({ status: 404, description: 'Evidence or version not found' })
  async getDigest(
    @Param('id') id: string,
    @Query() query: EvidenceVersionSelectionDto,
  ) {
    return this.evidenceService.getContentDigest(id, query.version);
  }

  // GET /evidence/:id/gateway?version=n
  @Get(':id/gateway')
  @ApiOperation({
    summary: 'Get safe gateway metadata for an evidence version',
  })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiQuery({ name: 'version', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Safe gateway metadata' })
  @ApiResponse({ status: 404, description: 'Evidence or version not found' })
  async getGateway(
    @Param('id') id: string,
    @Query() query: EvidenceVersionSelectionDto,
  ) {
    return this.evidenceService.getSafeGateway(id, query.version);
  }

  // GET /evidence/:id/status
  @Get(':id/status')
  @ApiOperation({
    summary:
      'Distinguish missing on-chain registration from unavailable off-chain content',
  })
  @ApiParam({ name: 'id', description: 'Evidence ID' })
  @ApiResponse({ status: 200, description: 'Availability status' })
  @ApiResponse({ status: 404, description: 'Evidence not found' })
  async getStatus(@Param('id') id: string) {
    return this.evidenceService.getAvailabilityStatus(id);
  }
}
