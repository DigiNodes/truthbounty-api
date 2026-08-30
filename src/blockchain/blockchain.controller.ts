import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { EventIndexingService } from './event-indexing.service';
import { ReconciliationService } from './reconciliation.service';
import { BlockchainStateService } from './state.service';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { BlockchainReorgAlertService } from './blockchain-reorg-alert.service';
import { WeightedVoteResolutionService } from './weighted-vote-resolution.service';
import { BlockInfo, VerificationVote, ResolutionConfig } from './types';

@ApiTags('blockchain')
@Controller('api/v1/blockchain')
export class BlockchainController {
  constructor(
    private eventIndexing: EventIndexingService,
    private reconciliation: ReconciliationService,
    private stateService: BlockchainStateService,
    private indexerService: BlockchainIndexerService,
    private alertService: BlockchainReorgAlertService,
    private voteResolver: WeightedVoteResolutionService,
  ) {}

  /**
   * Process a new block and its events
   */
  @Post('blocks/process')
  async processBlock(
    @Body()
    payload: {
      block: BlockInfo;
      events: any[];
    },
  ) {
    await this.eventIndexing.processBlock(payload.block, payload.events);

    return {
      success: true,
      message: `Block ${payload.block.number} processed`,
      blockNumber: payload.block.number,
    };
  }

  /**
   * Get indexing statistics
   */
  @Get('indexing/stats')
  async getIndexingStats() {
    return this.eventIndexing.getIndexingStats();
  }

  /**
   * Get chain state
   */
  @Get('chain/state')
  async getChainState() {
    return this.stateService.getChainState();
  }

  /**
   * Get all pending events
   */
  @Get('events/pending')
  async getPendingEvents() {
    return this.stateService.getPendingEvents();
  }

  /**
   * Get all confirmed events
   */
  @Get('events/confirmed')
  async getConfirmedEvents() {
    return this.eventIndexing.getConfirmedEvents();
  }

  /**
   * Get all orphaned events
   */
  @Get('events/orphaned')
  async getOrphanedEvents() {
    return this.stateService.getOrphanedEvents();
  }

  /**
   * Get event by ID
   */
  @Get('events/:eventId')
  async getEvent(@Param('eventId') eventId: string) {
    const event = await this.stateService.getEvent(eventId);
    if (!event) {
      return { error: 'Event not found', eventId };
    }
    return event;
  }

  /**
   * Get reorg history
   */
  @Get('reorg/history')
  async getReorgHistory() {
    return this.stateService.getReorgHistory();
  }

  /**
   * Get reorg statistics
   */
  @Get('reorg/statistics')
  async getReorgStatistics() {
    return this.reconciliation.getReorgStatistics();
  }

  /**
   * Verify state consistency
   */
  @Get('state/verify')
  async verifyStateConsistency() {
    return this.reconciliation.verifyStateConsistency();
  }

  /**
   * Get events at a specific block
   */
  @Get('blocks/:blockNumber/events')
  async getBlockEvents(@Param('blockNumber') blockNumber: number) {
    return this.stateService.getEventsByBlock(blockNumber);
  }

  /**
   * Get canonical block at height
   */
  @Get('blocks/:blockNumber/canonical')
  async getCanonicalBlock(@Param('blockNumber') blockNumber: number) {
    const block = await this.stateService.getCanonicalBlock(blockNumber);
    if (!block) {
      return { error: 'Block not found', blockNumber };
    }
    return block;
  }

  /**
   * Manual state reset (for testing/recovery)
   */
  @Post('state/reset')
  async resetState() {
    await this.stateService.clearAllState();
    return { success: true, message: 'State cleared' };
  }

  // -------------------------------------------------------------------
  // Reorg handling endpoints
  // -------------------------------------------------------------------

  /**
   * Verify a block hash against the canonical chain.
   *
   * GET /api/v1/blockchain/reorg/verify?blockNumber=12345&expectedHash=0x...
   */
  @Get('reorg/verify')
  @ApiOperation({ summary: 'Verify a block hash against the canonical chain' })
  @ApiQuery({ name: 'blockNumber', required: true, type: Number })
  @ApiQuery({ name: 'expectedHash', required: true, type: String })
  @ApiQuery({ name: 'rpcUrl', required: false, type: String })
  async verifyBlockHash(
    @Query('blockNumber') blockNumber: number,
    @Query('expectedHash') expectedHash: string,
    @Query('rpcUrl') rpcUrl?: string,
  ) {
    const matches = await this.indexerService.verifyBlockHash(
      blockNumber,
      expectedHash,
      rpcUrl,
    );
    return {
      blockNumber,
      expectedHash,
      matches,
      verifiedAt: new Date(),
    };
  }

