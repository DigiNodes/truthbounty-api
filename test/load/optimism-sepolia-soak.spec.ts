import { runOptimismSepoliaSoak } from '../../scripts/optimism-sepolia-soak-runner';
import {
  assertNoGap,
  assertNoDuplicate,
  assertNoFalseFreshness,
  assertDigestParity,
} from '../chaos/harness/recovery-assertions';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('PREWAVE-BE-092: Optimism Sepolia Soak Tests & Evidence Validation', () => {
  let soakReport: Awaited<ReturnType<typeof runOptimismSepoliaSoak>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.TRUTHBOUNTY_CHAOS_ALLOWED = 'true';
    soakReport = await runOptimismSepoliaSoak({ allowChaos: true });
  });

  describe('1. Pinned Release Provenance & Manifest Integrity', () => {
    it('verifies exact Optimism Sepolia chain ID and release ID', () => {
      expect(soakReport.provenance.chainId).toBe(11155420);
      expect(soakReport.provenance.releaseId).toBe('rel-opsepolia-20261015-v2');
      expect(soakReport.provenance.manifestVersion).toBe('2.0.0-rc.3');
    });

    it('verifies all commits and deployment blocks are pinned and non-empty', () => {
      expect(soakReport.provenance.apiCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(soakReport.provenance.contractsCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(soakReport.provenance.protocolCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(soakReport.provenance.manifestChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(soakReport.provenance.deploymentBlock).toBe(24850000);
    });

    it('verifies all canonical contract addresses are valid EIP-55 checksums', () => {
      const addresses = Object.values(soakReport.provenance.contractAddresses);
      expect(addresses.length).toBeGreaterThanOrEqual(4);
      for (const addr of addresses) {
        expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(addr).not.toBe('0x0000000000000000000000000000000000000000');
      }
    });

    it('confirms the checked-in manifest file matches the soak provenance', () => {
      const manifestPath = resolve(
        __dirname,
        '../../contracts/manifests/optimism-sepolia.release.json',
      );
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

      expect(manifest.chainId).toBe(soakReport.provenance.chainId);
      expect(manifest.manifestChecksum).toBe(soakReport.provenance.manifestChecksum);
    });
  });

  describe('2. Required Workload Stages Execution', () => {
    it('executes all 6 required workload stages successfully', () => {
      const stageNames = soakReport.stages.map((s) => s.stage);
      expect(stageNames).toEqual([
        '1. Sustained Load',
        '2. Burst Workload',
        '3. Reconnect Storm',
        '4. Dependency Degradation',
        '5. Replay Catch-Up',
        '6. Restart & Recovery',
      ]);
    });

    it('records zero request failures across all soak stages', () => {
      for (const stage of soakReport.stages) {
        expect(stage.failureCount).toBe(0);
        expect(stage.successCount).toBe(stage.requestsCount);
        expect(stage.invariantsPassed).toBe(true);
      }
    });

    it('verifies sustained and burst latency boundaries', () => {
      const sustained = soakReport.stages.find((s) => s.stage.includes('Sustained'))!;
      const burst = soakReport.stages.find((s) => s.stage.includes('Burst'))!;

      expect(sustained.latencies.p95Ms).toBeLessThanOrEqual(100);
      expect(burst.latencies.p95Ms).toBeLessThanOrEqual(150);
      expect(burst.throughputRps).toBeGreaterThan(sustained.throughputRps);
    });
  });

  describe('3. Protocol Invariants: No-Gap, No-Duplicate, Fail-Closed Freshness', () => {
    it('proves zero sequence gaps across all processed block heights', () => {
      expect(soakReport.indexerLagEvidence.zeroGapVerified).toBe(true);
      expect(soakReport.indexerLagEvidence.blocksProcessed).toBe(200);
      expect(soakReport.indexerLagEvidence.finalBlock).toBe(24850199);
    });

    it('proves zero duplicate projections across all stages', () => {
      expect(soakReport.indexerLagEvidence.zeroDuplicateVerified).toBe(true);
    });

    it('verifies state projection digest matches canonical contract digest 100%', () => {
      expect(soakReport.recoveryProof.digestMatch).toBe(true);
      expect(soakReport.recoveryProof.finalDigest).toBe(
        soakReport.recoveryProof.canonicalContractDigest,
      );
      expect(soakReport.recoveryProof.finalDigest).toHaveLength(64);
    });
  });

  describe('4. Resource Envelope & Memory Stability', () => {
    it('confirms absence of memory leaks during sustained load', () => {
      expect(soakReport.resourceTelemetry.memoryLeakDetected).toBe(false);
      expect(soakReport.resourceTelemetry.finalMemoryMb).toBeLessThan(
        soakReport.resourceTelemetry.peakMemoryMb,
      );
    });

    it('keeps connection pool utilization within safe capacity', () => {
      expect(
        soakReport.resourceTelemetry.connectionPoolUtilizationPeakPct,
      ).toBeLessThan(80);
    });
  });

  describe('5. Operating Limits & Residual Risk Disclosures', () => {
    it('clearly disclaims observed limits are NOT guarantees or SLAs', () => {
      expect(soakReport.observedLimits.disclaimer).toContain(
        'MEASURED BOUNDARIES ONLY',
      );
      expect(soakReport.observedLimits.disclaimer).toContain(
        'NOT unconditional contractual guarantees or SLAs',
      );
    });

    it('explicitly enumerates residual risks and mitigations', () => {
      expect(soakReport.residualRisksAndBlockers.length).toBeGreaterThanOrEqual(3);
      const riskTitles = soakReport.residualRisksAndBlockers.map((r) => r.risk);
      expect(riskTitles.some((t) => t.includes('RPC'))).toBe(true);
      expect(riskTitles.some((t) => t.includes('reorg'))).toBe(true);

      for (const risk of soakReport.residualRisksAndBlockers) {
        expect(risk.mitigationOrBlocker.length).toBeGreaterThan(20);
        expect(['LOW', 'MEDIUM', 'HIGH']).toContain(risk.severity);
      }
    });
  });
});
