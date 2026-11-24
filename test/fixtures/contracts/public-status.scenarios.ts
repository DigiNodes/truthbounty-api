/**
 * UX-BE-001 public status scenarios.
 *
 * Each scenario is a set of *protected* internal inputs. The published
 * frontend fixtures in docs/public-status/fixtures.json are the projector's
 * output for these inputs, and are verified by
 * src/health/public-status/public-status.artifacts.spec.ts.
 *
 * Inputs deliberately contain hostnames, credentials, stack traces and
 * diagnostics so that every fixture also proves redaction.
 */
import type { DependencyHealthResult } from '../../../src/health/health.types';
import type {
  FinalizedCursorStatus,
  ReleaseBinding,
} from '../../../src/indexer/finalized-cursor/finalized-cursor.types';
import type { PublicStatusInputs } from '../../../src/health/public-status/public-status.projector';

export const SCENARIO_NOW = new Date('2026-10-16T12:00:00.000Z');
const secondsAgo = (s: number) => new Date(SCENARIO_NOW.getTime() - s * 1000);

export const SCENARIO_POLICY = { staleAfterSeconds: 120, cacheTtlSeconds: 15 };

export const SCENARIO_RELEASE: ReleaseBinding = {
  chainId: 11155420,
  releaseId: 'v2.0.0-sepolia',
  deploymentBlock: 18450000n,
  artifactChecksum:
    '3f1c9a0b7e5d2c4f6a8b0d1e3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a',
};

/** Protected values that must never appear in any public projection. */
export const FORBIDDEN_SUBSTRINGS = [
  'db.internal.truthbounty',
  'postgres://',
  's3cr3t',
  'ipfs-node-7.cluster.local',
  'Error: connect ECONNREFUSED',
  'at Socket',
  'memoryUsage',
  'responseTimeMs',
  'failureReason',
  'critical',
  'rpc.internal',
];

function dependencies(
  overrides: Partial<
    Record<'database' | 'ipfs', 'healthy' | 'degraded' | 'unhealthy'>
  > = {},
  checkedSecondsAgo = 5,
): DependencyHealthResult {
  const make = (
    name: string,
    critical: boolean,
    status: 'healthy' | 'degraded' | 'unhealthy',
  ) => ({
    name,
    status,
    critical,
    responseTimeMs: 12,
    lastSuccessfulCheck: secondsAgo(60).toISOString(),
    ...(status === 'healthy'
      ? {}
      : {
          failureReason:
            name === 'database'
              ? 'Error: connect ECONNREFUSED postgres://admin:s3cr3t@db.internal.truthbounty:5432\n    at Socket.emit'
              : 'timeout talking to http://ipfs-node-7.cluster.local:5001',
          failureReasonCode: 'CONNECTION_ERROR' as const,
        }),
  });
  return {
    status: 'healthy',
    timestamp: SCENARIO_NOW.toISOString(),
    checkedAt: secondsAgo(checkedSecondsAgo).toISOString(),
    dependencies: [
      make('database', true, overrides.database ?? 'healthy'),
      make('redis', false, 'healthy'),
      make('queue', true, 'healthy'),
      make('ipfs', false, overrides.ipfs ?? 'healthy'),
      make('blockchain', true, 'healthy'),
    ],
  };
}

function cursor(
  overrides: Partial<FinalizedCursorStatus> = {},
): FinalizedCursorStatus {
  return {
    chainId: SCENARIO_RELEASE.chainId,
    releaseId: SCENARIO_RELEASE.releaseId,
    initialized: true,
    ready: true,
    reasons: [],
    observedHead: 18450120,
    safeHead: 18450110,
    finalizedHead: 18450100,
    indexedWatermark: 18450098,
    finalityLagBlocks: 20,
    indexLagBlocks: 2,
    headsObservedAt: secondsAgo(8).toISOString(),
    headAgeMs: 8000,
    watermarkUpdatedAt: secondsAgo(10).toISOString(),
    policy: { maxIndexLagBlocks: 150, maxHeadAgeMs: 120_000 },
    ...overrides,
  };
}

const web = { reachable: true, observedAt: secondsAgo(3) };

export const PUBLIC_STATUS_SCENARIOS: Record<string, PublicStatusInputs> = {
  allOperational: {
    now: SCENARIO_NOW,
    dependencies: dependencies(),
    cursor: cursor(),
    release: SCENARIO_RELEASE,
    web,
  },
  evidenceGatewayUnavailable: {
    now: SCENARIO_NOW,
    dependencies: dependencies({ ipfs: 'degraded' }),
    cursor: cursor(),
    release: SCENARIO_RELEASE,
    web,
  },
  databaseUnavailable: {
    now: SCENARIO_NOW,
    dependencies: dependencies({ database: 'unhealthy' }),
    cursor: cursor(),
    release: SCENARIO_RELEASE,
    web,
  },
  indexerDelayed: {
    now: SCENARIO_NOW,
    dependencies: dependencies(),
    cursor: cursor({
      ready: false,
      reasons: ['INDEX_LAG_EXCEEDED'],
      indexedWatermark: 18449800,
      indexLagBlocks: 300,
    }),
    release: SCENARIO_RELEASE,
    web,
  },
  chainDataStale: {
    now: SCENARIO_NOW,
    dependencies: dependencies(),
    cursor: cursor({
      ready: false,
      reasons: ['HEADS_STALE'],
      headsObservedAt: secondsAgo(900).toISOString(),
      headAgeMs: 900_000,
    }),
    release: SCENARIO_RELEASE,
    web,
  },
  wrongRelease: {
    now: SCENARIO_NOW,
    dependencies: dependencies(),
    cursor: cursor({ ready: false, reasons: ['WRONG_RELEASE'] }),
    release: SCENARIO_RELEASE,
    web,
  },
  notConfigured: {
    now: SCENARIO_NOW,
    dependencies: null,
    cursor: null,
    release: null,
    web: null,
  },
};