  /**
   * Trigger a reorg rollback and replay for a given block range.
   *
   * This is the primary entry point for operational reorg handling. It:
   * 1. Rolls back all events from `startBlock` onward
   * 2. Emits operational alerts at each phase
   * 3. Returns the result for callers to re-index the canonical chain
   *
   * POST /api/v1/blockchain/reorg/handle
   */
  @Post('reorg/handle')
  @ApiOperation({ summary: 'Trigger reorg rollback and emit operational alerts' })
  async handleReorg(
    @Body()
    payload: {
      startBlock: number;
      canonicalHash?: string;
      rpcUrl?: string;
    },
  ) {
    try {
      const result = await this.indexerService.handleReorg(
        payload.startBlock,
        payload.canonicalHash,
        payload.rpcUrl,
      );
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get recent operational alerts (in-memory ring buffer, newest-first).
   *
   * GET /api/v1/blockchain/reorg/alerts?limit=50
   */
  @Get('reorg/alerts')
  @ApiOperation({ summary: 'Get recent reorg operational alerts' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getReorgAlerts(@Query('limit') limit?: number) {
    return this.alertService.getRecentAlerts(limit ?? 50);
  }

  /**
   * Get persisted reorg history from the database.
   *
   * GET /api/v1/blockchain/reorg/history?limit=50
   */
  @Get('reorg/history-db')
  @ApiOperation({ summary: 'Get persisted reorg history from the database' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getReorgHistoryDb(@Query('limit') limit?: number) {
    return this.alertService.getRecentReorgs(limit ?? 50);
  }

  /**
   * Get reorg summary statistics for health checks.
   *
   * GET /api/v1/blockchain/reorg/summary
   */
  @Get('reorg/summary')
  @ApiOperation({ summary: 'Get reorg summary statistics' })
  async getReorgSummary() {
    return this.alertService.getReorgSummary();
  }

  /**
   * Resolve a claim using weighted voting
   * POST /api/v1/blockchain/votes/resolve
   */
  @Post('votes/resolve')
  async resolveClaim(
    @Body()
    payload: {
      votes: VerificationVote[];
      config?: Partial<ResolutionConfig>;
    },
  ) {
    try {
      // Validate input
      const validationErrors = this.voteResolver.validateVotes(payload.votes);
      if (validationErrors.length > 0) {
        return {
          success: false,
          error: 'Invalid vote data',
          details: validationErrors,
        };
      }

      const resolution = this.voteResolver.resolveClaim(
        payload.votes,
        payload.config,
      );

      return {
        success: true,
        resolution,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Validate vote data
   * POST /api/v1/blockchain/votes/validate
   */
  @Post('votes/validate')
  async validateVotes(@Body() payload: { votes: VerificationVote[] }) {
    const errors = this.voteResolver.validateVotes(payload.votes);
    
    return {
      valid: errors.length === 0,
      errors,
      voteCount: payload.votes.length,
    };
  }

  /**
   * Get current resolution configuration
   * GET /api/v1/blockchain/config/resolution
   */
  @Get('config/resolution')
  async getResolutionConfig() {
    return this.voteResolver.getConfig();
  }

  /**
   * Update resolution configuration
   * POST /api/v1/blockchain/config/resolution
   */
  @Post('config/resolution')
  async updateResolutionConfig(@Body() config: Partial<ResolutionConfig>) {
    try {
      this.voteResolver.updateConfig(config);
      return {
        success: true,
        message: 'Configuration updated',
        config: this.voteResolver.getConfig(),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Simulate claim resolution (for testing)
   * POST /api/v1/blockchain/votes/simulate
   */
  @Post('votes/simulate')
  async simulateResolution(
    @Body()
    payload: {
      scenario: 'clear_majority' | 'tie' | 'low_confidence' | 'whale_dominance' | 'insufficient_weight';
      config?: Partial<ResolutionConfig>;
    },
  ) {
    // Generate test votes based on scenario
    const testVotes = this.generateTestVotes(payload.scenario);
    
    const resolution = this.voteResolver.resolveClaim(testVotes, payload.config);
    
    return {
      success: true,
      scenario: payload.scenario,
      votes: testVotes,
      resolution,
    };
  }

  /**
   * Helper method to generate test votes for simulation
   */
  private generateTestVotes(
    scenario: string,
  ): VerificationVote[] {
    const baseVote = {
      claimId: 'simulation-claim-001',
      timestamp: new Date(),
      eventId: 'sim-event-001',
    };

    switch (scenario) {
      case 'clear_majority':
        return [
          { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 80, stakeAmount: '100' },
          { ...baseVote, userId: 'user2', verdict: 'TRUE', userReputation: 70, stakeAmount: '75' },
          { ...baseVote, userId: 'user3', verdict: 'FALSE', userReputation: 60, stakeAmount: '50' },
        ];

      case 'tie':
        return [
          { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 70, stakeAmount: '100' },
          { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 70, stakeAmount: '100' },
        ];

      case 'low_confidence':
        return [
          { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 55, stakeAmount: '50' },
          { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 54, stakeAmount: '50' },
        ];

      case 'whale_dominance':
        return [
          { ...baseVote, userId: 'whale', verdict: 'TRUE', userReputation: 95, stakeAmount: '1000' },
          { ...baseVote, userId: 'user1', verdict: 'FALSE', userReputation: 30, stakeAmount: '25' },
          { ...baseVote, userId: 'user2', verdict: 'FALSE', userReputation: 30, stakeAmount: '25' },
        ];

      case 'insufficient_weight':
        return [
          { ...baseVote, userId: 'user1', verdict: 'TRUE', userReputation: 20, stakeAmount: '10' },
        ];

      default:
        return [];
    }
  }
}
