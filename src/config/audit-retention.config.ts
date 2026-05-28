import { registerAs } from '@nestjs/config';

/**
 * Audit Retention Configuration
 * Configures automatic purging of old audit logs
 */
export default registerAs('auditRetention', () => ({
  // Retention period in days (default: 90 days = 3 months)
  retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10),

  // Cron expression for when the retention job should run (default: daily at 2 AM UTC)
  // Format: second minute hour day month dayOfWeek
  cronExpression: process.env.AUDIT_RETENTION_CRON || '0 0 2 * * *',

  // Enable/disable the retention job
  enabled: process.env.AUDIT_RETENTION_ENABLED !== 'false',

  // Batch size for deletion (delete in chunks to avoid locking the table)
  batchSize: parseInt(process.env.AUDIT_RETENTION_BATCH_SIZE || '1000', 10),

  // Maximum batches to process per run (to avoid long-running jobs)
  maxBatches: parseInt(process.env.AUDIT_RETENTION_MAX_BATCHES || '100', 10),
}));
