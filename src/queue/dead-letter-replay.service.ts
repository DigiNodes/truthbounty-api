import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { OutboxService, OutboxStatus } from '../outbox/outbox.service';
import { ErrorClassification, classifyError, determineRetryBehavior } from './retry-utils';

/**
 * Safe replay options for dead-letter items
 */
export interface ReplayOptions {
  /** Override the default max retry attempts */
  maxRetries?: number;
  /** Force replay even if original error was non-retryable */
  force?: boolean;
  /** Add a delay before replay (milliseconds) */
  delayMs?: number;
  /** Requesting user ID for audit trail */
  requestedBy?: string;
  /** Reason for replay (for audit) */
  reason?: string;
}

/**
 * Replay result metadata
 */
export interface ReplayResult {
  /** Number of items successfully replayed */
  replayed: number;
  /** Number of items skipped (e.g., validation errors without force) */
  skipped: number;
  /** Number of items that failed to replay */
  failed: number;
  /** Details of skipped/failed items */
  details: Array<{
    id: string;
    reason: string;
    classification?: ErrorClassification;
  }>;
}

/**
 * Dead-letter replay statistics
 */
export interface DeadLetterStats {
  /** Total dead-letter items */
  total: number;
  /** Count by error classification */
  byClassification: Record<string, number>;
  /** Count by event type */
  byEventType: Record<string, number>;
  /** Age distribution (hours) */
  ageDistribution: {
    recent: number; // < 1 hour
    short: number;  // 1-24 hours
    medium: number; // 24-168 hours (1 week)
    old: number;    // > 1 week
  };
}

/**
 * DeadLetterReplayService - safe replay tooling for dead-lettered queue items
 * 
 * Security invariants:
 * - Requires explicit authorization for replay operations
 * - Preserves idempotency through deterministic keys
 * - Audit trail for all replay operations
 * - Never exposes PII or sensitive data in responses
 * - Fail-closed behavior for unknown states
 */
@Injectable()
export class DeadLetterReplayService {
  private readonly logger = new Logger(DeadLetterReplayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly outboxService: OutboxService,
  ) {}

  /**
   * Get statistics about dead-letter items
   */
  async getDeadLetterStats(): Promise<DeadLetterStats> {
    const deadLetters = await this.prisma.outboxEvent.findMany({
      where: { status: 'DEAD_LETTER' as OutboxStatus },
      select: {
        id: true,
        eventType: true,
        lastError: true,
        createdAt: true,
      },
    });

    const byClassification: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    const ageDistribution = { recent: 0, short: 0, medium: 0, old: 0 };

    const now = new Date();

    for (const item of deadLetters) {
      // Classification analysis
      const classification = classifyError(item.lastError || 'Unknown error');
      byClassification[classification] = (byClassification[classification] || 0) + 1;

      // Event type analysis
      byEventType[item.eventType] = (byEventType[item.eventType] || 0) + 1;

      // Age analysis
      const ageHours = (now.getTime() - item.createdAt.getTime()) / (1000 * 60 * 60);
      if (ageHours < 1) ageDistribution.recent++;
      else if (ageHours < 24) ageDistribution.short++;
      else if (ageHours < 168) ageDistribution.medium++;
      else ageDistribution.old++;
    }

    return {
      total: deadLetters.length,
      byClassification,
      byEventType,
      ageDistribution,
    };
  }

  /**
   * Replay a specific dead-letter item by ID
   */
  async replayById(id: string, options: ReplayOptions = {}): Promise<ReplayResult> {
    this.logger.log(`Replay requested for dead-letter item ${id} by ${options.requestedBy || 'system'}`);

    const item = await this.prisma.outboxEvent.findUnique({
      where: { id },
    });

    if (!item) {
      throw new NotFoundException(`Dead-letter item ${id} not found`);
    }

    if (item.status !== 'DEAD_LETTER') {
      throw new Error(`Item ${id} is not in DEAD_LETTER status (current: ${item.status})`);
    }

    return this.replayItem(item, options);
  }

