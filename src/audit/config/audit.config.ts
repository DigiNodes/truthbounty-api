import { registerAs } from '@nestjs/config';

export interface AuditConfig {
  retentionDays: number;
  archivalEnabled: boolean;
  archivalBucket: string;
  asyncWritesEnabled: boolean;
  batchSize: number;
  maxBatchWaitMs: number;
  metricPrefix: string;
}

export default registerAs('audit', (): AuditConfig => ({
  retentionDays: parseInt(process.env.AUDIT_LOG_RETENTION_DAYS ?? '365', 10),
  archivalEnabled: process.env.AUDIT_ARCHIVAL_ENABLED === 'true',
  archivalBucket: process.env.AUDIT_ARCHIVAL_BUCKET ?? 'audit-archive',
  asyncWritesEnabled: process.env.AUDIT_ASYNC_WRITES_ENABLED !== 'false',
  batchSize: parseInt(process.env.AUDIT_BATCH_SIZE ?? '50', 10),
  maxBatchWaitMs: parseInt(process.env.AUDIT_MAX_BATCH_WAIT_MS ?? '1000', 10),
  metricPrefix: process.env.AUDIT_METRIC_PREFIX ?? 'audit',
}));
