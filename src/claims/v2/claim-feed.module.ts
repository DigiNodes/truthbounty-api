import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Claim } from '../entities/claim.entity';
import { IndexedEvent } from '../../entities/indexed-event.entity';
import { Stake } from '../../staking/entities/stake.entity';
import { ClaimFeedService } from './claim-feed.service';
import { ClaimFeedController } from './claim-feed.controller';
import { CacheModule } from '../../cache/cache.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Claim, IndexedEvent, Stake]),
    CacheModule,
  ],
  controllers: [ClaimFeedController],
  providers: [ClaimFeedService],
  exports: [ClaimFeedService],
})
export class ClaimFeedModule {}
