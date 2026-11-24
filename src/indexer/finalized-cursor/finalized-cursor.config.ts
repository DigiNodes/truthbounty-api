import { getRuntimeEnvironment } from '../../config/runtime-config';
import { FreshnessPolicy, ReleaseBinding } from './finalized-cursor.types';

export const FINALIZED_CURSOR_CONFIG = Symbol('FINALIZED_CURSOR_CONFIG');

export interface FinalizedCursorConfig {
  /** null when no release binding is configured for this deployment. */
  binding: ReleaseBinding | null;
  policy: FreshnessPolicy;
}

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  maxIndexLagBlocks: 150,
  maxHeadAgeMs: 120_000,
};

/** Throws when a binding is malformed; never echoes the offending value. */
export function assertValidBinding(binding: ReleaseBinding): void {
  if (!Number.isSafeInteger(binding.chainId) || binding.chainId <= 0) {
    throw new Error('INVALID_BINDING: chainId must be a positive integer');
  }
  if (!RELEASE_ID_PATTERN.test(binding.releaseId)) {
    throw new Error(
      'INVALID_BINDING: releaseId must be 1-64 chars of [A-Za-z0-9._-]',
    );
  }
  if (binding.deploymentBlock < 0n) {
    throw new Error('INVALID_BINDING: deploymentBlock must be >= 0');
  }
  if (!CHECKSUM_PATTERN.test(binding.artifactChecksum)) {
    throw new Error(
      'INVALID_BINDING: artifactChecksum must be 64 lowercase hex chars',
    );
  }
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * Reads the release binding and freshness policy from the environment.
 *
 * The binding is all-or-nothing: if any of INDEXER_RELEASE_ID,
 * INDEXER_DEPLOYMENT_BLOCK or INDEXER_ARTIFACT_CHECKSUM is set, all of them
 * (plus BLOCKCHAIN_CHAIN_ID) must be valid, otherwise startup fails closed.
 */
export function loadFinalizedCursorConfig(
  env: NodeJS.ProcessEnv = getRuntimeEnvironment(),
): FinalizedCursorConfig {
  const policy: FreshnessPolicy = {
    maxIndexLagBlocks: parseNonNegativeInt(
      env.INDEXER_MAX_FINALIZED_LAG_BLOCKS,
      DEFAULT_FRESHNESS_POLICY.maxIndexLagBlocks,
      'INDEXER_MAX_FINALIZED_LAG_BLOCKS',
    ),
    maxHeadAgeMs:
      parseNonNegativeInt(
        env.INDEXER_MAX_HEAD_AGE_SECONDS,
        DEFAULT_FRESHNESS_POLICY.maxHeadAgeMs / 1000,
        'INDEXER_MAX_HEAD_AGE_SECONDS',
      ) * 1000,
  };

  const releaseId = env.INDEXER_RELEASE_ID;
  const deploymentBlock = env.INDEXER_DEPLOYMENT_BLOCK;
  const artifactChecksum = env.INDEXER_ARTIFACT_CHECKSUM;
  if (!releaseId && !deploymentBlock && !artifactChecksum) {
    return { binding: null, policy };
  }
  if (!releaseId || !deploymentBlock || !artifactChecksum) {
    throw new Error(
      'INVALID_BINDING: INDEXER_RELEASE_ID, INDEXER_DEPLOYMENT_BLOCK and INDEXER_ARTIFACT_CHECKSUM must be set together',
    );
  }
  if (!/^\d+$/.test(deploymentBlock)) {
    throw new Error(
      'INVALID_BINDING: INDEXER_DEPLOYMENT_BLOCK must be an integer',
    );
  }

  const binding: ReleaseBinding = {
    chainId: Number(env.BLOCKCHAIN_CHAIN_ID ?? ''),
    releaseId,
    deploymentBlock: BigInt(deploymentBlock),
    artifactChecksum: artifactChecksum.toLowerCase(),
  };
  assertValidBinding(binding);
  return { binding, policy };
}
