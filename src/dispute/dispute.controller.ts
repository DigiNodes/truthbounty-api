import {
  Body,
  Controller,
  GoneException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DisputeService } from './dispute.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { ReviewDisputeDto } from './dto/review-dispute.dto';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest } from '../auth/types/authenticated-request';

const workflowValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/** HTTP commands write workflow metadata only; GETs replay finalized canonical events. */
@ApiTags('disputes')
@Controller('disputes')
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

  @Get()
  @ApiOperation({ summary: 'Read finalized canonical disputes' })
  findAll(
    @Query('status') status?: string,
    @Query('trigger') trigger?: string,
  ) {
    return this.disputeService.findAll({ status, trigger });
  }

  @Get('expired')
  @ApiOperation({
    summary: 'Retired local expiry query',
    deprecated: true,
    description:
      'Elapsed local age does not establish protocol expiry. Use the canonical ' +
      'V2 dispute read model with status=expired and inspect its finality metadata.',
  })
  @ApiResponse({
    status: 410,
    description: 'Local dispute expiry has been retired',
  })
  async getExpired(): Promise<never> {
    throw new GoneException({
      statusCode: 410,
      code: 'LOCAL_DISPUTE_EXPIRY_RETIRED',
      message:
        'Dispute expiry is derived from canonical contract events, not local age.',
      replacement: '/api/v2/dispute-read-models?status=expired',
    });
  }

  @Get('claim/:claimId')
  @ApiOperation({
    summary:
      'Read canonical disputes and separately labelled workflow metadata',
  })
  getByClaimId(@Param('claimId') claimId: string) {
    return this.disputeService.getDisputeByClaimId(claimId);
  }

  @Post()
  @Idempotent()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Request non-authoritative review; does not open a contract dispute',
  })
  create(
    @Body(workflowValidation) dto: CreateDisputeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.disputeService.createDispute(dto, req.user);
  }

  @Patch(':id/start-review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start non-authoritative workflow review' })
  startReview(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.disputeService.startReview(id, req.user);
  }

  @Patch(':id/review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Record moderator triage, never a protocol outcome',
  })
  review(
    @Param('id') id: string,
    @Body(workflowValidation) dto: ReviewDisputeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.disputeService.review(id, req.user, dto.status, dto.reason);
  }

  @Patch(':id/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Retired local resolution endpoint',
    deprecated: true,
  })
  @ApiResponse({ status: 410, description: 'Use finalized contract outcomes' })
  resolve(@Param('id') id: string) {
    return this.disputeService.resolveDispute({ disputeId: id });
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Retired local rejection endpoint',
    deprecated: true,
  })
  @ApiResponse({
    status: 410,
    description: 'Use non-authoritative review metadata',
  })
  reject(@Param('id') id: string) {
    return this.disputeService.rejectDispute({ disputeId: id });
  }
}