  /**
   * Replay multiple dead-letter items by IDs
   */
  async replayByIds(ids: string[], options: ReplayOptions = {}): Promise<ReplayResult> {
    this.logger.log(`Batch replay requested for ${ids.length} items by ${options.requestedBy || 'system'}`);

    const items = await this.prisma.outboxEvent.findMany({
      where: {
        id: { in: ids },
        status: 'DEAD_LETTER' as OutboxStatus,
      },
    });

    if (items.length === 0) {
      throw new NotFoundException('No valid dead-letter items found for the provided IDs');
    }

    const result: ReplayResult = {
      replayed: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    for (const item of items) {
      const itemResult = await this.replayItem(item, options);
      result.replayed += itemResult.replayed;
      result.skipped += itemResult.skipped;
      result.failed += itemResult.failed;
      result.details.push(...itemResult.details);
    }

    return result;
  }

  /**
   * Replay dead-letter items by event type
   */
  async replayByEventType(eventType: string, options: ReplayOptions = {}): Promise<ReplayResult> {
    this.logger.log(`Replay requested for event type ${eventType} by ${options.requestedBy || 'system'}`);

    const items = await this.prisma.outboxEvent.findMany({
      where: {
        eventType,
        status: 'DEAD_LETTER' as OutboxStatus,
      },
      take: 100, // Safety limit for batch operations
    });

    if (items.length === 0) {
      throw new NotFoundException(`No dead-letter items found for event type ${eventType}`);
    }

    const result: ReplayResult = {
      replayed: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    for (const item of items) {
      const itemResult = await this.replayItem(item, options);
      result.replayed += itemResult.replayed;
      result.skipped += itemResult.skipped;
      result.failed += itemResult.failed;
      result.details.push(...itemResult.details);
    }

    return result;
  }

  /**
   * Replay dead-letter items by error classification
   */
  async replayByClassification(
    classification: ErrorClassification,
    options: ReplayOptions = {},
  ): Promise<ReplayResult> {
    this.logger.log(
      `Replay requested for classification ${classification} by ${options.requestedBy || 'system'}`,
    );

    const allDeadLetters = await this.prisma.outboxEvent.findMany({
      where: { status: 'DEAD_LETTER' as OutboxStatus },
      select: { id: true, lastError: true },
    });

    const matchingItems = allDeadLetters.filter((item) =>
      classifyError(item.lastError || 'Unknown error') === classification,
    );

    if (matchingItems.length === 0) {
      throw new NotFoundException(`No dead-letter items found for classification ${classification}`);
    }

    const result: ReplayResult = {
      replayed: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    for (const item of matchingItems) {
      const fullItem = await this.prisma.outboxEvent.findUnique({
        where: { id: item.id },
      });
      if (fullItem) {
        const itemResult = await this.replayItem(fullItem, options);
        result.replayed += itemResult.replayed;
        result.skipped += itemResult.skipped;
        result.failed += itemResult.failed;
        result.details.push(...itemResult.details);
      }
    }

    return result;
  }

  /**
   * Replay a single dead-letter item with safety checks
   */
  private async replayItem(
    item: any,
    options: ReplayOptions,
  ): Promise<ReplayResult> {
    const result: ReplayResult = {
      replayed: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    try {
      const classification = classifyError(item.lastError || 'Unknown error');
      const retryBehavior = determineRetryBehavior(item.lastError || 'Unknown error', item.retryCount);

      // Safety check: don't replay non-retryable errors unless forced
      if (!retryBehavior.shouldRetry && !options.force) {
        result.skipped++;
        result.details.push({
          id: item.id,
          reason: `Non-retryable error classification: ${classification}`,
          classification,
        });
        this.logger.warn(`Skipping non-retryable item ${item.id} (classification: ${classification})`);
        return result;
      }

      // Reset the item for replay
      await this.prisma.outboxEvent.update({
        where: { id: item.id },
        data: {
          status: 'PENDING' as OutboxStatus,
          retryCount: 0,
          lastError: null,
          jobId: null,
          processedAt: null,
          scheduledAt: options.delayMs ? new Date(Date.now() + options.delayMs) : new Date(),
        },
      });

      // Update max retries if specified
      if (options.maxRetries) {
        await this.prisma.outboxEvent.update({
          where: { id: item.id },
          data: { maxRetries: options.maxRetries },
        });
      }

      result.replayed++;
      this.metricsService.incrementCounter('dead_letter_replayed_total', 1);
      this.logger.log(`Successfully replayed dead-letter item ${item.id}`);

      // Audit log
      this.logger.debug(
        `Replay audit: item=${item.id}, requestedBy=${options.requestedBy || 'system'}, reason=${options.reason || 'not specified'}`,
      );
    } catch (error) {
      result.failed++;
      result.details.push({
        id: item.id,
        reason: error instanceof Error ? error.message : 'Unknown error',
      });
      this.logger.error(`Failed to replay dead-letter item ${item.id}: ${error}`);
      this.metricsService.incrementCounter('dead_letter_replay_failed_total', 1);
    }

    return result;
  }

  /**
   * Permanently delete a dead-letter item (use with caution)
   */
  async deleteDeadLetter(id: string, requestedBy?: string): Promise<void> {
    this.logger.warn(`Delete requested for dead-letter item ${id} by ${requestedBy || 'system'}`);

    const item = await this.prisma.outboxEvent.findUnique({
      where: { id },
    });

    if (!item) {
      throw new NotFoundException(`Dead-letter item ${id} not found`);
    }

    if (item.status !== 'DEAD_LETTER') {
      throw new Error(`Item ${id} is not in DEAD_LETTER status (current: ${item.status})`);
    }

    await this.prisma.outboxEvent.delete({
      where: { id },
    });

    this.metricsService.incrementCounter('dead_letter_deleted_total', 1);
    this.logger.log(`Permanently deleted dead-letter item ${id}`);
  }

  /**
   * Get dead-letter item details (redacted)
   */
  async getDeadLetterDetails(id: string): Promise<any> {
    const item = await this.prisma.outboxEvent.findUnique({
      where: { id },
      select: {
        id: true,
        eventType: true,
        aggregateId: true,
        status: true,
        retryCount: true,
        maxRetries: true,
        lastError: true,
        scheduledAt: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!item) {
      throw new NotFoundException(`Dead-letter item ${id} not found`);
    }

    // Add classification for context
    const classification = classifyError(item.lastError || 'Unknown error');

    return {
      ...item,
      classification,
      isRetryable: classification !== ErrorClassification.VALIDATION &&
                   classification !== ErrorClassification.AUTHORIZATION &&
                   classification !== ErrorClassification.NOT_FOUND,
    };
  }
}
