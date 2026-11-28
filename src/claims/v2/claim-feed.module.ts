import { Module } from '@nestjs/common';
import { ClaimFeedController } from './claim-feed.controller';

@Module({
  controllers: [ClaimFeedController],
})
export class ClaimFeedModule {}