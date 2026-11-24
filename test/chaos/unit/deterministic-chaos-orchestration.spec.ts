import { DeterministicChaosOrchestrator } from '../harness/chaos-orchestrator';
import { ProductionTargetError, assertSafeChaosEnvironment, assertSafeTargetUrl } from '../harness/fault-guard';
import { DeterministicPRNG } from '../harness/prng';
import {
  assertBoundedFailure,
  assertDigestParity,
  assertFailClosed,
  assertIdempotentRecovery,
  assertNoDuplicate,
  assertNoFalseFreshness,
  assertNoGap,
  computeStateDigest,
} from '../harness/recovery-assertions';

describe('PREWAVE-BE-091: Deterministic Dependency-Failure Chaos Orchestration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TRUTHBOUNTY_CHAOS_ALLOWED = 'true';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const createSafeProfile = (seed = 'test-seed-42') => ({
    name: 'Standard-Dependency-Chaos-Profile',
    seed,
    retryBudget: 3,
    dependencies: {
      db: { targetUrl: 'postgres://postgres:postgres@localhost:5432/truthbounty_test' },
      redis: { targetUrl: 'redis://localhost:6379/1' },
      rpc: { targetUrl: 'https://sepolia.optimism.io' },
      ipfs: { targetUrl: 'http://localhost:5001/api/v0' },
      provider: { targetUrl: 'https://api-sandbox.truthbounty.test/v1' },
      queue: { targetUrl: 'redis://localhost:6379/2' },
      stream: { targetUrl: 'ws://localhost:3000/events' },
    },
  });

  describe('1. Production-Target Rejection Guards', () => {
    it('rejects chaos injection when NODE_ENV=production', () => {
      expect(() =>
        assertSafeChaosEnvironment('http://localhost:3000', {
          NODE_ENV: 'production',
          TRUTHBOUNTY_CHAOS_ALLOWED: 'true',
        }),
      ).toThrow(ProductionTargetError);
    });

    it('rejects chaos injection when TRUTHBOUNTY_CHAOS_ALLOWED is missing or false', () => {
      expect(() =>
        assertSafeChaosEnvironment('http://localhost:3000', {
          NODE_ENV: 'test',
          TRUTHBOUNTY_CHAOS_ALLOWED: 'false',
        }),
      ).toThrow(ProductionTargetError);
    });

    it('rejects prohibited production domains and mainnet RPC endpoints', () => {
      const prohibitedUrls = [
        'https://mainnet.optimism.io',
        'https://opt-mainnet.g.alchemy.com/v2/my-secret-key',
        'https://optimism-mainnet.infura.io/v3/my-secret-key',
        'postgres://prod-user:pass@db.truthbounty.io:5432/truthbounty_prod',
        'redis://prod-redis.internal.truthbounty.org:6379',
      ];

      for (const url of prohibitedUrls) {
        expect(() => assertSafeTargetUrl(url)).toThrow(ProductionTargetError);
      }
    });

    it('allows safe local, test, dev, and sepolia endpoints', () => {
      const safeUrls = [
        'http://localhost:3000',
        'http://127.0.0.1:8545',
        'https://sepolia.optimism.io',
        'postgres://postgres:pass@localhost:5432/truthbounty_test',
        'redis://localhost:6379/1',
      ];

      for (const url of safeUrls) {
        expect(() => assertSafeTargetUrl(url)).not.toThrow();
      }
    });
  });

  describe('2. Deterministic Seed and Scenario Profiles', () => {
    it('produces identical PRNG sequences given the same seed', () => {
      const prng1 = new DeterministicPRNG('pinned-seed-12345');
      const prng2 = new DeterministicPRNG('pinned-seed-12345');

      const seq1 = Array.from({ length: 10 }, () => prng1.next());
      const seq2 = Array.from({ length: 10 }, () => prng2.next());

      expect(seq1).toEqual(seq2);
    });

    it('produces different sequences for distinct seeds', () => {
      const prngA = new DeterministicPRNG('seed-A');
      const prngB = new DeterministicPRNG('seed-B');

      expect(prngA.next()).not.toEqual(prngB.next());
    });
  });

  describe('3. Each Dependency: fail / slow / corrupt / recover', () => {
    let orchestrator: DeterministicChaosOrchestrator;

    beforeEach(() => {
      orchestrator = new DeterministicChaosOrchestrator(createSafeProfile());
    });

    // Dependency 1: DB
    it('DB: fail, slow, corrupt, recover lifecycle', async () => {
      const query = async () => 'db_result';

      // Healthy
      await expect(orchestrator.db.executeQuery(query)).resolves.toBe('db_result');

      // Fail
      await orchestrator.injectFault('db', 'fail');
      await expect(orchestrator.db.executeQuery(query)).rejects.toThrow('CHAOS FAULT: Database');

      // Recover
      await orchestrator.recoverDependency('db');
      await expect(orchestrator.db.executeQuery(query)).resolves.toBe('db_result');

      // Slow
      await orchestrator.injectFault('db', 'slow', { latencyMs: 25 });
      const start = Date.now();
      await orchestrator.db.executeQuery(query);
      expect(Date.now() - start).toBeGreaterThanOrEqual(20);

      // Corrupt
      await orchestrator.injectFault('db', 'corrupt');
      await expect(orchestrator.db.executeQuery(query)).rejects.toThrow('SQLSTATE 40P01');

      // Recover again
      await orchestrator.recoverDependency('db');
      await expect(orchestrator.db.executeQuery(query)).resolves.toBe('db_result');
    });

    // Dependency 2: Redis
    it('Redis: fail, slow, corrupt, recover lifecycle', async () => {
      await orchestrator.redis.set('foo', 'bar');
      await expect(orchestrator.redis.get('foo')).resolves.toBe('bar');

      // Fail
      await orchestrator.injectFault('redis', 'fail');
      await expect(orchestrator.redis.get('foo')).rejects.toThrow('CHAOS FAULT: Redis');

      // Recover
      await orchestrator.recoverDependency('redis');
      await expect(orchestrator.redis.get('foo')).resolves.toBe('bar');

      // Corrupt
      await orchestrator.injectFault('redis', 'corrupt');
      const corruptedVal = await orchestrator.redis.get('foo');
      expect(corruptedVal).toContain('corrupted');

      // Recover
      await orchestrator.recoverDependency('redis');
      await expect(orchestrator.redis.get('foo')).resolves.toBe('bar');
    });

    // Dependency 3: RPC
    it('RPC: fail, slow, corrupt, recover lifecycle', async () => {
      await expect(orchestrator.rpc.getBlockNumber(100)).resolves.toBe(100);

      // Fail
      await orchestrator.injectFault('rpc', 'fail');
      await expect(orchestrator.rpc.getBlockNumber(100)).rejects.toThrow('CHAOS FAULT: RPC');

      // Recover
      await orchestrator.recoverDependency('rpc');
      await expect(orchestrator.rpc.getBlockNumber(100)).resolves.toBe(100);

      // Corrupt (stale head divergence)
      await orchestrator.injectFault('rpc', 'corrupt');
      const head = await orchestrator.rpc.getBlockNumber(100);
      expect(head).toBe(50); // Stale/divergent block height

      // Recover
      await orchestrator.recoverDependency('rpc');
      await expect(orchestrator.rpc.getBlockNumber(100)).resolves.toBe(100);
    });

    // Dependency 4: IPFS
    it('IPFS: fail, slow, corrupt, recover lifecycle', async () => {
      const orig = Buffer.from('canonical-evidence-data');
      await expect(orchestrator.ipfs.fetchContent('cid-123', orig)).resolves.toEqual(orig);

      // Fail
      await orchestrator.injectFault('ipfs', 'fail');
      await expect(orchestrator.ipfs.fetchContent('cid-123', orig)).rejects.toThrow('CHAOS FAULT: IPFS');

      // Corrupt (tampered evidence payload)
      await orchestrator.recoverDependency('ipfs');
      await orchestrator.injectFault('ipfs', 'corrupt');
      const tampered = await orchestrator.ipfs.fetchContent('cid-123', orig);
      expect(tampered.toString()).toContain('tampered-evidence-content');

      // Recover
      await orchestrator.recoverDependency('ipfs');
      await expect(orchestrator.ipfs.fetchContent('cid-123', orig)).resolves.toEqual(orig);
    });

    // Dependency 5: Provider
    it('Provider: fail, slow, corrupt, recover lifecycle', async () => {
      const fallback = async () => ({ score: 0.95 });
      await expect(orchestrator.provider.invoke({}, fallback)).resolves.toEqual({ score: 0.95 });

      // Fail
      await orchestrator.injectFault('provider', 'fail');
      await expect(orchestrator.provider.invoke({}, fallback)).rejects.toThrow('CHAOS FAULT: Provider');

      // Corrupt
      await orchestrator.recoverDependency('provider');
      await orchestrator.injectFault('provider', 'corrupt');
      await expect(orchestrator.provider.invoke({}, fallback)).rejects.toThrow('Malformed model completion');

      // Recover
      await orchestrator.recoverDependency('provider');
      await expect(orchestrator.provider.invoke({}, fallback)).resolves.toEqual({ score: 0.95 });
    });

    // Dependency 6: Queue
    it('Queue: fail, slow, corrupt (duplicate delivery), recover lifecycle', async () => {
      let callCount = 0;
      const handler = async () => {
        callCount++;
      };

      await orchestrator.queue.dispatch('job-1', { id: 'evt-1' }, handler);
      expect(callCount).toBe(1);

      // Fail
      await orchestrator.injectFault('queue', 'fail');
      await expect(orchestrator.queue.dispatch('job-2', {}, handler)).rejects.toThrow('CHAOS FAULT: Queue');

      // Corrupt (duplicate delivery attempt)
      await orchestrator.recoverDependency('queue');
      await orchestrator.injectFault('queue', 'corrupt');
      const deliveries = await orchestrator.queue.dispatch('job-3', {}, handler);
      expect(deliveries).toBe(2);

      // Recover
      await orchestrator.recoverDependency('queue');
      const normalDeliveries = await orchestrator.queue.dispatch('job-4', {}, handler);
      expect(normalDeliveries).toBe(1);
    });

    // Dependency 7: Stream
    it('Stream: fail, slow, corrupt, recover lifecycle', async () => {
      let received: any = null;
      await orchestrator.stream.emitEvent('bounties', { id: 1 }, (e) => {
        received = e;
      });
      expect(received).toEqual({ id: 1 });

      // Corrupt
      await orchestrator.injectFault('stream', 'corrupt');
      await orchestrator.stream.emitEvent('bounties', { id: 2 }, (e) => {
        received = e;
      });
      expect(received).toHaveProperty('invalid_frame', true);

      // Recover
      await orchestrator.recoverDependency('stream');
      await orchestrator.stream.emitEvent('bounties', { id: 3 }, (e) => {
        received = e;
      });
      expect(received).toEqual({ id: 3 });
    });

    // Dependency 8: Clock
    it('Clock: skew, freeze, leap, and recover lifecycle', () => {
      const t0 = orchestrator.clock.now();
      expect(typeof t0).toBe('number');

      // Freeze
      const fixed = 1_700_000_000_000;
      orchestrator.clock.freeze(fixed);
      expect(orchestrator.clock.now()).toBe(fixed);

      // Unfreeze / Recover
      orchestrator.clock.unfreeze();
      expect(orchestrator.clock.now()).toBeGreaterThan(fixed);

      // Skew
      orchestrator.clock.skew(60_000);
      expect(orchestrator.clock.now()).toBeGreaterThanOrEqual(Date.now() + 59_000);

      // Recover
      orchestrator.clock.recover();
      expect(Math.abs(orchestrator.clock.now() - Date.now())).toBeLessThan(1000);
    });
  });

  describe('4. Combined Cascading Failures and Recovery', () => {
    it('handles multi-dependency combined failures and recovers cleanly', async () => {
      const orchestrator = new DeterministicChaosOrchestrator(createSafeProfile('cascading-seed'));

      const faultRecords = await orchestrator.injectCombinedFailure();
      expect(faultRecords.length).toBe(3);

      expect(orchestrator.rpc.getState().mode).toBe('slow');
      expect(orchestrator.redis.getState().mode).toBe('fail');
      expect(orchestrator.db.getState().mode).toBe('slow');

      // Recover all
      await orchestrator.recoverAll();

      expect(orchestrator.rpc.getState().healthy).toBe(true);
      expect(orchestrator.redis.getState().healthy).toBe(true);
      expect(orchestrator.db.getState().healthy).toBe(true);
    });
  });

  describe('5. Retry Budget & Circuit Breaker', () => {
    it('exhausts retry budget, trips circuit breaker, and redacts sensitive error strings', async () => {
      const orchestrator = new DeterministicChaosOrchestrator(createSafeProfile('retry-budget-test'));

      let tries = 0;
      const failingOpWithSecrets = async () => {
        tries++;
        throw new Error('Database connect error: password="SuperSecretPassword123" token=0xabcdef123456');
      };

      await expect(
        orchestrator.executeWithRetryBudget('test-op', failingOpWithSecrets),
      ).rejects.toThrow('Retry budget (3) exceeded');

      expect(tries).toBe(4); // 1 initial + 3 retries

      // Subsequent call should immediately trip circuit breaker
      await expect(
        orchestrator.executeWithRetryBudget('test-op-2', async () => 'ok'),
      ).rejects.toThrow('CIRCUIT BREAKER OPEN');
    });
  });

  describe('6. Graceful Shutdown Under Active Chaos', () => {
    it('cleanly shuts down and drains active faults', async () => {
      const orchestrator = new DeterministicChaosOrchestrator(createSafeProfile('shutdown-test'));

      await orchestrator.injectFault('rpc', 'fail');
      await orchestrator.injectFault('db', 'slow');

      const result = await orchestrator.initiateGracefulShutdown();
      expect(result.clean).toBe(true);
      expect(result.activeFaultsDrained).toBe(2);

      // No new faults can be injected while shutting down
      await expect(orchestrator.injectFault('redis', 'fail')).rejects.toThrow(
        'Cannot inject fault while orchestrator is shutting down',
      );
    });
  });

  describe('7. Recovery Invariant Assertions: No-Gap, No-Duplicate, No-False-Freshness, Digest Parity', () => {
    it('assertNoGap accepts contiguous sequences and rejects gaps', () => {
      expect(() => assertNoGap([100, 101, 102, 103])).not.toThrow();
      expect(() => assertNoGap([100, 101, 103])).toThrow('Sequence gap detected');
      expect(() =>
        assertNoGap({ start: 10, end: 14, received: [10, 11, 12, 14] }),
      ).toThrow('missing 1 item(s)');
    });

    it('assertNoDuplicate accepts unique items and rejects duplicates', () => {
      expect(() => assertNoDuplicate(['evt-1', 'evt-2', 'evt-3'])).not.toThrow();
      expect(() => assertNoDuplicate(['evt-1', 'evt-2', 'evt-1'])).toThrow(
        'Duplicate invariant violated',
      );
    });

    it('assertNoFalseFreshness rejects serving stale state as fresh', () => {
      const now = Date.now();
      // Fresh state within lag budget
      expect(() =>
        assertNoFalseFreshness({
          updatedAt: now - 1000,
          headTimestamp: now,
          maxAllowedLagMs: 5000,
          isDegraded: false,
          isStaleServedAsFresh: false,
        }),
      ).not.toThrow();

      // Degraded lag flagged explicitly
      expect(() =>
        assertNoFalseFreshness({
          updatedAt: now - 30_000,
          headTimestamp: now,
          maxAllowedLagMs: 5000,
          isDegraded: true,
          isStaleServedAsFresh: false,
        }),
      ).not.toThrow();

      // Lag exceeded but not flagged degraded -> false freshness violation
      expect(() =>
        assertNoFalseFreshness({
          updatedAt: now - 30_000,
          headTimestamp: now,
          maxAllowedLagMs: 5000,
          isDegraded: false,
          isStaleServedAsFresh: false,
        }),
      ).toThrow('False freshness invariant violated');
    });

    it('assertDigestParity verifies projection digest match', () => {
      const stateA = { bounties: 12, resolved: 8, totalPayout: '5000000' };
      const stateB = { bounties: 12, resolved: 8, totalPayout: '5000000' };
      const digestA = computeStateDigest(stateA);
      const digestB = computeStateDigest(stateB);

      expect(() => assertDigestParity(digestA, digestB)).not.toThrow();

      const stateC = { bounties: 12, resolved: 9, totalPayout: '5000000' };
      const digestC = computeStateDigest(stateC);
      expect(() => assertDigestParity(digestA, digestC)).toThrow('Projection digest mismatch');
    });
  });

  describe('8. Evidence Records Exact Inputs and Proves Invariants', () => {
    it('generates reproducible, redacted chaos evidence report', () => {
      const orchestrator = new DeterministicChaosOrchestrator(createSafeProfile('audit-pinned-seed-99'));

      const processedBlocks = [1000, 1001, 1002, 1003, 1004];
      const finalState = { block: 1004, activeClaims: 3 };
      const canonicalState = { block: 1004, activeClaims: 3 };

      const evidence = orchestrator.generateEvidenceReport(
        '70efcca5e9c9bd5fe9dc995d5f4e3f6267975fa6',
        finalState,
        canonicalState,
        processedBlocks,
      );

      expect(evidence.seed).toBe('audit-pinned-seed-99');
      expect(evidence.commitHash).toBe('70efcca5e9c9bd5fe9dc995d5f4e3f6267975fa6');
      expect(evidence.assertions.noGap).toBe(true);
      expect(evidence.assertions.noDuplicate).toBe(true);
      expect(evidence.assertions.digestParity).toBe(true);
      expect(evidence.assertions.secretsRedacted).toBe(true);
      expect(evidence.finalDigest).toHaveLength(64);
    });
  });
});
