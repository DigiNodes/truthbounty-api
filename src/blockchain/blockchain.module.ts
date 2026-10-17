import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import {
  ProcessedEvent,
  TokenBalance,
  IndexerCheckpoint,
  DeadLetterReplay,
} from './entities';
import { BlockchainStateService } from './state.service';
import { ReorgDetectorService } from './reorg-detector.service';
import { ReconciliationService } from './reconciliation.service';
import { EventIndexingService } from './event-indexing.service';
import { BlockchainController } from './blockchain.controller';
import { WeightedVoteResolutionService } from './weighted-vote-resolution.service';
import { SybilResistanceModule } from '../sybil-resistance/sybil-resistance.module';
import { StartupValidationService } from './startup-validation.service';
import { DeterministicRpcFailoverService } from './deterministic-rpc-failover.service';
import { ReadinessService } from './readiness.service';
import { DependencyProvenanceService } from './dependency-provenance.service';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { DeadLetterReplayService } from './dead-letter-replay.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProcessedEvent,
      TokenBalance,
      IndexerCheckpoint,
      DeadLetterReplay,
    ]),
    SybilResistanceModule,
    AdminAuditModule,
  ],
  providers: [
    BlockchainIndexerService,
    BlockchainStateService,
    ReadinessService,
    DependencyProvenanceService,
    ReorgDetectorService,
    ReconciliationService,
    EventIndexingService,
    StartupValidationService,
    DeterministicRpcFailoverService,
    DeadLetterReplayService,
  ],
  controllers: [BlockchainController],
  exports: [
    BlockchainIndexerService,
    BlockchainStateService,
    ReadinessService,
    DependencyProvenanceService,
    ReorgDetectorService,
    ReconciliationService,
    EventIndexingService,
    DeterministicRpcFailoverService,
    DeadLetterReplayService,
  ],
})
export class BlockchainModule {}
