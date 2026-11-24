import { HealthService } from './health.service';
import { FinalizedCursorService } from '../indexer/finalized-cursor/finalized-cursor.service';

/**
 * PREWAVE-BE-001: readiness must fail when the finalized cursor exceeds the
 * configured lag/freshness policy. Constructed directly so the test does not
 * depend on the unrelated providers of the full health module.
 */
describe('HealthService finalized cursor readiness (PREWAVE-BE-001)', () => {
  function makeHealthService(cursor?: Partial<FinalizedCursorService>) {
    const ok = jest.fn().mockResolvedValue(undefined);
    return new HealthService(
      { query: ok } as any,
      { checkReadiness: jest.fn().mockResolvedValue({ ready: true }) } as any,
      { isHealthy: jest.fn().mockResolvedValue(true) } as any,
      {
        name: 'jobs-queue',
        getJobCounts: jest.fn().mockResolvedValue({}),
      } as any,
      {} as any,
      { getMetrics: jest.fn().mockResolvedValue({ queueDepth: 0 }) } as any,
      { uploadBuffer: jest.fn().mockResolvedValue({ cid: 'bafy' }) } as any,
      {
        getChainState: jest.fn().mockResolvedValue({ lastProcessedBlock: 1 }),
        getIndexerHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
      } as any,
      {
        setQueueDepth: jest.fn(),
        setBlockchainIndexingState: jest.fn(),
      } as any,
      cursor as FinalizedCursorService | undefined,
    );
  }

  const status = (ready: boolean, reasons: string[] = []) => ({
    ready,
    reasons,
  });

  it('does not add the check when no release binding is configured', async () => {
    const result = await makeHealthService({
      isConfigured: () => false,
    }).getReadiness();
    expect(result.dependencies.map((d) => d.name)).not.toContain(
      'finalized_cursor',
    );
    expect(result.ready).toBe(true);
  });

  it('is ready when the cursor satisfies policy', async () => {
    const result = await makeHealthService({
      isConfigured: () => true,
      getConfiguredStatus: jest.fn().mockResolvedValue(status(true)),
    }).getReadiness();
    const check = result.dependencies.find(
      (d) => d.name === 'finalized_cursor',
    )!;
    expect(check).toMatchObject({ status: 'healthy', critical: true });
    expect(result.ready).toBe(true);
  });

  it.each([
    [['INDEX_LAG_EXCEEDED']],
    [['HEADS_STALE']],
    [['WRONG_RELEASE']],
    [['CURSOR_MISSING']],
  ])('fails readiness closed on %s', async (reasons) => {
    const result = await makeHealthService({
      isConfigured: () => true,
      getConfiguredStatus: jest.fn().mockResolvedValue(status(false, reasons)),
    }).getReadiness();
    const check = result.dependencies.find(
      (d) => d.name === 'finalized_cursor',
    )!;
    expect(check.status).toBe('unhealthy');
    expect(check.failureReason).toContain(reasons[0]);
    expect(result.ready).toBe(false);
  });

  it('fails readiness when the cursor cannot be read', async () => {
    const result = await makeHealthService({
      isConfigured: () => true,
      getConfiguredStatus: jest.fn().mockRejectedValue(new Error('db down')),
    }).getReadiness();
    expect(result.ready).toBe(false);
  });
});
