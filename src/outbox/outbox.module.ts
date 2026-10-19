import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsModule } from '../metrics/metrics.module';
import { OutboxService, OUTBOX_QUEUE_NAME } from './outbox.service';
import { OutboxScheduler } from './outbox.scheduler';
import { OutboxEvent } from './entities/outbox-event.entity';

/**
 * OutboxModule — hosts both the Prisma-backed OutboxService (used by
 * OutboxScheduler to poll the Prisma `outboxEvent` model) and the canonical
 * TypeORM {@link OutboxEvent} entity used by the notification pipeline.
 *
 * ## TypeORM registration
 *
 * `TypeOrmModule.forFeature([OutboxEvent])` makes the Repository<OutboxEvent>
 * available for injection across the notification services:
 *   - NotificationEventPublisher
 *   - OutboxScheduler (notifications/services)
 *   - NotificationProcessor
 *   - NotificationMetricsService
 *   - notifications.module.new.ts (NotificationsModule)
 *
 * ## Prisma registration
 *
 * The Prisma-backed `OutboxService` is retained for backward compatibility
 * with the existing `outbox_events` model in the Prisma datasource. The two
 * persistence paths are fully independent and serve different consumers.
 */
@Module({
  imports: [
    // TypeORM registration so Repository<OutboxEvent> is injectable
    TypeOrmModule.forFeature([OutboxEvent]),

    // Prisma (legacy OutboxService)
    PrismaModule,
    MetricsModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: OUTBOX_QUEUE_NAME,
    }),
  ],
  providers: [OutboxService, OutboxScheduler],
  exports: [
    OutboxService,
    // Export TypeOrmModule so that feature modules importing OutboxModule
    // can inject Repository<OutboxEvent> without re-declaring the feature.
    TypeOrmModule,
  ],
})
export class OutboxModule {}
