import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { JobsService } from './jobs.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Stake } from '../staking/entities/stake.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { AggregationModule } from '../aggregation/aggregation.module';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { JobsProcessor } from './jobs.processor';
import { SybilResistanceModule } from '../sybil-resistance/sybil-resistance.module';

@Module({
  imports: [
    RedisModule,
    TypeOrmModule.forFeature([Stake, Wallet, Claim, User]),
    AggregationModule,
    SybilResistanceModule,
    BullModule.registerQueue({
      name: 'jobs-queue',
    }),
    BullBoardModule.forFeature({
      name: 'jobs-queue',
      adapter: BullMQAdapter,
    }),
  ],
  providers: [JobsService, JobsProcessor],
  exports: [JobsService, BullModule],
})
export class JobsModule {}
