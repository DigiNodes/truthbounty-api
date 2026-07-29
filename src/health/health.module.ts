import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '../redis/redis.module';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature(),
    RedisModule,
    BullModule.registerQueue({
      name: 'jobs-queue',
    }),
  ],
  providers: [HealthService],
  controllers: [HealthController],
  exports: [HealthService],
})
export class HealthModule {}
