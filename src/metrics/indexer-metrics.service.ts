import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, register } from 'prom-client';
import { BlockchainStateService } from '../blockchain/state.service';
import { IndexerHealthSnapshot } from '../blockchain/types';

/**
 * Exposes sanitized indexer lag, finality, and projection health metrics to
 * Prometheus. Values are sampled from the live BlockchainStateService and never
 * include credentials, user data, or live RPC URLs.
 */
@Injectable()
export class IndexerMetricsService {
  private readonly logger = new Logger(IndexerMetricsService.name);

  private observedHeadGauge: Gauge;
  private safeBlockGauge: Gauge;
  private finalizedBlockGauge: Gauge;
  private projectionHeadGauge: Gauge;
  private projectionLagGauge: Gauge;
  private rpcFailuresCounter: Counter;
  private replayCounter: Counter;
  private deadLetterCounter: Counter;

  constructor(private readonly stateService: BlockchainStateService) {
    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    this.observedHeadGauge = new Gauge({
      name: 'indexer_observed_head',
      help: 'Highest block number observed from the RPC provider',
    });

    this.safeBlockGauge = new Gauge({
      name: 'indexer_safe_block',
      help: 'Chain safe cursor (reorg-unlikely boundary)',
    });

    this.finalizedBlockGauge = new Gauge({
      name: 'indexer_finalized_block',
      help: 'Chain finalized cursor (finality boundary)',
    });

    this.projectionHeadGauge = new Gauge({
      name: 'indexer_projection_head',
      help: 'Highest block to which projections (derived state) have advanced',
    });

    this.projectionLagGauge = new Gauge({
      name: 'indexer_projection_lag_blocks',
      help: 'Projection lag in blocks (observed head minus finalized cursor)',
    });

    this.rpcFailuresCounter = new Counter({
      name: 'indexer_rpc_failures_total',
      help: 'Cumulative number of RPC failures observed by the indexer',
    });

    this.replayCounter = new Counter({
      name: 'indexer_replay_count_total',
      help: 'Cumulative number of event replays processed after reorg/retry',
    });

    this.deadLetterCounter = new Counter({
      name: 'indexer_dead_letters_total',
      help: 'Cumulative number of dead-lettered events (failed past max retries)',
    });

    register.registerMetric(this.observedHeadGauge);
    register.registerMetric(this.safeBlockGauge);
    register.registerMetric(this.finalizedBlockGauge);
    register.registerMetric(this.projectionHeadGauge);
    register.registerMetric(this.projectionLagGauge);
    register.registerMetric(this.rpcFailuresCounter);
    register.registerMetric(this.replayCounter);
    register.registerMetric(this.deadLetterCounter);
  }

  /**
   * Sample the current indexer health snapshot into Prometheus metrics.
   */
  async collect(): Promise<void> {
    try {
      const health = await this.stateService.getIndexerHealth();
      this.apply(health);
    } catch (error) {
      this.logger.warn(
        `Failed to collect indexer metrics: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Apply a known snapshot to the gauges/counters. Used directly by collectors
   * that already hold the health snapshot (avoids a duplicate DB/state read).
   */
  apply(health: IndexerHealthSnapshot): void {
    this.observedHeadGauge.set(health.observedHeadBlock);
    this.safeBlockGauge.set(health.safeBlock);
    this.finalizedBlockGauge.set(health.finalizedBlock);
    this.projectionHeadGauge.set(health.projectionHeadBlock);
    this.projectionLagGauge.set(health.projectionLag);
    // Counters reflect cumulative totals; report absolute values idempotently.
    this.rpcFailuresCounter.reset();
    this.rpcFailuresCounter.inc(health.rpcFailureCount);
    this.replayCounter.reset();
    this.replayCounter.inc(health.replayCount);
    this.deadLetterCounter.reset();
    this.deadLetterCounter.inc(health.deadLetterCount);
  }

  /**
   * Expose the aggregated Prometheus registry text (includes HTTP + indexer metrics).
   */
  async getMetrics(): Promise<string> {
    await this.collect();
    return register.metrics();
  }
}
