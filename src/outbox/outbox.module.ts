import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsModule } from '../metrics/metrics.module';
import { OutboxService, OUTBOX_QUEUE_NAME } from './outbox.service';
import { OutboxScheduler } from './outbox.scheduler';

@Module({
  imports: [
    PrismaModule,
    MetricsModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: OUTBOX_QUEUE_NAME,
    }),
  ],
  providers: [OutboxService, OutboxScheduler],
  exports: [OutboxService],
})
export class OutboxModule {}
