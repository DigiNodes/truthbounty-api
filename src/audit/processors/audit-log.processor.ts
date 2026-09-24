import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';
import { AuditLogInput, AuditTrailService } from '../services/audit-trail.service';
import { maskIp } from '../utils/ip-masking';
import { AUDIT_QUEUE_NAME } from '../services/audit-queue.service';
import { randomUUID } from 'crypto';

@Processor(AUDIT_QUEUE_NAME)
export class AuditLogProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogProcessor.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly auditTrailService: AuditTrailService,
  ) {
    super();
  }

  async process(job: Job<AuditLogInput>): Promise<void> {
    try {
      const input = job.data;
      const auditLog = this.auditLogRepo.create({
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
      });

      const saved = await this.auditLogRepo.save(auditLog);
      await this.auditTrailService.stampIntegrityHash(saved.id);
    } catch (error) {
      this.logger.error(`Failed to process audit job ${job.id}: ${error.message}`);
      throw error;
    }
  }
}
