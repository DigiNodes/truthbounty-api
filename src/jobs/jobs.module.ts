import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { JobsService } from './jobs.service';
import { AuditRetentionService } from './audit-retention.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Stake } from '../staking/entities/stake.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AggregationModule } from '../aggregation/aggregation.module';

@Module({
  imports: [
    RedisModule,
    TypeOrmModule.forFeature([Stake, Wallet, Claim, User, AuditLog]),
    AggregationModule,
  ],
  providers: [JobsService, AuditRetentionService],
  exports: [JobsService, AuditRetentionService],
})
export class JobsModule {}
