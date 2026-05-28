import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AuditLog } from '../audit/entities/audit-log.entity';

export interface AuditRetentionResult {
  totalDeleted: number;
  batchesProcessed: number;
  deletedBeforeDate: Date;
  executionTimeMs: number;
  success: boolean;
  error?: string;
}

/**
 * Audit Retention Service
 * Responsible for automatic purging of old audit logs based on retention policy
 */
@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Execute the audit log retention job
   * Deletes audit logs older than the configured retention period
   * Uses batch processing to avoid locking the table for too long
   */
  async executeRetention(): Promise<AuditRetentionResult> {
    const startTime = Date.now();
    const result: AuditRetentionResult = {
      totalDeleted: 0,
      batchesProcessed: 0,
      deletedBeforeDate: new Date(),
      executionTimeMs: 0,
      success: false,
    };

    try {
      // Get configuration
      const retentionDays = this.configService.get<number>(
        'auditRetention.retentionDays',
        90,
      );
      const batchSize = this.configService.get<number>(
        'auditRetention.batchSize',
        1000,
      );
      const maxBatches = this.configService.get<number>(
        'auditRetention.maxBatches',
        100,
      );

      // Calculate cutoff date
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      result.deletedBeforeDate = cutoffDate;

      this.logger.log(
        `Starting audit log retention job: removing logs older than ${retentionDays} days (before ${cutoffDate.toISOString()})`,
      );

      // Process deletions in batches
      for (let i = 0; i < maxBatches; i++) {
        // Find IDs of logs to delete in this batch
        const logsToDelete = await this.auditLogRepo.find({
          where: { createdAt: LessThan(cutoffDate) },
          select: ['id'],
          take: batchSize,
        });

        if (logsToDelete.length === 0) {
          this.logger.log(
            `Retention job completed. No more logs to delete after batch ${i}.`,
          );
          break;
        }

        // Delete this batch
        const ids = logsToDelete.map((log) => log.id);
        const deleteResult = await this.auditLogRepo.delete(ids);
        
        const deleted = deleteResult.affected || 0;
        result.totalDeleted += deleted;
        result.batchesProcessed++;

        this.logger.debug(
          `Retention batch ${i + 1}: deleted ${deleted} logs`,
        );

        // If we got fewer logs than batch size, we're done
        if (logsToDelete.length < batchSize) {
          this.logger.log(
            `Retention job completed. Total logs deleted: ${result.totalDeleted}`,
          );
          break;
        }
      }

      result.success = true;
      this.logger.log(
        `Audit log retention job completed successfully. Deleted ${result.totalDeleted} logs in ${result.batchesProcessed} batches.`,
      );
    } catch (error) {
      result.success = false;
      result.error = error?.message || 'Unknown error';
      this.logger.error(
        `Audit log retention job failed: ${result.error}`,
        error?.stack,
      );
    }

    result.executionTimeMs = Date.now() - startTime;
    return result;
  }

  /**
   * Get statistics about audit logs and retention
   */
  async getRetentionStats(): Promise<{
    totalLogs: number;
    logsOlderThanRetention: number;
    retentionDays: number;
    cutoffDate: Date;
  }> {
    const retentionDays = this.configService.get<number>(
      'auditRetention.retentionDays',
      90,
    );

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const [totalLogs, logsToDelete] = await Promise.all([
      this.auditLogRepo.count(),
      this.auditLogRepo.count({
        where: { createdAt: LessThan(cutoffDate) },
      }),
    ]);

    return {
      totalLogs,
      logsOlderThanRetention: logsToDelete,
      retentionDays,
      cutoffDate,
    };
  }
}
