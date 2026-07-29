import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ReputationService } from './reputation.service';
import { QueryReputationDto } from './dto/query-reputation.dto';
import { ReputationEventType } from './entities/reputation.entity';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';

@ApiTags('reputation')
@Controller('reputation')
export class ReputationController {
  constructor(private readonly reputationService: ReputationService) {}

  // ─── Reputation Retrieval ─────────────────────────────────────────────

  @Get('user/:wallet')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get reputation for a wallet address' })
  @ApiParam({ name: 'wallet', description: 'Wallet address' })
  @ApiResponse({ status: 200, description: 'Reputation record' })
  @ApiResponse({ status: 404, description: 'Reputation not found' })
  async getByWallet(@Param('wallet') wallet: string) {
    return this.reputationService.findByWalletOrThrow(wallet);
  }

  @Get('users')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get reputation for multiple wallets' })
  @ApiQuery({ name: 'wallets', description: 'Comma-separated wallet addresses', type: String })
  @ApiResponse({ status: 200, description: 'List of reputation records' })
  async getMany(@Query('wallets') wallets: string) {
    const walletList = wallets?.split(',').map((w) => w.trim()) ?? [];
    return this.reputationService.findMany(walletList);
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'List all reputation records with filters' })
  @ApiQuery({ name: 'walletAddress', required: false, type: String })
  @ApiQuery({ name: 'minScore', required: false, type: Number })
  @ApiQuery({ name: 'maxScore', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['highest', 'newest', 'most_active', 'highest_rewards'],
  })
  @ApiResponse({ status: 200, description: 'Paginated reputation records' })
  async findAll(
    @Query() query: QueryReputationDto,
  ) {
    return this.reputationService.findAll(query);
  }

  // ─── Reputation History ───────────────────────────────────────────────

  @Get('user/:wallet/events')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get reputation events for a wallet' })
  @ApiParam({ name: 'wallet', description: 'Wallet address' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'eventType',
    required: false,
    enum: ReputationEventType,
  })
  @ApiResponse({ status: 200, description: 'List of reputation events' })
  async getEvents(
    @Param('wallet') wallet: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('eventType') eventType?: ReputationEventType,
  ) {
    return this.reputationService.getEvents(wallet, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      eventType,
    });
  }

  // ─── Leaderboards ─────────────────────────────────────────────────────

  @Get('leaderboard')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get reputation leaderboard' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['highest', 'fastest_growing', 'most_active', 'highest_rewards'],
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Leaderboard entries' })
  async getLeaderboard(
    @Query('type') type?: 'highest' | 'fastest_growing' | 'most_active' | 'highest_rewards',
    @Query('limit') limit?: number,
  ) {
    return this.reputationService.getLeaderboard(
      type ?? 'highest',
      limit ? +limit : undefined,
    );
  }

  // ─── Analytics ────────────────────────────────────────────────────────

  @Get('stats')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get reputation statistics' })
  @ApiResponse({ status: 200, description: 'Reputation stats' })
  async getStats() {
    return this.reputationService.getStats();
  }

  // ─── Search ───────────────────────────────────────────────────────────

  @Get('search')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Search reputation by wallet address' })
  @ApiQuery({ name: 'q', description: 'Search query', type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Search results' })
  async search(
    @Query('q') q: string,
    @Query('limit') limit?: number,
  ) {
    return this.reputationService.search(q, limit ? +limit : undefined);
  }
}
