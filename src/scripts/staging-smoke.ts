import { performance } from 'perf_hooks';

/**
 * Staging deployment smoke tests (V2-BE-146).
 *
 * Probes the public health endpoints of a deployed TruthBounty API instance and
 * fails closed on any uncertainty: non-2xx responses, malformed payloads,
 * missing fields, unhealthy aggregate status, or timeouts are all hard failures.
 *
 * Pure TypeORM/Node — it deliberately uses only the global `fetch` and never
 * touches Prisma, so the staging gate cannot drift from the persistence layer
 * it is validating. No secrets, credentials, or production values are read.
 */

export interface SmokeProbe {
  name: string;
  path: string;
  expectStatus: number;
  validate: (payload: unknown, status: number) => void;
}

export interface SmokeOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface SmokeProbeResult {
  name: string;
  path: string;
  status: number;
  ok: boolean;
  message?: string;
}

export interface SmokeResult {
  ok: boolean;
  baseUrl: string;
  probes: SmokeProbeResult[];
  durationMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isHealthStatus = (value: unknown): boolean =>
  value === 'healthy' || value === 'degraded' || value === 'unhealthy';

const expectStatus = (actual: number, expected: number, label: string): void => {
  if (actual !== expected) {
    throw new Error(`${label} returned HTTP ${actual}; expected ${expected}`);
  }
};

const expectHealthy = (status: unknown, label: string): void => {
  if (!isHealthStatus(status)) {
    throw new Error(`${label} missing a health status`);
  }
  if (status === 'unhealthy') {
    throw new Error(`${label} is unhealthy`);
  }
};

/**
 * Default probe suite against the deployment's public health surface. Each
 * probe validates both the HTTP status code and the minimal payload contract
 * the deployment must honour (V2-BE-044 fail-closed gates rely on these).
 */
export const smokeProbes: SmokeProbe[] = [
  {
    name: 'liveness',
    path: '/health/live',
    expectStatus: 200,
    validate: (payload, status) => {
      expectStatus(status, 200, 'liveness');
      if (!isRecord(payload) || payload.status !== 'alive') {
        throw new Error('liveness payload has no status "alive"');
      }
    },
  },
  {
    name: 'readiness',
    path: '/health/ready',
    expectStatus: 200,
    validate: (payload, status) => {
      if (status !== 200) {
        throw new Error('readiness reports a dependency as unavailable');
      }
      if (!isRecord(payload) || payload.ready !== true) {
        throw new Error('readiness payload does not report ready=true');
      }
    },
  },
  {
    name: 'startup-complete',
    path: '/health/startup',
    expectStatus: 200,
    validate: (payload, status) => {
      if (status !== 200) {
        throw new Error('startup has not completed successfully');
      }
      if (!isRecord(payload) || payload.startupComplete !== true) {
        throw new Error('startup payload does not report startupComplete=true');
      }
    },
  },
  {
    name: 'aggregate-health',
    path: '/health',
    expectStatus: 200,
    validate: (payload, status) => {
      if (status !== 200) {
        throw new Error('aggregate health is unhealthy');
      }
      if (!isRecord(payload)) {
        throw new Error('aggregate health returned a non-object payload');
      }
      expectHealthy(payload.status, 'aggregate health');
      if (typeof payload.version !== 'string' || payload.version.length === 0) {
        throw new Error('aggregate health is missing a deployment version');
      }
    },
  },
  {
    name: 'dependency-report',
    path: '/health/dependencies',
    expectStatus: 200,
    validate: (payload, status) => {
      expectStatus(status, 200, 'dependency report');
      if (!isRecord(payload)) {
        throw new Error('dependency report returned a non-object payload');
      }
      expectHealthy(payload.status, 'dependency report');
      if (!Array.isArray(payload.dependencies)) {
        throw new Error('dependency report is missing the dependency list');
      }
    },
  },
  {
    name: 'indexer-health',
    path: '/health/indexer',
    expectStatus: 200,
    validate: (payload, status) => {
      if (!isRecord(payload)) {
        throw new Error('indexer health returned a non-object payload');
      }
      if (payload.status === 'unhealthy') {
        throw new Error('indexer health is unhealthy');
      }
      if (status !== 200 && payload.status === 'degraded') {
        throw new Error('indexer health is degraded');
      }
    },
  },
];

const buildUrl = (baseUrl: string, path: string): string => {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('invalid base URL - URL is empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `invalid base URL - must start with http(s)://, got: '${baseUrl}'`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `invalid base URL - must start with http(s)://, got: '${baseUrl}'`,
    );
  }
  return `${parsed.origin}${path}`;
};

const runProbe = async (
  probe: SmokeProbe,
  baseUrl: string,
  timeoutMs: number,
): Promise<SmokeProbeResult> => {
  const path = probe.path;
  let url: string;
  try {
    url = buildUrl(baseUrl, path);
  } catch (error) {
    return {
      name: probe.name,
      path,
      status: 0,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const payload: unknown = await response.json().catch(() => null);
    try {
      probe.validate(payload, response.status);
      return { name: probe.name, path, status: response.status, ok: true };
    } catch (error) {
      return {
        name: probe.name,
        path,
        status: response.status,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? `probe timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { name: probe.name, path, status: 0, ok: false, message: reason };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Run the full staging smoke suite. Resolves with `ok: true` only if every
 * probe passed; otherwise the individual probe results carry actionable
 * diagnostics and `ok` is `false` (no silent fallback to fabricated state).
 */
export const runStagingSmoke = async (
  options: SmokeOptions,
): Promise<SmokeResult> => {
  const baseUrl = options.baseUrl.trim();
  const start = performance.now();
  const probes = await Promise.all(
    smokeProbes.map((probe) => runProbe(probe, baseUrl, options.timeoutMs)),
  );
  return {
    ok: probes.every((probe) => probe.ok),
    baseUrl,
    probes,
    durationMs: performance.now() - start,
  };
};

const main = async (): Promise<void> => {
  try {
    const baseUrl = process.env.STAGING_BASE_URL ?? '';
    const timeoutMs = parseInt(process.env.SMOKE_TIMEOUT_MS ?? '10000', 10) || 10000;
    if (!baseUrl) {
      throw new Error('STAGING_BASE_URL must be set to the deployed instance URL');
    }
    const result = await runStagingSmoke({ baseUrl, timeoutMs });
    for (const probe of result.probes) {
      const marker = probe.ok ? 'PASS' : 'FAIL';
      const detail = probe.message ? ` — ${probe.message}` : '';
      process.stdout.write(`[${marker}] ${probe.name} (${probe.path}) HTTP ${probe.status}${detail}\n`);
    }
    if (!result.ok) {
      throw new Error('staging smoke tests failed: see individual probe results above');
    }
    process.stdout.write(`staging smoke tests passed in ${result.durationMs.toFixed(0)}ms\n`);
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`STAGING_SMOKE_FAILED: ${message}\n`);
    process.exitCode = 1;
  }
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require.main === module) {
  void main();
}
