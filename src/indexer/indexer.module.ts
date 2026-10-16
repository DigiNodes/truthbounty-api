import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { IndexedEvent, IndexingState } from '../entities';
import { IndexerConfigService } from '../config';
import { EventIndexerService } from './event-indexer.service';
import { IndexerController } from './indexer.controller';
import { ConfigModule } from '@nestjs/config';
import { Repository } from 'typeorm';
import { TracingModule } from '../tracing/tracing.module';
import { TracingService } from '../tracing/tracing.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([IndexedEvent, IndexingState]),
    TracingModule,
  ],
  controllers: [IndexerController],
  providers: [
    IndexerConfigService,
    {
      provide: EventIndexerService,
      inject: [
        IndexerConfigService,
        getRepositoryToken(IndexedEvent),
        getRepositoryToken(IndexingState),
        TracingService,
      ],
      useFactory: (
        configService: IndexerConfigService,
        eventRepository: Repository<IndexedEvent>,
        stateRepository: Repository<IndexingState>,
        tracingService: TracingService,
      ) =>
        new EventIndexerService(
          configService.getEventIndexerConfig(),
          eventRepository,
          stateRepository,
          tracingService,
        ),
    },
  ],
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
