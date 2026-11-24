import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { EventIndexingService } from './event-indexing.service';
import { ReconciliationService } from './reconciliation.service';
import { BlockchainStateService } from './state.service';
import { WeightedVoteResolutionService } from './weighted-vote-resolution.service';
import { ReadinessService } from './readiness.service';
import { DeadLetterReplayService } from './dead-letter-replay.service';
import {
  BlockInfo,
  ResolutionConfig,
  VerificationVote,
  DeadLetterReplayRequest,
  DeadLetterReplayResult,
  DeadLetterBatchControlRequest,
  DeadLetterBatchControlResult,
} from './types';
import {
  StreamEnvelope,
  StreamEnvelopeVersion,
  StreamResumeTokenPayload,
  StreamBackfillResponse,
  StreamReconciliationRequirement,
} from './stream.types';
import { StreamResumeService } from './stream-resume.service';
import { WebhookSignatureService } from './webhook-signature.service';

/**
 * Request headers required for dead-letter replay authorization.
 * The capability token is validated by the replay service against the
 * configured protected capability and is never logged or echoed back.
 */
export interface ReplayAuthorizationHeaders {
  'operator-id'?: string;
  'replay-capability'?: string;
}

@ApiTags('blockchain')
@Controller('api/v1/blockchain')
export class BlockchainController {
  constructor(
    private eventIndexing: EventIndexingService,
    private reconciliation: ReconciliationService,
    private stateService: BlockchainStateService,
    private voteResolver: WeightedVoteResolutionService,
    private streamResume: StreamResumeService,
    private readinessService: ReadinessService,
    private replayService: DeadLetterReplayService,
    private webhookSignatureService: WebhookSignatureService,
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
   * Receive and verify an inbound provider webhook.
   * Raw signed bytes are preserved via raw body parsing and verified before
   * any deserialization or side effect. Replays are rejected transactionally.
   */
  @Post('webhooks/:provider')
  @HttpCode(200)
  async handleWebhook(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: Request,
  ) {
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body === undefined ? '' : String(req.body), 'utf8');

    try {
      const result = await this.webhookSignatureService.verifyAndIngest(
        provider,
        headers,
        rawBody,
      );

      return {
        success: true,
        provider,
        deliveryId: result.deliveryId,
        received: true,
      };
    } catch (error) {
      // Fail closed. Never leak secrets or signature details in responses or logs.
      if (error instanceof HttpException) {
        throw error;
      }
      throw new UnauthorizedException('Webhook rejected');
    }
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
   * Get readiness snapshot (internal, detailed).
   */
  @Get('readiness')
  async getReadiness() {
    return this.readinessService.evaluate();
  }

  /**
   * Get sanitized public readiness snapshot.
   */
  @Get('readiness/public')
  async getPublicReadiness() {
    return this.readinessService.getPublicSnapshot();
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
        error: (error as Error).message,
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
      scenario:
        | 'clear_majority'
        | 'tie'
        | 'low_confidence'
        | 'whale_dominance'
        | 'insufficient_weight';
      config?: Partial<ResolutionConfig>;
    },
  ) {
    // Generate test votes based on scenario
    const testVotes = this.generateTestVotes(payload.scenario);

    const resolution = this.voteResolver.resolveClaim(
      testVotes,
      payload.config,
    );

    return {
      success: true,
      scenario: payload.scenario,
      votes: testVotes,
      resolution,
    };
  }

  /**
   * Get the current stream envelope metadata and a fresh resume token.
   * GET /api/v1/blockchain/streams/envelope
   */
  @Get('streams/envelope')
  async getStreamEnvelope(): Promise<StreamEnvelope> {
    return this.streamResume.getCurrentEnvelope();
  }

