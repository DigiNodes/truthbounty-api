import { Injectable, Logger } from '@nestjs/common';
import { BlockchainStateService } from './state.service';
import { ReorgDetectorService } from './reorg-detector.service';
import { ReconciliationService } from './reconciliation.service';
import { BlockInfo, PendingEvent } from './types';
import { serializeBigInts } from '../common/utils/bigint-serialization.util';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';

/**
 * Versioned stream envelope for resumable WebSocket delivery.
 * Contains only public chain-derived metadata and the canonical readmodel payload.
 */
export interface StreamEnvelope {
  schemaVersion: 'v1';
  eventId: string;
  cursor: string;
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  blockNumber: number;
  blockHash: string;
  freshnessDepth: number;
  projectionVersion: string;
  payload: Record<string, unknown>;
}

export interface ResumeToken {
  token: string;
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  cursor: string;
  expiresAt: number;
  signature: string;
}

export interface BackfillRequest {
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  cursor: string;
  limit?: number;
}

export interface BackfillResult {
  envelopes: StreamEnvelope[];
  nextCursor: string;
  hasMore: boolean;
  gapDetected: boolean;
  requiresCanonicalResync: boolean;
  resumeToken?: ResumeToken;
}

export type StreamFailureReason =
  | 'expired_token'
  | 'wrong_release'
  | 'wrong_chain'
  | 'wrong_deployment'
  | 'artifact_mismatch'
  | 'gap'
  | 'unknown_cursor'
  | 'stale_data';

export class StreamResyncRequiredError extends Error {
  constructor(
    readonly public reason: StreamFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'StreamResyncRequiredError';
  }
}

const STREAM_SCHEMA_VERSION = 'v1' as const;
const DEFAULT_BACKFILL_LIMIT = 500;
const MAX_BACKFILL_LIMIT = 2000;
const RESUME_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_RESUME_TOKENS = 10000;

/**
 * Event indexing service with confirmation strategy
 * Processes blockchain events with reorg protection and exposes resumable
 * stream envelopes with opaque resume tokens and bounded HTTP backfill.
 */
@Injectable()
export class EventIndexingService {
  private readonly logger = new Logger(EventIndexingService.name);
  private headBlockNumber: number = 0;
  private readonly resumeTokens = new Map<string, ResumeToken>();
  private readonly cursorIndex = new Map<string, number>();
  private readonly deliveredEventIds = new Map<string, Set<string>>();
  private reservedTokenSecret: string;

