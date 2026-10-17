import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IpfsModule } from '../ipfs/ipfs.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { MetricsModule } from '../metrics/metrics.module';
import { DatabaseModule } from '../database/database.module';
import { FinalizedCursorModule } from '../indexer/finalized-cursor/finalized-cursor.module';
import { V2EventsModule } from '../v2/events/v2-events.module';
import { PublicStatusController } from './public-status/public-status.controller';
import { PublicStatusService } from './public-status/public-status.service';
import { PublicStatusRateLimitGuard } from './public-status/public-status-rate-limit.guard';
import {
  PUBLIC_STATUS_OPTIONS,
  loadPublicStatusOptions,
} from './public-status/public-status.options';

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    JobsModule,
    NotificationsModule,
    IpfsModule,
    BlockchainModule,
    MetricsModule,
    FinalizedCursorModule,
    V2EventsModule,
  ],
  providers: [
    HealthService,
    PublicStatusService,
    PublicStatusRateLimitGuard,
    {
      provide: PUBLIC_STATUS_OPTIONS,
      useFactory: () => loadPublicStatusOptions(process.env),
    },
  ],
  controllers: [HealthController, PublicStatusController],
  exports: [HealthService],
})
export class HealthModule {}
