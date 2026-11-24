import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { IndexerMetricsService } from './indexer-metrics.service';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { MetricsCoreModule } from './metrics-core.module';

@Module({
  imports: [BlockchainModule, MetricsCoreModule],
  controllers: [MetricsController],
  providers: [IndexerMetricsService],
  exports: [MetricsCoreModule, IndexerMetricsService],
})
export class MetricsModule {}
