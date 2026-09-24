import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { IndexerMetricsService } from './indexer-metrics.service';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [BlockchainModule],
  controllers: [MetricsController],
  providers: [MetricsService, IndexerMetricsService],
  exports: [MetricsService, IndexerMetricsService],
})
export class MetricsModule {}
