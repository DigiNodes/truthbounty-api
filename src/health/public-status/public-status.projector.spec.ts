import {
  FORBIDDEN_SUBSTRINGS,
  PUBLIC_STATUS_SCENARIOS,
  SCENARIO_NOW,
  SCENARIO_POLICY,
} from '../../../test/fixtures/contracts/public-status.scenarios';
import {
  PUBLIC_COMPONENT_IDS,
  PUBLIC_STATUS_SCHEMA_VERSION,
  PublicStatusResponseDto,
} from './public-status.dto';
import { projectPublicStatus } from './public-status.projector';

const project = (name: keyof typeof PUBLIC_STATUS_SCENARIOS) =>
  projectPublicStatus(PUBLIC_STATUS_SCENARIOS[name], SCENARIO_POLICY);

const component = (body: PublicStatusResponseDto, id: string) =>
  body.components.find((c) => c.id === id)!;

/** Collects every key path in a JSON value, with array indices collapsed. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      `${prefix}.${k}`,
      ...keyPaths(v, `${prefix}.${k}`),
    ]);
  }
  return [];
}

const ALLOWED_KEY_PATHS = new Set([
  '.schemaVersion',
  '.generatedAt',
  '.overall',
  '.components',
  '.components[].id',
  '.components[].state',
  '.components[].observation',
  '.components[].observation.source',
  '.components[].observation.observedAt',
  '.components[].observation.ageSeconds',
  '.components[].observation.freshness',
  '.release',
  '.release.releaseId',
  '.release.chainId',
  '.release.deploymentBlock',
  '.release.artifactChecksum',
  '.release.state',
  '.release.observation',
  '.release.observation.source',
  '.release.observation.observedAt',
  '.release.observation.ageSeconds',
  '.release.observation.freshness',
  '.chain',
  '.chain.finalizedBlock',
  '.chain.indexedBlock',
  '.chain.lagBlocks',
  '.chain.state',
  '.chain.observation',
  '.chain.observation.source',
  '.chain.observation.observedAt',
  '.chain.observation.ageSeconds',
  '.chain.observation.freshness',
  '.cache',
  '.cache.maxAgeSeconds',
  '.cache.staleAfterSeconds',
  '.cache.expiresAt',
]);

describe('projectPublicStatus (UX-BE-001)', () => {
  describe.each(Object.keys(PUBLIC_STATUS_SCENARIOS))('scenario %s', (name) => {
    const body = project(name);
    const json = JSON.stringify(body);

    it('emits only allow-listed fields', () => {
      for (const path of keyPaths(JSON.parse(json))) {
        expect(ALLOWED_KEY_PATHS).toContain(path);
      }
    });

    it('redacts hostnames, secrets, stack traces and protected diagnostics', () => {
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(json).not.toContain(forbidden);
      }
    });

    it('reports every component, each with a source and freshness', () => {
      expect(body.schemaVersion).toBe(PUBLIC_STATUS_SCHEMA_VERSION);
      expect(body.components.map((c) => c.id)).toEqual([
        ...PUBLIC_COMPONENT_IDS,
      ]);
      for (const obs of [
        ...body.components.map((c) => c.observation),
        body.release.observation,
        body.chain.observation,
      ]) {
        expect(obs.source).toBeTruthy();
        expect(['fresh', 'stale', 'unknown']).toContain(obs.freshness);
        if (obs.freshness === 'unknown') {
          expect(obs.observedAt).toBeNull();
        } else {
          expect(obs.observedAt).not.toBeNull();
          expect(obs.ageSeconds).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('never reports operational for missing or stale data', () => {
      for (const item of [...body.components, body.release, body.chain]) {
        if (item.observation.freshness !== 'fresh') {
          expect(item.state).not.toBe('operational');
        }
      }
    });
  });

  it('is fully operational only when every observation is present and fresh', () => {
    const body = project('allOperational');
    expect(body.overall).toBe('operational');
    expect(body.chain).toMatchObject({
      finalizedBlock: 18450100,
      indexedBlock: 18450098,
      lagBlocks: 2,
      state: 'operational',
    });
    expect(body.release.releaseId).toBe('v2.0.0-sepolia');
    expect(body.cache).toEqual({
      maxAgeSeconds: 15,
      staleAfterSeconds: 120,
      expiresAt: new Date(SCENARIO_NOW.getTime() + 15_000).toISOString(),
    });
  });

  it('marks any failed probe unavailable regardless of internal criticality', () => {
    expect(
      component(project('evidenceGatewayUnavailable'), 'evidence_gateway')
        .state,
    ).toBe('unavailable');
    const db = project('databaseUnavailable');
    expect(component(db, 'database').state).toBe('unavailable');
    expect(db.overall).toBe('unavailable');
  });

  it('reports indexer lag beyond policy as delayed', () => {
    const body = project('indexerDelayed');
    expect(component(body, 'indexer').state).toBe('delayed');
    expect(body.chain).toMatchObject({ state: 'delayed', lagBlocks: 300 });
    expect(body.overall).toBe('delayed');
  });

  it('reports old chain observations as stale', () => {
    const body = project('chainDataStale');
    expect(component(body, 'rpc').state).toBe('stale');
    expect(component(body, 'indexer').state).toBe('stale');
    expect(body.chain.state).toBe('stale');
    expect(body.chain.observation).toMatchObject({
      freshness: 'stale',
      ageSeconds: 900,
    });
  });

  it('never publishes block numbers from a wrong-release cursor', () => {
    const body = project('wrongRelease');
    expect(body.chain).toMatchObject({
      finalizedBlock: null,
      indexedBlock: null,
      lagBlocks: null,
      state: 'unavailable',
    });
    expect(component(body, 'indexer').state).toBe('unavailable');
  });

  it('reports everything unknown, never healthy, when nothing is observed', () => {
    const body = project('notConfigured');
    expect(body.overall).toBe('unknown');
    for (const c of body.components.filter((c) => c.id !== 'api')) {
      expect(c.state).toBe('unknown');
      expect(c.observation.source).toBe('not_observed');
    }
    expect(body.release.state).toBe('unknown');
    expect(body.chain.state).toBe('unknown');
  });
});
