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
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { RejectDisputeDto } from './dto/reject-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import {
  DisputeStatus,
  DisputeTrigger,
  DisputeOutcome,
} from './entities/dispute.entity';

@ApiTags('disputes')
@Controller('disputes')
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new dispute' })
  @ApiResponse({ status: 201, description: 'Dispute created' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(@Body() dto: CreateDisputeDto) {
    return this.disputeService.createDispute(dto);
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
    return this.disputeService.resolveDispute({ disputeId: id, outcome: dto.outcome, finalConfidence: dto.finalConfidence, metadata: dto.metadata });
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject a dispute as spam/invalid' })
  @ApiResponse({ status: 200, description: 'Dispute rejected' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  async reject(@Param('id') id: string, @Body() dto: RejectDisputeDto) {
    return this.disputeService.rejectDispute({ disputeId: id, reason: dto.reason, rejectedBy: dto.rejectedBy });
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
    return this.disputeService.findAll({ status, trigger });
  }
}
