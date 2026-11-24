import { getRuntimeEnvironment } from '../../config/runtime-config';
import { registerAs } from '@nestjs/config';

export interface AuditConfig {
  retentionDays: number;
  piiRetentionDays: number;
  archivalEnabled: boolean;
  archivalBucket: string;
  asyncWritesEnabled: boolean;
  batchSize: number;
  maxBatchWaitMs: number;
  metricPrefix: string;
}

export default registerAs('audit', (): AuditConfig => ({
  retentionDays: parseInt(getRuntimeEnvironment().AUDIT_LOG_RETENTION_DAYS ?? '365', 10),
  piiRetentionDays: parseInt(getRuntimeEnvironment().AUDIT_PII_RETENTION_DAYS ?? '30', 10),
  archivalEnabled: getRuntimeEnvironment().AUDIT_ARCHIVAL_ENABLED === 'true',
  archivalBucket: getRuntimeEnvironment().AUDIT_ARCHIVAL_BUCKET ?? 'audit-archive',
  asyncWritesEnabled: getRuntimeEnvironment().AUDIT_ASYNC_WRITES_ENABLED !== 'false',
  batchSize: parseInt(getRuntimeEnvironment().AUDIT_BATCH_SIZE ?? '50', 10),
  maxBatchWaitMs: parseInt(getRuntimeEnvironment().AUDIT_MAX_BATCH_WAIT_MS ?? '1000', 10),
  metricPrefix: getRuntimeEnvironment().AUDIT_METRIC_PREFIX ?? 'audit',
}));
