import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IndexedEvent, IndexingState } from '../entities';
import { IndexerConfigService } from '../config';
import { EventIndexerService } from './event-indexer.service';
import { IndexerController } from './indexer.controller';

@Module({
  imports: [TypeOrmModule.forFeature([IndexedEvent, IndexingState])],
  controllers: [IndexerController],
  providers: [EventIndexerService],
  exports: [EventIndexerService],
})
export class IndexerModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private eventIndexerService: EventIndexerService,
    private configService: IndexerConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Start the indexer when the module is initialized
    try {
      await this.eventIndexerService.start();
    } catch (error) {
      console.error('Failed to start event indexer on module init:', error);
    }
  }

  onModuleDestroy(): void {
    // Stop the indexer when the module is destroyed
    this.eventIndexerService.stop();
  }
}
