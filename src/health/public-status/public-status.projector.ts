import type { DependencyHealthResult } from '../health.types';
import type {
  FinalizedCursorStatus,
  ReleaseBinding,
} from '../../indexer/finalized-cursor/finalized-cursor.types';
import {
  PUBLIC_STATUS_SCHEMA_VERSION,
  PublicChainProgressDto,
  PublicComponentId,
  PublicComponentStatusDto,
  PublicObservationDto,
  PublicObservationSource,
  PublicReleaseManifestDto,
  PublicStatusResponseDto,
  PublicStatusState,
} from './public-status.dto';

/** Internal (protected) inputs. Never returned directly. */
export interface PublicStatusInputs {
  now: Date;
  /** Protected dependency probe report; null when it could not be obtained. */
  dependencies: DependencyHealthResult | null;
  /** Finalized cursor status; null when not configured or unreadable. */
  cursor: FinalizedCursorStatus | null;
  /** Configured release binding; null when not configured. */
  release: ReleaseBinding | null;
  /** Web frontend probe; null when no probe is configured or it was not run. */
  web: { reachable: boolean; observedAt: Date } | null;
}

export interface PublicStatusPolicy {
  /** Observations older than this are reported as `stale`. */
  staleAfterSeconds: number;
  /** How long a projection may be cached by the server and clients. */
  cacheTtlSeconds: number;
}

/** Severity order used to compute `overall`; higher is worse. */
const SEVERITY: Record<PublicStatusState, number> = {
  operational: 0,
  degraded: 1,
  delayed: 2,
  stale: 3,
  unknown: 4,
  unavailable: 5,
};

/** Maps a protected dependency name to the public component it backs. */
const DEPENDENCY_COMPONENTS: Partial<Record<PublicComponentId, string>> = {
  database: 'database',
  evidence_gateway: 'ipfs',
};

function observe(
  source: PublicObservationSource,
  observedAt: Date | string | null,
  now: Date,
  staleAfterSeconds: number,
): PublicObservationDto {
  if (source === 'not_observed' || observedAt === null) {
    return { source, observedAt: null, ageSeconds: null, freshness: 'unknown' };
  }
  const at = new Date(observedAt);
  if (Number.isNaN(at.getTime())) {
    return { source, observedAt: null, ageSeconds: null, freshness: 'unknown' };
  }
  const ageSeconds = Math.max(
    0,
    Math.floor((now.getTime() - at.getTime()) / 1000),
  );
  return {
    source,
    observedAt: at.toISOString(),
    ageSeconds,
    freshness: ageSeconds > staleAfterSeconds ? 'stale' : 'fresh',
  };
}

/** Missing data is `unknown`, old data is `stale`; neither is ever operational. */
function applyFreshness(
  state: PublicStatusState,
  observation: PublicObservationDto,
): PublicStatusState {
  if (observation.freshness === 'unknown') return 'unknown';
  if (observation.freshness === 'stale') return 'stale';
  return state;
}

const NOT_OBSERVED = (now: Date): PublicObservationDto =>
  observe('not_observed', null, now, 0);

function dependencyComponent(
  id: PublicComponentId,
  dependencyName: string,
  inputs: PublicStatusInputs,
  policy: PublicStatusPolicy,
): PublicComponentStatusDto {
  const report = inputs.dependencies;
  const probe = report?.dependencies.find((d) => d.name === dependencyName);
  if (!report || !probe) {
    return { id, state: 'unknown', observation: NOT_OBSERVED(inputs.now) };
  }
  const observation = observe(
    'dependency_probe',
    report.checkedAt,
    inputs.now,
    policy.staleAfterSeconds,
  );
  // Any failed probe is unavailable to the public, whatever its criticality.
  const state: PublicStatusState =
    probe.status === 'healthy' ? 'operational' : 'unavailable';
  return { id, state: applyFreshness(state, observation), observation };
}

function cursorObservation(
  inputs: PublicStatusInputs,
  policy: PublicStatusPolicy,
): PublicObservationDto {
  const cursor = inputs.cursor;
  if (!cursor || !cursor.initialized) return NOT_OBSERVED(inputs.now);
  return observe(
    'finalized_cursor',
    cursor.headsObservedAt,
    inputs.now,
    policy.staleAfterSeconds,
  );
}

function indexerState(cursor: FinalizedCursorStatus | null): PublicStatusState {
  if (!cursor || !cursor.initialized) return 'unknown';
  if (cursor.reasons.includes('WRONG_RELEASE')) return 'unavailable';
  if (cursor.reasons.includes('HEADS_NEVER_OBSERVED')) return 'unknown';
  if (cursor.reasons.includes('INDEX_LAG_EXCEEDED')) return 'delayed';
  return 'operational';
}

