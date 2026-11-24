import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { MetricsModule } from '../../metrics/metrics.module';
import { V2OutboxMessage } from './entities/v2-outbox-message.entity';
import { V2OutboxService } from './v2-outbox.service';
import { V2OutboxWorker, V2_OUTBOX_QUEUE_NAME } from './v2-outbox.worker';

/**
 * V2OutboxModule — TypeORM-side Transactional Outbox (V2-BE-113).
 *
 * Provides:
 * - {@link V2OutboxService}  — write side: callers use `publishWithManager`
 *   inside an existing TypeORM EntityManager transaction to atomically record
 *   delivery work alongside their domain state change.
 * - {@link V2OutboxWorker}   — read side: a @Cron-based poller that claims
 *   PENDING rows via `FOR UPDATE SKIP LOCKED` and dispatches them to BullMQ.
 *
 * The BullMQ queue name is {@link V2_OUTBOX_QUEUE_NAME} ('v2-outbox'). The
 * root BullMQ connection is configured by AppModule and shared here; this
 * module only registers the named queue.
 *
 * Import this module in any feature module that needs to publish outbox
 * messages over the TypeORM/PostgreSQL persistence path.
 *
 * ## Dependency boundaries
 *
 * - TypeORM DataSource only — no Prisma, no second ORM.
 * - MetricsModule for Prometheus counters.
 * - ScheduleModule for the @Cron worker (ScheduleModule.forRoot() is already
 *   registered globally in AppModule; forRoot() is idempotent so it is safe
 *   to list it here as well, but AppModule's registration is sufficient).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([V2OutboxMessage]),
    BullModule.registerQueue({ name: V2_OUTBOX_QUEUE_NAME }),
    ScheduleModule.forRoot(),
    MetricsModule,
  ],
  providers: [V2OutboxService, V2OutboxWorker],
  exports: [V2OutboxService],
})
export class V2OutboxModule {}
