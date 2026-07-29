import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IpfsModule } from '../ipfs/ipfs.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [
    RedisModule,
    JobsModule,
    NotificationsModule,
    IpfsModule,
    BlockchainModule,
  ],
  providers: [HealthService],
  controllers: [HealthController],
  exports: [HealthService],
})
export class HealthModule {}
