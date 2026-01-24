import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DisputeService } from './dispute.service';
import { DisputeStatus, DisputeTrigger, DisputeOutcome } from './entities/dispute.entity';

class CreateDisputeDto {
  claimId: string;
  trigger: DisputeTrigger;
  originalConfidence: number;
  initiatorId?: string;
  metadata?: Record<string, any>;
}

class ResolveDisputeDto {
  outcome: DisputeOutcome;
  finalConfidence: number;
  metadata?: Record<string, any>;
}

class RejectDisputeDto {
  reason: string;
}

@ApiTags('disputes')
@Controller('disputes')
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new dispute' })
  @ApiResponse({ status: 201, description: 'Dispute created' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(@Body() dto: CreateDisputeDto) {
    return this.disputeService.createDispute(
      dto.claimId,
      dto.trigger,
      dto.originalConfidence,
      dto.initiatorId,
      dto.metadata,
    );
  }

  @Patch(':id/start-review')
  @ApiOperation({ summary: 'Start dispute review process' })
  @ApiResponse({ status: 200, description: 'Review started' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async startReview(@Param('id') id: string) {
    return this.disputeService.startReview(id);
  }

  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Resolve a dispute' })
  @ApiResponse({ status: 200, description: 'Dispute resolved' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async resolve(@Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return this.disputeService.resolveDispute(
      id,
      dto.outcome,
      dto.finalConfidence,
      dto.metadata,
    );
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject a dispute as spam/invalid' })
  @ApiResponse({ status: 200, description: 'Dispute rejected' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async reject(@Param('id') id: string, @Body() dto: RejectDisputeDto) {
    return this.disputeService.rejectDispute(id, dto.reason);
  }

  @Get('claim/:claimId')
  @ApiOperation({ summary: 'Get dispute by claim ID' })
  @ApiResponse({ status: 200, description: 'Dispute found' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async getByClaimId(@Param('claimId') claimId: string) {
    return this.disputeService.getDisputeByClaimId(claimId);
  }

  @Get('expired')
  @ApiOperation({ summary: 'Get expired disputes' })
  @ApiResponse({ status: 200, description: 'List of expired disputes' })
  async getExpired() {
    return this.disputeService.getExpiredDisputes();
  }

  @Get()
  @ApiOperation({ summary: 'Get all disputes with optional filters' })
  @ApiResponse({ status: 200, description: 'List of disputes' })
  async findAll(
    @Query('status') status?: DisputeStatus,
    @Query('trigger') trigger?: DisputeTrigger,
  ) {
    return this.disputeService.findAll(status, trigger);
  }
}