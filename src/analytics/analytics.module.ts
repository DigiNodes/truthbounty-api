import { Module } from '@nestjst/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { BlockchainIndexingModule } from '../blockchain-indexing/blockchain-indexing.module';
import { AuditModule } from '../audit/audit.module';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuthModule,
    BlockchainIndexingModule,
    AuditModule,
    MonitoringModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
