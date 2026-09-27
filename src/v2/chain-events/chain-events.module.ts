import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ChainEventDedupService } from './chain-event-dedup.service';

@Module({
  imports: [PrismaModule],
  providers: [ChainEventDedupService],
  exports: [ChainEventDedupService],
})
export class ChainEventsModule {}