function buildComponents(
  inputs: PublicStatusInputs,
  policy: PublicStatusPolicy,
): PublicComponentStatusDto[] {
  const { now } = inputs;

  const web: PublicComponentStatusDto = inputs.web
    ? (() => {
        const observation = observe(
          'web_probe',
          inputs.web.observedAt,
          now,
          policy.staleAfterSeconds,
        );
        const state: PublicStatusState = inputs.web.reachable
          ? 'operational'
          : 'unavailable';
        return {
          id: 'web',
          state: applyFreshness(state, observation),
          observation,
        };
      })()
    : { id: 'web', state: 'unknown', observation: NOT_OBSERVED(now) };

  // The API is answering this request, so it is observed now.
  const api: PublicComponentStatusDto = {
    id: 'api',
    state: 'operational',
    observation: observe('api_self', now, now, policy.staleAfterSeconds),
  };

  const headsObservation = cursorObservation(inputs, policy);
  const rpc: PublicComponentStatusDto = {
    id: 'rpc',
    state: applyFreshness('operational', headsObservation),
    observation: headsObservation,
  };

  const derived = indexerState(inputs.cursor);
  const indexer: PublicComponentStatusDto = {
    id: 'indexer',
    // A wrong-release cursor is unavailable regardless of how fresh it is.
    state:
      derived === 'unavailable'
        ? derived
        : applyFreshness(derived, headsObservation),
    observation: headsObservation,
  };

  return [
    web,
    api,
    rpc,
    indexer,
    dependencyComponent(
      'database',
      DEPENDENCY_COMPONENTS.database!,
      inputs,
      policy,
    ),
    dependencyComponent(
      'evidence_gateway',
      DEPENDENCY_COMPONENTS.evidence_gateway!,
      inputs,
      policy,
    ),
  ];
}

function buildRelease(
  inputs: PublicStatusInputs,
  policy: PublicStatusPolicy,
): PublicReleaseManifestDto {
  const release = inputs.release;
  if (!release) {
    return {
      releaseId: null,
      chainId: null,
      deploymentBlock: null,
      artifactChecksum: null,
      state: 'unknown',
      observation: NOT_OBSERVED(inputs.now),
    };
  }
  const deploymentBlock = Number(release.deploymentBlock);
  return {
    releaseId: release.releaseId,
    chainId: release.chainId,
    deploymentBlock: Number.isSafeInteger(deploymentBlock)
      ? deploymentBlock
      : null,
    artifactChecksum: release.artifactChecksum,
    state: 'operational',
    observation: observe(
      'release_config',
      inputs.now,
      inputs.now,
      policy.staleAfterSeconds,
    ),
  };
}

function buildChain(
  inputs: PublicStatusInputs,
  policy: PublicStatusPolicy,
  indexer: PublicComponentStatusDto,
): PublicChainProgressDto {
  const cursor = inputs.cursor;
  // Numbers from a missing or wrong-release cursor are never published.
  const publishable =
    !!cursor && cursor.initialized && !cursor.reasons.includes('WRONG_RELEASE');
  return {
    finalizedBlock: publishable ? cursor.finalizedHead : null,
    indexedBlock: publishable ? cursor.indexedWatermark : null,
    lagBlocks: publishable ? cursor.indexLagBlocks : null,
    state: indexer.state,
    observation: cursorObservation(inputs, policy),
  };
}

/**
 * Builds the public projection from protected inputs. Output is assembled
 * field-by-field from the allow-listed DTOs; nothing from the inputs is
 * spread or passed through, so hostnames, failure messages, stack traces,
 * diagnostics and secrets cannot leak.
 */
export function projectPublicStatus(
  inputs: PublicStatusInputs,
  policy: PublicStatusPolicy,
): PublicStatusResponseDto {
  const components = buildComponents(inputs, policy);
  const release = buildRelease(inputs, policy);
  const chain = buildChain(
    inputs,
    policy,
    components.find((c) => c.id === 'indexer')!,
  );

  const overall = [
    ...components.map((c) => c.state),
    release.state,
    chain.state,
  ].reduce<PublicStatusState>(
    (worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst),
    'operational',
  );

  return {
    schemaVersion: PUBLIC_STATUS_SCHEMA_VERSION,
    generatedAt: inputs.now.toISOString(),
    overall,
    components,
    release,
    chain,
    cache: {
      maxAgeSeconds: policy.cacheTtlSeconds,
      staleAfterSeconds: policy.staleAfterSeconds,
      expiresAt: new Date(
        inputs.now.getTime() + policy.cacheTtlSeconds * 1000,
      ).toISOString(),
    },
  };
}
