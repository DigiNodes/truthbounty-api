import { register } from 'prom-client';
import { IndexerMetricsService } from '../indexer-metrics.service';
import { BlockchainStateService } from '../../blockchain/state.service';

describe('IndexerMetricsService', () => {
  let service: IndexerMetricsService;
  let stateService: {
    getIndexerHealth: jest.Mock;
  };

  const healthySnapshot = {
    status: 'healthy' as const,
    timestamp: new Date().toISOString(),
    observedHeadBlock: 100,
    safeBlock: 88,
    finalizedBlock: 80,
    projectionHeadBlock: 80,
    projectionLag: 20,
    rpcFailureCount: 4,
    replayCount: 7,
    deadLetterCount: 1,
    alertThresholds: {
      projectionLagBlocks: 150,
      rpcFailureRateWindow: 300000,
      maxDeadLetters: 100,
    },
    runbookUrl:
      'https://github.com/DigiNodes/truthbounty-api/blob/main/docs/indexer-runbook.md',
  };

  beforeEach(() => {
    stateService = {
      getIndexerHealth: jest.fn().mockResolvedValue(healthySnapshot),
    };
    service = new IndexerMetricsService(
      stateService as unknown as BlockchainStateService,
    );
  });

  afterEach(async () => {
    // Remove only the metrics this service registers so later tests start clean.
    const names = [
      'indexer_observed_head',
      'indexer_safe_block',
      'indexer_finalized_block',
      'indexer_projection_head',
      'indexer_projection_lag_blocks',
      'indexer_rpc_failures_total',
      'indexer_replay_count_total',
      'indexer_dead_letters_total',
    ];
    names.forEach((name) => register.removeSingleMetric(name));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should apply the health snapshot to gauges and counters', async () => {
    service.apply(healthySnapshot);
    const metrics = await register.metrics();

    expect(metrics).toContain('indexer_projection_lag_blocks 20');
    expect(metrics).toContain('indexer_rpc_failures_total 4');
    expect(metrics).toContain('indexer_replay_count_total 7');
    expect(metrics).toContain('indexer_dead_letters_total 1');
  });

  it('should collect metrics from the state service on getMetrics', async () => {
    const output = await service.getMetrics();

    expect(stateService.getIndexerHealth).toHaveBeenCalled();
    expect(output).toContain('indexer_observed_head 100');
    expect(output).toContain('indexer_finalized_block 80');
  });

  it('should expose sanitized metrics that do not leak credentials', async () => {
    const output = await service.getMetrics();
    expect(output).not.toContain('mainnet.optimism.io');
    expect(output).not.toContain('password');
    expect(output).not.toContain('secret');
  });
});
