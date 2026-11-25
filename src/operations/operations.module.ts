import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from '../admin/admin.module';
import { CommonModule } from '../common/common.module';
import { V2OutboxMessage } from '../v2/outbox/entities/v2-outbox-message.entity';
import {
  InMemoryOperationsAuditStore,
  DurableOperationsAuditStore,
  OPERATIONS_AUDIT_STORE,
} from './operations-audit.store';
import {
  DurableOperationsIdempotencyStore,
  OPERATIONS_IDEMPOTENCY_STORE,
} from './operations-idempotency.store';
import { OPERATIONS_QUEUE_SOURCE } from './operations-queue.source';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OutboxOperationsQueueSource } from './outbox-operations.source';
import { OperationsRetentionService } from './operations-retention.service';
import {
  OperationsIdempotencyKey,
  OperationsAuditLog,
} from './entities';

/**
 * UX-BE-004 (#595), PREWAVE-BE-110 (#811): protected operations, safe-retry,
 * durable idempotency and audit.
 *
 * ## Durable persistence (PREWAVE-BE-110, #811)
 *
 * Idempotency keys and audit records are now persisted in the database via
 * DurableOperationsIdempotencyStore and DurableOperationsAuditStore. This
 * enables:
 * - Idempotency across API replicas and restarts
 * - Audit trail durability for compliance and forensics
 * - Consistent retry behavior in multi-replica deployments
 *
 * ## Injection tokens
 *
 * The queue source, idempotency store, and audit store are bound through
 * injection tokens so the wire contract can be tested without a database and
 * so alternative implementations can be substituted without touching the
 * controller or service.
 *
 * ## Backward compatibility
 *
 * For testing or single-replica development environments, the in-memory audit
 * store can still be used by swapping the binding for OPERATIONS_AUDIT_STORE.
 * Production deployments MUST use the durable stores.
 *
 * ## Scheduled cleanup
 *
 * OperationsRetentionService runs daily (default: 2 AM) to delete expired
 * idempotency keys and audit records. Configurable via OPERATIONS_CLEANUP_CRON.
 *
 * Persistence is TypeORM-only (V2-BE-111); the queue source reads the canonical
 * `v2_outbox_messages` table.
 */
@Module({
  imports: [
    AdminModule,
    CommonModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      V2OutboxMessage,
      OperationsIdempotencyKey,
      OperationsAuditLog,
    ]),
  ],
  controllers: [OperationsController],
  providers: [
    OperationsService,
    InMemoryOperationsAuditStore,
    DurableOperationsAuditStore,
    DurableOperationsIdempotencyStore,
    OutboxOperationsQueueSource,
    OperationsRetentionService,
    {
      provide: OPERATIONS_QUEUE_SOURCE,
      useExisting: OutboxOperationsQueueSource,
    },
    {
      provide: OPERATIONS_AUDIT_STORE,
      useExisting: DurableOperationsAuditStore,
    },
    {
      provide: OPERATIONS_IDEMPOTENCY_STORE,
      useExisting: DurableOperationsIdempotencyStore,
    },
  ],
  exports: [OperationsService],
})
export class OperationsModule {}