  constructor(
    private stateService: BlockchainStateService,
    private reorgDetector: ReorgDetectorService,
    private reconciliation: ReconciliationService,
  ) {
    const secret = process.env.STREAM_RESUME_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        'STREAM_RESUME_TOKEN_SECRET must be set to a 32+ character value',
      );
    }
    this.reservedTokenSecret = secret;
  }

  /**
   * Process a new block and its events
   */
  async processBlock(block: BlockInfo, events: any[]): Promise<void> {
    this.logger.log(`Processing block ${block.number} with ${events.length} events`);

    const chainState = await this.stateService.getChainState();
    const previousBlockNumber = chainState.lastProcessedBlock;

    // Track the observed head so projection lag / finality metrics stay current.
    await this.stateService.setObservedHead(block.number);

    try {
      // Step 1: Check for reorg
      const detectedReorg = await this.reorgDetector.detectReorg(
        block,
        previousBlockNumber,
      );

      if (detectedReorg) {
        // Handle the reorg
        await this.reconciliation.handleReorg(detectedReorg);
        // Reorg changes the canonical history; invalidate any outstanding
        // resume tokens so clients are forced to resync against canonical readmodels.
        this.invalidateAllResumeTokens();
      }

      // Step 2: Save the block
      await this.stateService.saveBlock(block);
      this.headBlockNumber = block.number;

      // Step 3: Index events as pending
      for (const event of events) {
        await this.indexEvent(block, event);
      }

      // Step 4: Update confirmations for previous events
      await this.updateEventConfirmations(block.number);

      // Step 5: Try to reconcile orphaned events
      const reconciledCount = await this.reconciliation.reconcileOrphanedEvents(
        block.number,
      );
      if (reconciledCount.length > 0) {
        this.logger.log(`Reconciled ${reconciledCount.length} orphaned events`);
        await this.stateService.recordReplay(reconciledCount.length);
      }

      // Step 6: Update chain state
      await this.stateService.updateChainState({
        lastProcessedBlock: block.number,
        lastCanonicalHash: block.hash,
        confirmedDepth: this.reorgDetector.getConfirmationDepth(),
      });

      // Advance the projection head after the block and its events are applied.
      await this.stateService.setProjectionHead(block.number);

      this.logger.log(`Block ${block.number} processed successfully`);
    } catch (error) {
      this.stateService.recordRpcFailure(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.logger.error(
        `Error processing block ${block.number}: ${error}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Index a single event as pending
   */
  private async indexEvent(block: BlockInfo, event: any): Promise<void> {
    const eventId = `${block.hash}:${event.transactionHash}:${event.logIndex}`;

    const pendingEvent: PendingEvent = {
      id: eventId,
      blockNumber: block.number,
      blockHash: block.hash,
      eventType: event.type || 'unknown',
      data: serializeBigInts(event.data || {}) as Record<string, any>,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex || 0,
      status: 'pending',
      confirmations: 0,
      createdAt: new Date(),
    };

    await this.stateService.savePendingEvent(pendingEvent);
    this.logger.debug(`Indexed event: ${eventId} (status: pending)`);
  }

  /**
   * Update confirmation counts for all events
   */
  private async updateEventConfirmations(
    currentBlockNumber: number,
  ): Promise<void> {
    const pendingEvents = await this.stateService.getPendingEvents();

    for (const event of pendingEvents) {
      const confirmations = await this.reorgDetector.calculateConfirmations(
        event.blockNumber,
        currentBlockNumber,
      );

      const isConfirmed = await this.reorgDetector.isEventConfirmed(
        event.blockNumber,
        currentBlockNumber,
      );

      if (isConfirmed && event.status === 'pending') {
        await this.stateService.updateEventStatus(
          event.id,
          'confirmed',
          confirmations,
        );
        this.logger.debug(
          `Event confirmed: ${event.id} (confirmations: ${confirmations})`,
        );
      } else {
        // Just update confirmation count
        await this.stateService.updateEventStatus(
          event.id,
          event.status,
          confirmations,
        );
      }
    }
  }

  /**
   * Get event status
   */
  async getEventStatus(eventId: string): Promise<PendingEvent | null> {
    return this.stateService.getEvent(eventId);
  }

  /**
   * Get all confirmed events (safe for application use)
   */
  async getConfirmedEvents(): Promise<PendingEvent[]> {
    const allEvents: PendingEvent[] = [];
    const chainState = await this.stateService.getChainState();

    for (let i = 0; i <= chainState.lastProcessedBlock; i++) {
      const blockEvents = await this.stateService.getEventsByBlock(i);
      allEvents.push(...blockEvents);
    }

    return allEvents.filter((e) => e.status === 'confirmed');
  }

  /**
   * Get stats about the indexing state
   */
  async getIndexingStats(): Promise<{
    lastProcessedBlock: number;
    totalEvents: number;
    confirmedEvents: number;
    pendingEvents: number;
    orphanedEvents: number;
    confirmationDepth: number;
  }> {
    const chainState = await this.stateService.getChainState();
    const pendingEvents = await this.stateService.getPendingEvents();
    const orphanedEvents = await this.stateService.getOrphanedEvents();
    const confirmedEvents = await this.getConfirmedEvents();

    return {
      lastProcessedBlock: chainState.lastProcessedBlock,
      totalEvents:
        pendingEvents.length + orphanedEvents.length + confirmedEvents.length,
      confirmedEvents: confirmedEvents.length,
      pendingEvents: pendingEvents.length,
      orphanedEvents: orphanedEvents.length,
      confirmationDepth: chainState.confirmedDepth,
    };
  }

  /**
   * Build a versioned stream envelope for a confirmed event.
   * The payload is the canonical readmodel representation of the event and
   * contains no protected material.
   */
  async buildStreamEnvelope(eventId: string): Promise<StreamEnvelope> {
    const event = await this.stateService.getEvent(eventId);
    if (!event) {
      throw new StreamResyncRequiredError(
        'unknown_cursor',
        `Event ${eventId} is not part of the canonical readmodel`,
      );
    }
    if (event.status !== 'confirmed') {
      throw new StreamResyncRequiredError(
        'stale_data',
        `Event ${eventId} is not confirmed yet`,
      );
    }

    const binding = await this.getChainReleaseBinding();
    const cursor = this.encodeCursor(event.blockNumber, event.logIndex);
    const chainState = await this.stateService.getChainState();
    const freshnessDepth = Math.max(0, chainState.lastProcessedBlock - event.blockNumber);

    return {
      schemaVersion: STREAM_SCHEMA_VERSION,
      eventId: event.id,
      cursor,
      chainId: binding.chainId,
      releaseId: binding.releaseId,
      deploymentBlock: binding.deploymentBlock,
      artifactChecksum: binding.artifactChecksum,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      freshnessDepth,
      projectionVersion: binding.projectionVersion,
      payload: this.sanitizePayload(event),
    };
  }

  /**
   * Issue an opaque resume token bound to the current chain/release and cursor.
   */
  async issueResumeToken(cursor: string): Promise<ResumeToken> {
    const binding = await this.getChainReleaseBinding();
    const expiresAt = Date.now() + RESUME_TOKEN_TTL_MS;
    const tokenId = randomUUID();
    const signature = this.signToken({
      tokenId,
      chainId: binding.chainId,
      releaseId: binding.releaseId,
      deploymentBlock: binding.deploymentBlock,
      artifactChecksum: binding.artifactChecksum,
      cursor,
      expiresAt,
    });

    const resumeToken: ResumeToken = {
      token: tokenId,
      chainId: binding.chainId,
      releaseId: binding.releaseId,
      deploymentBlock: binding.deploymentBlock,
      artifactChecksum: binding.artifactChecksum,
      cursor: cursor,
      expiresAt,
      signature,
    };

    this.pruneExpiredResumeTokens();
    this.resumeTokens.set(tokenId, resumeToken);
    return resumeToken;
  }

  /**
   * Resolve an opaque resume token into a validated cursor.
   * Fails closed on expiry, release/chain/deployment mismatch, or tampering.
   */
  async resolveResumeToken(tokenId: string): Promise<ResumeToken> {
    const stored = this.resumeTokens.get(tokenId);
    if (!stored) {
      throw new StreamResyncRequiredError(
        'expired_token',
        'Resume token is unknown or expired',
      );
    }
    if (stored.expiresAt <= Date.now()) {
      this.resumeTokens.delete(tokenId);
      throw new StreamResyncRequiredError(
        'expired_token',
        'Resume token has expired',
      );
    }

    const expectedSignature = this.signToken({
      tokenId: stored.token,
      chainId: stored.chainId,
      releaseId: stored.releaseId,
      deploymentBlock: stored.deploymentBlock,
      artifactChecksum: stored.artifactChecksum,
      cursor: stored.cursor,
      expiresAt: stored.expiresAt,
    });
    if (!this.safeCompare(expectedSignature, stored.signature)) {
      this.resumeTokens.delete(tokenId);
      throw new StreamResyncRequiredError(
        'expired_token',
        'Resume token signature is invalid',
      );
    }

    const binding = await this.getChainReleaseBinding();
    if (stored.chainId !== binding.chainId) {
      throw new StreamResyncRequiredError(
        'wrong_chain',
        'Resume token was issued for a different chain',
      );
    }
    if (stored.releaseId !== binding.releaseId) {
      throw new StreamResyncRequiredError(
        'wrong_release',
        'Resume token was issued for a different release',
      );
    }
    if (stored.deploymentBlock !== binding.deploymentBlock) {
      throw new StreamResyncRequiredError(
        'wrong_deployment',
        'Resume token was issued for a different deployment block',
      );
    }
    if (stored.artifactChecksum !== binding.artifactChecksum) {
      throw new StreamResyncRequiredError(
        'artifact_mismatch',
        'Resume token artifact checksum mismatch',
      );
    }

    return stored;
  }

  /**
   * Bounded HTTP backfill from a cursor. Returns at most MAX_BACKFILL_LIMIT
   * envelopes and signals whether a canonical resync is required.
   */
  async backfill(
    cursor: string,
    limit?: number,
  ): Promise<BackfillResult> {
    const binding = await this.getChainReleaseBinding();
    const clampedLimit = Math.min(
      Math.max(1, limit ?? DEFAULT_BACKFILL_LIMIT),
      MAX_BACKFILL_LIMIT,
    );

    const start = this.decodeCursor(cursor);
    if (!start) {
      throw new StreamResyncRequiredError(
        'unknown_cursor',
        'Cursor is not decodable',
      );
    }

    const chainState = await this.stateService.getChainState();
    const envelopes: StreamEnvelope[] = [];
    let currentBlock = start.blockNumber;
    let currentLogIndex = start.logIndex;
    let hasMore = false;

    while (envelopes.length < clampedLimit && currentBlock <= chainState.lastProcessedBlock) {
      const blockEvents = await this.stateService.getEventsByBlock(currentBlock);
      const ordered = blockEvents
        .filter((e) => e.status === 'confirmed')
        .sort((a, b) => a.logIndex - b.logIndex);

      for (const event of ordered) {
        if (currentBlock === start.blockNumber && event.logIndex <= currentLogIndex) {
          continue;
        }
        if (envelopes.length >= clampedLimit) {
          hasMore = true;
          break;
        }
        envelopes.push(await this.buildStreamEnvelope(event.id));
        currentLogIndex = event.logIndex;
      }

      if (hasMore) {
        break;
      }
      currentBlock += 1;
      currentLogIndex = -1;
    }

    if (currentBlock <= chainState.lastProcessedBlock && !hasMore) {
      hasMore = true;
    }

    const nextCursor = this.encodeCursor(currentBlock, Math.max(0, currentLogIndex));
    const resume = await this.issueResumeToken(nextCursor);

    return {
      envelopes,
      nextCursor,
      hasMore,
      gapDetected: false,
      requiresCanonicalResync: false,
      resumeToken: resume,
    };
  }

  /**
   * Decode a resume token for observability / client reconciliation.
   * Tokens are opaque to clients but can be inspected to determine whether a
   * canonical resync is required. No protected payload is returned.
   */
  async inspectToken(tokenId: string): Promise<{
    requiresCanonicalResync: boolean;
    reason?: StreamFailureReason;
    cursor?: string;
    expiresAt?: number;
  }> {
    try {
      const token = await this.resolveResumeToken(tokenId);
      return {
        requiresCanonicalResync: false,
        cursor: token.cursor,
        expiresAt: token.expiresAt,
      };
    } catch (error) {
      if (error instanceof StreamResyncRequiredError) {
        return {
          requiresCanonicalResync: true,
          reason: error.reason,
        };
      }
      throw error;
    }
  }

  /**
   * Resolve the current chain/release binding from environment config.
   */
  private async getChainReleaseBinding(): Promise<{
    chainId: number;
    releaseId: string;
    deploymentBlock: number;
    artifactChecksum: string;
    projectionVersion: string;
  }> {
    const chainId = Number(process.env.BLOCKCHAIN_CHAIN_ID || 0);
    const releaseId = process.env.INDEXER_RELEASE_ID || '';
    const deploymentBlock = Number(process.env.INDEXER_DEPLOYMENT_BLOCK || 0);
    const artifactChecksum = process.env.INDEXER_ARTIFACT_CHECKSUM || '';
    if (!chainId || !releaseId || !artifactChecksum) {
      throw new StreamResyncRequiredError(
        'wrong_release',
        'Chain/release binding is not configured',
      );
    }
    return {
      chainId,
      releaseId,
      deploymentBlock,
      artifactChecksum,
      projectionVersion: 'v1',
    };
  }

  /**
   * Sanitize the event payload so no protected material leaks into envelopes.
   */
  private sanitizePayload(event: PendingEvent): Record<string, unknown> {
    const safe: Record<string, unknown> = {
      eventType: event.eventType,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
    };
    const data = event.data || {};
    for (const [key, value] of Object.entries(data)) {
      if (/secret|password|token|authorization|credential|private/i.test(key)) {
        continue;
      }
      safe[key] = value;
    }
    return safe;
  }

  /**
   * Encode a cursor as an opaque string.
   */
  private encodeCursor(blockNumber: number, logIndex: number): string {
    return Buffer.from(`${blockNumber}:${logIndex}`).toString('base64url');
  }

  /**
   * Decode an opaque cursor string.
   */
  private decodeCursor(cursor: string): { blockNumber: number; logIndex: number } | null {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const [blockStr, logStr] = decoded.split(':');
      const blockNumber = Number(blockStr);
      const logIndex = Number(logStr);
      if (!Number.isFinite(blockNumber) || !Number.isFinite(logIndex)) {
        return null;
      }
      return { blockNumber, logIndex };
    } catch {
      return null;
    }
  }

  /**
   * Sign a resume token payload with HMAC-SHA256.
   */
  private signToken(payload: Record<string, unknown>): string {
    return createHmac('sha256', this.reservedTokenSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  /**
   * Constant-time comparison for signatures.
   */
  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }

  /**
   * Prune expired resume tokens and enforce the cap.
   */
  private pruneExpiredResumeTokens(): void {
    const now = Date.now();
    for (const [id, token] of this.resumeTokens) {
      if (token.expiresAt <= now) {
        this.resumeTokens.delete(id);
      }
    }
    while (this.resumeTokens.size > MAX_RESUME_TOKENS) {
      const oldest = this.resumeTokens.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.resumeTokens.delete(oldest);
    }
  }

  /**
   * Invalidate all resume tokens (e.g. after a reorg).
   */
  private invalidateAllResumeTokens(): void {
    this.resumeTokens.clear();
  }
}
