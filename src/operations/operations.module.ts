import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { V2OutboxMessage } from '../v2/outbox/entities/v2-outbox-message.entity';
import {
  InMemoryOperationsAuditStore,
  OPERATIONS_AUDIT_STORE,
} from './operations-audit.store';
import { OPERATIONS_QUEUE_SOURCE } from './operations-queue.source';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OutboxOperationsQueueSource } from './outbox-operations.source';

/**
 * UX-BE-004 (#595): protected operations, safe-retry and audit interfaces.
 *
 * The queue source and audit store are bound through injection tokens so the
 * wire contract can be tested without a database and so a durable audit store
 * can be substituted in deployment without touching the controller or service.
 * Persistence is TypeORM-only (V2-BE-111); the queue source reads the canonical
 * `v2_outbox_messages` table.
 */
@Module({
  imports: [AdminModule, TypeOrmModule.forFeature([V2OutboxMessage])],
  controllers: [OperationsController],
  providers: [
    OperationsService,
    InMemoryOperationsAuditStore,
    OutboxOperationsQueueSource,
    {
      provide: OPERATIONS_QUEUE_SOURCE,
      useExisting: OutboxOperationsQueueSource,
    },
    {
      provide: OPERATIONS_AUDIT_STORE,
      useExisting: InMemoryOperationsAuditStore,
    },
  ],
  exports: [OperationsService],
})
export class OperationsModule {}
