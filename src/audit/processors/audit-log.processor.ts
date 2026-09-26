import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { DeepPartial } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';
import { AuditLogInput, AuditTrailService } from '../services/audit-trail.service';
import { maskIp } from '../utils/ip-masking';
import { AUDIT_QUEUE_NAME } from '../services/audit-queue.service';
import { randomUUID } from 'crypto';

/**
 * Processes queued (async) audit writes.
 *
 * This used to build and save its own `AuditLog` row directly, then call
 * `stampIntegrityHash` as a second step: a second, independent write path
 * into `audit_logs` that bypassed the hash chain entirely (V2-BE-110).
 * It now goes through `AuditTrailService.persistChainedRecord`, the same
 * atomic write path used by `log()`/`logBatch()`, so every row in the
 * table is chained regardless of which path wrote it.
 *
 * Errors are intentionally rethrown (not swallowed) so BullMQ's retry
 * policy on the `audit-log` queue applies.
 */
@Processor(AUDIT_QUEUE_NAME)
export class AuditLogProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogProcessor.name);

  constructor(private readonly auditTrailService: AuditTrailService) {
    super();
  }

  async process(job: Job<AuditLogInput>): Promise<void> {
    try {
      const input = job.data;
      const record: DeepPartial<AuditLog> = {
        eventId: randomUUID(),
        actionType: input.actionType,
        entityType: input.entityType,
        entityId: input.entityId,
        userId: input.userId,
        walletAddress: input.walletAddress,
        severity: (input as any).severity,
        category: (input as any).category,
        source: (input as any).source,
        requestId: (input as any).requestId,
        description: input.description,
        beforeState: input.beforeState,
        afterState: input.afterState,
        metadata: input.metadata,
        correlationId: input.correlationId,
        ipAddress: input.ipAddress ? maskIp(input.ipAddress) : undefined,
        userAgent: input.userAgent,
      };

      await this.auditTrailService.persistChainedRecord(record);
    } catch (error) {
      this.logger.error(`Failed to process audit job ${job.id}: ${error.message}`);
      throw error;
    }
  }
}
