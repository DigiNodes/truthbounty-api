import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { register } from 'prom-client';
import { MetricsService } from '../metrics.service';
import { MetricsAuthGuard } from '../metrics-auth.guard';
import {
  CARDINALITY_BUDGET,
  MAX_VALUES_PER_LABEL,
  OTHER_LABEL_VALUE,
  assertCardinalityBudget,
  countSeries,
  isUnboundedLabelValue,
  resetLabelValueBudget,
  sanitizeMetricLabels,
} from '../metrics-label-policy';

const WALLET = '0x' + 'a'.repeat(40);
const TX_HASH = '0x' + 'b'.repeat(64);
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const RPC_URL = 'https://rpc.mainnet.example/v1?key=secret';
const ERROR_TEXT =
  'TypeError: cannot read properties of undefined (reading id)';

const PROBE = 'cardinality_probe_total';
const LOAD = 'cardinality_load_total';
const GAUGE = 'cardinality_gauge';

const probe = (metrics: string, name: string): string[] =>
  metrics.split('\n').filter((line) => line.startsWith(name));

describe('metrics label & cardinality policy', () => {
  const service = new MetricsService();

  beforeEach(() => resetLabelValueBudget());

  afterAll(() => {
    for (const name of [PROBE, LOAD, GAUGE]) {
      register.removeSingleMetric(name);
    }
  });

  describe('sanitizeMetricLabels', () => {
    it('rejects unbounded identifier keys outright', () => {
      const labels = sanitizeMetricLabels('m_total', {
        operation: 'GET',
        wallet: WALLET,
        claimId: 'claim-42',
        cid: CID,
        url: RPC_URL,
        error: ERROR_TEXT,
      });

      expect(labels).toEqual({ operation: 'GET' });
    });

    it('collapses unbounded values on an allowed key', () => {
      const labels = sanitizeMetricLabels('m_total', { operation: WALLET });
      expect(labels).toEqual({ operation: OTHER_LABEL_VALUE });
    });

    it('caps the number of distinct values per label', () => {
      const values = new Set<string>();
      for (let i = 0; i < MAX_VALUES_PER_LABEL + 50; i++) {
        const out = sanitizeMetricLabels('m_total', { operation: `op${i}` });
        values.add(out.operation);
      }
      expect(values.size).toBeLessThanOrEqual(MAX_VALUES_PER_LABEL + 1);
      expect(values.has(OTHER_LABEL_VALUE)).toBe(true);
    });

    it('flags unbounded label values', () => {
      const values = [
        WALLET,
        TX_HASH,
        CID,
        RPC_URL,
        ERROR_TEXT,
        'x'.repeat(200),
      ];
      for (const v of values) {
        expect(isUnboundedLabelValue(v)).toBe(true);
      }
      expect(isUnboundedLabelValue('success')).toBe(false);
    });
  });

  describe('MetricsService injection', () => {
    it('rejects wallet/claim/CID/URL/error as labels', async () => {
      service.incrementCounter(PROBE, {
        operation: WALLET,
        wallet: WALLET,
        claimId: 'claim-42',
        cid: CID,
        url: RPC_URL,
        error: ERROR_TEXT,
        status: 'success',
      });

      const metrics = await service.getMetrics();
      expect(metrics).not.toContain(WALLET);
      expect(metrics).not.toContain(CID);
      expect(metrics).not.toContain(RPC_URL);
      expect(metrics).not.toContain(ERROR_TEXT);
      expect(metrics).not.toContain('wallet=');
      expect(metrics).not.toContain('claimId=');
      expect(metrics).toContain('operation="other"');
      expect(metrics).toContain('status="success"');
    });

    it('keeps series bounded under a high-cardinality load', async () => {
      for (let i = 0; i < 1000; i++) {
        service.incrementCounter(LOAD, { operation: `op-${i}` });
      }

      const metrics = await service.getMetrics();
      expect(probe(metrics, LOAD).length).toBeLessThanOrEqual(
        MAX_VALUES_PER_LABEL + 1,
      );
      expect(() => assertCardinalityBudget(metrics)).not.toThrow();
    });

    it('drops secret-shaped values instead of exporting them', async () => {
      service.setGauge(GAUGE, 1, { dependency: 'sk-live-canary-secret-value' });

      const metrics = await service.getMetrics();
      expect(metrics).not.toContain('canary');
      expect(metrics).toContain('dependency="other"');
    });
  });

  describe('scrape', () => {
    it('exposes HTTP metrics within the cardinality budget', async () => {
      service.incrementRequest('GET', '/claims/:id', '200');
      service.observeLatency('GET', '/claims/:id', '200', 0.2);
      const metrics = await service.getMetrics();

      expect(metrics).toContain('http_requests_total');
      expect(countSeries(metrics)).toBeLessThanOrEqual(CARDINALITY_BUDGET);
      expect(() => assertCardinalityBudget(metrics)).not.toThrow();
    });

    it('uses the documented histogram buckets, including +Inf', async () => {
      service.observeLatency('GET', '/claims/:id', '200', 0.2);
      const metrics = await service.getMetrics();

      for (const le of ['0.1', '0.3', '1.5', '10', '+Inf']) {
        expect(metrics).toContain(`le="${le}"`);
      }
    });

    it('normalises a raw URL passed as a route label', async () => {
      service.incrementRequest('GET', RPC_URL, '200');
      const metrics = await service.getMetrics();

      expect(metrics).not.toContain('rpc.mainnet.example');
      expect(metrics).toContain('route="other"');
    });
  });

  describe('cardinality budget gate', () => {
    it('fails when a scrape exceeds the budget', () => {
      const lines = Array.from(
        { length: CARDINALITY_BUDGET + 1 },
        (_, i) => `over_budget_total{op="op-${i}"} 1`,
      );

      expect(() => assertCardinalityBudget(lines.join('\n'))).toThrow(
        /cardinality budget exceeded/,
      );
    });
  });

  describe('MetricsAuthGuard', () => {
    const contextFor = (headers: Record<string, string>): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers }) }),
      }) as unknown as ExecutionContext;

    const guardWith = (token?: string) =>
      new MetricsAuthGuard({
        get: () => token,
      } as unknown as ConfigService);

    it('rejects an unauthenticated scrape', () => {
      const guard = guardWith('s3cret-token');
      const missing = () => guard.canActivate(contextFor({}));
      expect(missing).toThrow(UnauthorizedException);

      const wrong = () =>
        guard.canActivate(contextFor({ authorization: 'Bearer wrong' }));
      expect(wrong).toThrow(UnauthorizedException);
    });

    it('allows a scrape with the configured token', () => {
      const guard = guardWith('s3cret-token');
      const request = contextFor({ authorization: 'Bearer s3cret-token' });
      expect(guard.canActivate(request)).toBe(true);
    });
  });
});
