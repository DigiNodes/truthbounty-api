import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditLogInput } from './audit-trail.service';
import { ConfigService } from '@nestjs/config';

export const AUDIT_QUEUE_NAME = 'audit-log';

@Injectable()
export class AuditQueueService {
  private readonly logger = new Logger(AuditQueueService.name);
  private readonly asyncEnabled: boolean;

  constructor(
    @InjectQueue(AUDIT_QUEUE_NAME)
    private readonly auditQueue: Queue,
    private readonly configService: ConfigService,
  ) {
    this.asyncEnabled = this.configService.get<boolean>('audit.asyncWritesEnabled', true);
  }

  async enqueue(input: AuditLogInput): Promise<void> {
    if (!this.asyncEnabled) {
      return;
    }

    try {
      await this.auditQueue.add('write', input, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      });
    } catch (error) {
      this.logger.error(`Failed to enqueue audit log: ${error.message}`);
    }
  }

  async enqueueBatch(inputs: AuditLogInput[]): Promise<void> {
    if (!this.asyncEnabled || inputs.length === 0) {
      return;
    }

    try {
      await this.auditQueue.addBulk(
        inputs.map((input) => ({
          name: 'write',
          data: input,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        })),
      );
    } catch (error) {
      this.logger.error(`Failed to enqueue batch audit logs: ${error.message}`);
    }
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.auditQueue.getWaitingCount(),
      this.auditQueue.getActiveCount(),
      this.auditQueue.getCompletedCount(),
      this.auditQueue.getFailedCount(),
      this.auditQueue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }
}