  /**
   * Resume a stream from an opaque resume token.
   * POST /api/v1/blockchain/streams/resume
   */
  @Post('streams/resume')
  async resumeStream(
    @Body() body: { resumeToken: string },
  ): Promise<StreamBackfillResponse> {
    if (!body || typeof body.resumeToken !== 'string' || body.resumeToken.length === 0) {
      throw new HttpException(
        {
          error: 'invalid_resume_token',
          message: 'resumeToken is required',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.streamResume.resume(body.resumeToken);
    if (!result.ok) {
      throw new HttpException(result.body, result.status);
    }
    return result.body;
  }

  /**
   * Bounded HTTP backfill from a cursor.
   * GET /api/v1/blockchain/streams/backfill?cursor=...&limit=...
   */
  @Get('streams/backfill')
  async backfillStream(
    @Query('cursor') cursor: string,
    @Query('limit') limit?: string,
    @Headers('if-none-match') etag?: string,
  ): Promise<StreamBackfillResponse> {
    if (!cursor || cursor.length === 0) {
      throw new HttpException(
        { error: 'invalid_cursor', message: 'cursor is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (
      parsedLimit !== undefined &&
      (!Number.isFinite(parsedLimit) || parsedLimit <= 0)
    ) {
      throw new HttpException(
        { error: 'invalid_limit', message: 'limit must be a positive integer' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.streamResume.backfill(cursor, parsedLimit, etag);
    if (!result.ok) {
      throw new HttpException(result.body, result.status);
    }
    return result.body;
  }

  /**
   * Decode a resume token for observability / client reconciliation.
   * Tokens are opaque to clients but can be inspected to determine whether a
   * canonical resync is required. No protected payload is returned.
   * GET /api/v1/blockchain/streams/token/inspect?token=...
   */
  @Get('streams/token/inspect')
  async inspectResumeToken(
    @Query('token') token: string,
  ): Promise<StreamReconciliationRequirement> {
    if (!token || token.length === 0) {
      throw new HttpException(
        { error: 'invalid_resume_token', message: 'token is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.streamResume.inspectToken(token);
  }

  /**
   * Replay a single dead-letter message.
   *
   * Replay is denied by default: the caller must supply the protected
   * capability header, an explicit reason, bounds, a dry-run flag, and the
   * original payload hash. The service enforces release/schema compatibility,
   * idempotency, and audit recording.
   */
  @Post('dead-letter/replay')
  @ApiTags('dead-letter')
  async replayDeadLetter(
    @Body() request: DeadLetterReplayRequest,
    @Headers() headers: ReplayAuthorizationHeaders,
  ): Promise<DeadLetterReplayResult> {
    return this.replayService.replaySingle(request, {
      capability: headers['replay-capability'],
      operatorId: headers['operator-id'],
    });
  }

  /**
   * Replay a bounded batch of dead-letter messages.
   */
  @Post('dead-letter/replay/batch')
  @ApiTags('dead-letter')
  async replayDeadLetterBatch(
    @Body() request: DeadLetterBatchControlRequest,
    @Headers() headers: ReplayAuthorizationHeaders,
  ): Promise<DeadLetterBatchControlResult> {
    return this.replayService.replayBatch(request, {
      capability: headers['replay-capability'],
      operatorId: headers['operator-id'],
    });
  }

  /**
   * Stop an in-flight bounded replay batch.
   */
  @Post('dead-letter/replay/batch/:replayId/stop')
  @ApiTags('dead-letter')
  async stopDeadLetterReplayBatch(
    @Param('replayId') replayId: string,
    @Headers() headers: ReplayAuthorizationHeaders,
  ): Promise<DeadLetterBatchControlResult> {
    return this.replayService.stopBatch(replayId, {
      capability: headers['replay-capability'],
      operatorId: headers['operator-id'],
    });
  }

  /**
   * Resume a stopped bounded replay batch.
   */
  @Post('dead-letter/replay/batch/:replayId/resume')
  @ApiTags('dead-letter')
  async resumeDeadLetterReplayBatch(
    @Param('replayId') replayId: string,
    @Headers() headers: ReplayAuthorizationHeaders,
  ): Promise<DeadLetterBatchControlResult> {
    return this.replayService.resumeBatch(replayId, {
      capability: headers['replay-capability'],
      operatorId: headers['operator-id'],
    });
  }

  /**
   * Get the immutable audit record for a replay (original -> replay linkage).
   */
  @Get('dead-letter/replay/:replayId/audit')
  @ApiTags('dead-letter')
  async getDeadLetterReplayAudit(
    @Param('replayId') replayId: string,
    @Headers() headers: ReplayAuthorizationHeaders,
  ) {
    return this.replayService.getAuditRecord(replayId, {
      capability: headers['replay-capability'],
      operatorId: headers['operator-id'],
    });
  }

  /**
   * Helper method to generate test votes for simulation
   */
  private generateTestVotes(scenario: string): VerificationVote[] {
    const baseVote = {
      claimId: 'simulation-claim-001',
      timestamp: new Date(),
      eventId: 'sim-event-001',
    };

    switch (scenario) {
      case 'clear_majority':
        return [
          {
            ...baseVote,
            userId: 'user1',
            verdict: 'TRUE',
            userReputation: 80,
            stakeAmount: '100',
          },
          {
            ...baseVote,
            userId: 'user2',
            verdict: 'TRUE',
            userReputation: 70,
            stakeAmount: '75',
          },
          {
            ...baseVote,
            userId: 'user3',
            verdict: 'FALSE',
            userReputation: 60,
            stakeAmount: '50',
          },
        ];

      case 'tie':
        return [
          {
            ...baseVote,
            userId: 'user1',
            verdict: 'TRUE',
            userReputation: 70,
            stakeAmount: '100',
          },
          {
            ...baseVote,
            userId: 'user2',
            verdict: 'ALSE',
            userReputation: 70,
            stakeAmount: '100',
          },
        ];

      case 'low_confidence':
        return [
          {
            ...baseVote,
            userId: 'user1',
            verdict: 'TRUE',
            userReputation: 55,
            stakeAmount: '50',
          },
          {
            ...baseVote,
            userId: 'user2',
            verdict: 'FALSE',
            userReputation: 54,
            stakeAmount: '50',
          },
        ];

      case 'whale_dominance':
        return [
          {
            ...baseVote,
            userId: 'whale',
            verdict: 'TRUE',
            userReputation: 95,
            stakeAmount: '1000',
          },
          {
            ...baseVote,
            userId: 'user1',
            verdict: 'FALSE',
            userReputation: 30,
            stakeAmount: '25',
          },
          {
            ...baseVote,
            userId: 'user2',
            verdict: 'FALSE',
            userReputation: 30,
            stakeAmount: '25',
          },
        ];

      case 'insufficient_weight':
        return [
          {
            ...baseVote,
            userId: 'user1',
            verdict: 'TRUE',
            userReputation: 20,
            stakeAmount: '10',
          },
        ];

      default:
        return [];
    }
  }
}