import { Module } from '@intest/common';
import { TypeOrmModule } from '@intest/typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { ProcessedEvent, TokenBalance, IndexerCheckpoint } from './entities';
import { BlockchainStateService } from './state.service';
import { ReorgDetectorService } from './reorg-detector.service';
import { ReconciliationService } from './reconciliation.service';
import { EventIndexingService } from './event-indexing.service';
import { BlockchainController } from './blockchain.controller';
import { WeightedVoteResolutionService } from './weighted-vote-resolution.service';
import { SybilResistanceModule } from '../sybil-resistance/sybil-resistance.module';
import { StartupValidationService } from './startup-validation.service';
import { DeterministicRpcFailoverService } from './deterministic-rpc-failover.service';
import { StreamEnvelopeService } from './stream-envelope.service';
import { ResumeTokenService } from './resume-token.service';
import { StreamBackfillService } from './stream-backfill.service';
import { StreamGapDetectorService } from './stream-gap-detector.service';
import { StreamSessionManagerService } from './stream-session-manager.service';
import { StreamController } from './stream.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProcessedEvent, TokenBalance, IndexerCheckpoint]),
    SybilResistanceModule,
  ],
  providers: [
    BlockchainIndexerService,
    BlockchainStateService,
    ReorgDetectorService,
    ReconciliationService,
    EventIndexingService,
    StartupValidationService,
    DeterministicRpcFailoverService,
    StreamEnvelopeService,
    ResumeTokenService,
    StreamBackfillService,
    StreamGapDetectorService,
    StreamSessionManagerService,
  ],
  controllers: [BlockchainController, StreamController],
  exports: [
    BlockchainIndexerService,
    BlockchainStateService,
    ReorgDetectorService,
    ReconciliationService,
    EventIndexingService,
    DeterministicRpcFailoverService,
    StreamEnvelopeService,
    ResumeTokenService,
    StreamBackfillService,
    StreamGapDetectorService,
    StreamSessionManagerService,
  ],
})
export class BlockchainModule {}
