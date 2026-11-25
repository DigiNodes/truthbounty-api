import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { getRuntimeEnvironment } from '../config/runtime-config';
import { GracefulShutdownService } from '../common/lifecycle/graceful-shutdown.service';
import {
  OPERATIONS_IDEMPOTENCY_STORE,
  OperationsIdempotencyStore,
} from './operations-idempotency.store';
import {
  OPERATIONS_AUDIT_STORE,
  OperationsAuditStore,
} from './operations-audit.store';

/**
 * Result of a retention/cleanup execution.
 */
export interface OperationsRetentionResult {
  /** Number of expired idempotency keys deleted. */
  deletedKeys: number;
  /** Number of expired audit records deleted. */
  deletedAuditRecords: number;
  /** Timestamp of the execution. */
  timestamp: string;
}

const DEFAULT_CLEANUP_CRON =
  getRuntimeEnvironment().OPERATIONS_CLEANUP_CRON ||
  CronExpression.EVERY_DAY_AT_2AM;

/**
 * Scheduled cleanup for operational retry idempotency keys and audit records.
 *
 * ## Idempotency key cleanup (PREWAVE-BE-110, #811)
 *
 * Removes expired idempotency keys (expiresAt < now) to prevent unbounded
 * table growth. Keys are retained for 24 hours (default TTL) after creation,
 * which is sufficient to prevent replay attacks during typical retry windows.
 *
 * ## Audit record retention
 *
 * Removes audit records past their retention period (retentionUntil < now).
 * Default retention is 90 days. Records are immutable and only eligible for
 * deletion by this cleanup job.
 *
 * ## Leader election
 *
 * This service uses @Cron with a job name, which ensures only one replica
 * executes the cleanup at a time (via NestJS scheduler + distributed locking
 * if configured). If not using distributed locking, all replicas will attempt
 * cleanup concurrently, which is safe but inefficient (idempotent deletes).
 *
 * ## Graceful shutdown
 *
 * Cleanup is tracked via GracefulShutdownService and will not start if the
 * service is draining. In-progress cleanup is allowed to complete before
 * final shutdown.
 */
@Injectable()
export class OperationsRetentionService {
  private readonly logger = new Logger(OperationsRetentionService.name);

  constructor(
    @Inject(OPERATIONS_IDEMPOTENCY_STORE)
    private readonly idempotencyStore: OperationsIdempotencyStore,
    @Inject(OPERATIONS_AUDIT_STORE)
    private readonly auditStore: OperationsAuditStore,
    private readonly config: ConfigService,
    private readonly gracefulShutdown: GracefulShutdownService,
  ) {}

  /**
   * Scheduled cleanup job (default: 2 AM daily).
   * Override with OPERATIONS_CLEANUP_CRON environment variable.
   */
  @Cron(DEFAULT_CLEANUP_CRON, {
    name: 'operations-retention',
    timeZone: 'UTC',
  })
  async scheduledCleanup(): Promise<void> {
    if (this.gracefulShutdown.isDraining) {
      this.logger.debug('Skipping scheduled cleanup; service is draining');
      return;
    }

    try {
      await this.gracefulShutdown.runTracked('operations-retention', () =>
        this.runCleanup(),
      );
    } catch (error) {
      this.logger.error(
        `Scheduled operations retention failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Execute cleanup for expired idempotency keys and audit records.
   * Returns the counts of deleted records.
   * Safe to call manually; idempotent.
   */
  async runCleanup(): Promise<OperationsRetentionResult> {
    this.logger.log('Starting operations retention cleanup...');

    const startTime = Date.now();

    // Clean up expired idempotency keys (expiresAt < now).
    const deletedKeys = await this.idempotencyStore.cleanupExpired();

    // Clean up expired audit records (retentionUntil < now).
    const deletedAuditRecords = await this.auditStore.cleanupExpired();

    const elapsed = Date.now() - startTime;

    this.logger.log(
      `Operations retention complete in ${elapsed}ms: ` +
        `deleted ${deletedKeys} idempotency keys, ` +
        `${deletedAuditRecords} audit records`,
    );

    return {
      deletedKeys,
      deletedAuditRecords,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Manually trigger cleanup (e.g., via admin API or testing).
   * Returns the result of the cleanup execution.
   */
  async manualCleanup(): Promise<OperationsRetentionResult> {
    this.logger.log('Manual operations retention cleanup requested');
    return this.runCleanup();
  }
}
