import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import {
  ProcessedEvent,
  TokenBalance,
  IndexerCheckpoint,
  ReorgEventRecord,
} from './entities';
import { BlockchainStateService } from './state.service';
import { ReorgDetectorService } from './reorg-detector.service';
import { ReconciliationService } from './reconciliation.service';
import { EventIndexingService } from './event-indexing.service';
import { WeightedVoteResolutionService } from './weighted-vote-resolution.service';
import { BlockchainReorgAlertService } from './blockchain-reorg-alert.service';
import { BlockchainController } from './blockchain.controller';
import { SybilResistanceModule } from '../sybil-resistance/sybil-resistance.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProcessedEvent,
      TokenBalance,
      IndexerCheckpoint,
      ReorgEventRecord,
    ]),
    SybilResistanceModule,
  ],
  providers: [
    BlockchainIndexerService,
    BlockchainStateService,
    ReorgDetectorService,
    ReconciliationService,
    EventIndexingService,
    WeightedVoteResolutionService,
    BlockchainReorgAlertService,
  ],
  controllers: [BlockchainController],
  exports: [
    BlockchainIndexerService,
    BlockchainStateService,
    ReorgDetectorService,
    ReconciliationService,
    EventIndexingService,
    WeightedVoteResolutionService,
    BlockchainReorgAlertService,
  ],
})
export class BlockchainModule {}
