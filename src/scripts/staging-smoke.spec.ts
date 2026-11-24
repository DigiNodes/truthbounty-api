import { runStagingSmoke, smokeProbes } from './staging-smoke';

const BASE_URL = 'https://staging.example.com';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

const defaultPayload = (overrides: Record<string, unknown> = {}) => ({
  status: 'healthy',
  ready: true,
  startupComplete: true,
  version: '0.0.1',
  dependencies: [],
  ...overrides,
});

let fetchMock: jest.Mock;

describe('staging smoke tests (V2-BE-146)', () => {
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation(async () =>
      jsonResponse(defaultPayload()),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes when every probe honours its health contract', async () => {
    const result = await runStagingSmoke({
      baseUrl: BASE_URL,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.probes).toHaveLength(smokeProbes.length);
    for (const probe of result.probes) {
      expect(probe.ok).toBe(true);
    }
    // Every canonical endpoint was actually exercised.
    for (const probe of smokeProbes) {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`${BASE_URL}${probe.path}`),
        expect.anything(),
      );
    }
  });

  it('normalizes a base URL with a trailing slash', async () => {
    const result = await runStagingSmoke({
      baseUrl: `${BASE_URL}/`,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain(`${BASE_URL}/health/live`);
  });

  it.each([
    ['no scheme', 'staging.example.com'],
    ['empty', ''],
    ['unsupported protocol', 'ftp://staging.example.com'],
  ])('fails closed on an invalid base URL (%s)', async (_, baseUrl) => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network failure');
    });
    const result = await runStagingSmoke({ baseUrl, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.probes.every((probe) => probe.ok === false)).toBe(true);
    expect(result.probes[0].message).toMatch(/invalid base URL/);
  });

  it('fails when liveness does not report "alive"', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/health/live')) {
        return jsonResponse({ status: 'dead' });
      }
      return jsonResponse(defaultPayload());
    });
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.probes.find((probe) => probe.name === 'liveness')?.ok).toBe(false);
  });

  it('fails when readiness is unavailable (HTTP 503)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/health/ready')) {
        return jsonResponse(
          { status: 'unhealthy', ready: false, dependencies: [] },
          503,
        );
      }
      return jsonResponse(defaultPayload());
    });
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(
      result.probes.find((probe) => probe.name === 'readiness')?.ok,
    ).toBe(false);
  });

  it('fails when aggregate health is unhealthy', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        return jsonResponse(
          defaultPayload({ status: 'unhealthy' }),
          503,
        );
      }
      return jsonResponse(defaultPayload());
    });
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
  });

  it('fails when the aggregate health payload has no version', async () => {
    fetchMock.mockImplementation(async () => {
      const payload = { ...defaultPayload(), version: undefined };
      return jsonResponse(payload);
    });
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
  });

  it('fails when a probe times out', async () => {
    // A fetch that never settles on its own but rejects when the probe's
    // AbortController fires, mirroring real network timeout semantics.
    fetchMock.mockImplementation(
      (_input: any, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const abortError = () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            return error;
          };
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          signal.addEventListener('abort', () => reject(abortError()), {
            once: true,
          });
        }),
    );
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.probes[0].message).toMatch(/timed out/);
  });

  it('fails when the endpoint returns invalid JSON', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('invalid json')),
    }));
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.probes.every((probe) => probe.ok === false)).toBe(true);
  });

  it('fails when the network is unreachable', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.probes[0].message).toMatch(/ECONNREFUSED/);
  });

  it('fails when indexer health is unhealthy even if the HTTP status is 200', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/health/indexer')) {
        return jsonResponse({ status: 'unhealthy' });
      }
      return jsonResponse(defaultPayload());
    });
    const result = await runStagingSmoke({ baseUrl: BASE_URL, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(
      result.probes.find((probe) => probe.name === 'indexer-health')?.ok,
    ).toBe(false);
  });
});
