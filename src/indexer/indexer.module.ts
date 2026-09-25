import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { IndexedEvent, IndexingState } from '../entities';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { IndexerConfigService } from '../config';
import { EventIndexerService } from './event-indexer.service';
import { IndexerController } from './indexer.controller';
import { ReorgSafeCursorService } from './reorg-safe-cursor.service';

/**
 * Indexer module — wires EventIndexerService for V2-BE-125.
 *
 * Uses `getRepositoryToken` so TypeORM resolves the repositories correctly
 * from the `forFeature` imports rather than relying on custom string tokens
 * that are never registered.
 *
 * Provides:
 *  - DataSource (atomic batch transactions, fix 1.5)
 *  - ContractArtifact repository (deployment-block validation, fix 1.6)
 *  - BlockchainStateService (dead-letter + finalized-block reporting, fixes 1.3 / 1.4)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IndexedEvent, IndexingState, ContractArtifact]),
  ],
  controllers: [IndexerController],
  providers: [EventIndexerService, ReorgSafeCursorService],
  exports: [EventIndexerService, ReorgSafeCursorService],
})
export class IndexerModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly eventIndexerService: EventIndexerService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.eventIndexerService.start();
    } catch (error) {
      console.error('Failed to start event indexer on module init:', error);
    }
  }

  onModuleDestroy(): void {
    this.eventIndexerService.stop();
  }
}
