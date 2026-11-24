import { ExecutionContext, HttpException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AbuseSignalInterceptor } from './abuse-signal.interceptor';
import { AbuseSignalService } from './abuse-signal.service';
import {
  AbuseActionKind,
  AbuseObservationKind,
  AbuseSubjectKind,
} from './abuse-signals.types';
import {
  buildHarness,
  networkResolution,
  principalResolution,
  TEST_SALT,
} from './abuse-signals.harness';
import { FIXTURE_NOW, horizontalCrawler } from './fixtures/abuse-observations.fixtures';

function contextFor(req: Record<string, unknown>, res: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

const next = { handle: () => of('handled') };

async function seedAction(
  service: AbuseSignalService,
  store: ReturnType<typeof buildHarness>['store'],
  windowMs: number,
) {
  const resolution = principalResolution('principal-intercepted');
  for (const observation of horizontalCrawler()) {
    await store.record(
      resolution.subject.key,
      resolution.subject.kind,
      observation,
      windowMs,
      FIXTURE_NOW,
    );
  }
  const decision = await service.evaluate(resolution, FIXTURE_NOW);
  expect(decision.action).not.toBeNull();
  return { resolution, action: decision.action! };
}

describe('AbuseSignalInterceptor (PREWAVE-BE-086)', () => {
  it('passes every request through while enforcement is off', async () => {
    const harness = buildHarness();
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );
    await expect(
      new Promise<string>((resolve, reject) => {
        interceptor
          .intercept(
            contextFor({ originalUrl: '/claims/list', method: 'GET' }, {}),
            next,
          )
          .subscribe({ next: resolve, error: reject });
      }),
    ).resolves.toBe('handled');
  });

  it('never scores infrastructure routes', async () => {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    const record = jest.spyOn(harness.store, 'record');
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );

    for (const url of ['/health', '/metrics', '/status/public']) {
      await new Promise<void>((resolve) => {
        interceptor
          .intercept(contextFor({ originalUrl: url, method: 'GET' }, {}), next)
          .subscribe({ complete: resolve });
      });
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses with a uniform public denial and no heuristic detail', async () => {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    const { resolution, action } = await seedAction(
      harness.service,
      harness.store,
      harness.policy.windowMs,
    );
    // Escalate to a refusing action kind.
    harness.service.pinEscalation(resolution.subject.key, 99);
    const later = FIXTURE_NOW + harness.policy.windowMs + 1;
    for (const observation of horizontalCrawler(1_500, 90)) {
      await harness.store.record(
        resolution.subject.key,
        resolution.subject.kind,
        observation,
        harness.policy.windowMs,
        later,
      );
    }
    const escalated = await harness.service.evaluate(resolution, later);
    expect([AbuseActionKind.CHALLENGE, AbuseActionKind.SUSPEND]).toContain(
      escalated.action!.kind,
    );

    const headers: Record<string, string> = {};
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    };
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );

    let thrown: HttpException | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        interceptor
          .intercept(
            contextFor(
              {
                originalUrl: '/claims/list',
                method: 'GET',
                user: { sub: 'principal-intercepted' },
                socket: { remoteAddress: '198.51.100.7' },
              },
              res,
            ),
            next,
          )
          .subscribe({ next: resolve, error: reject });
      });
    } catch (error) {
      thrown = error as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const body = thrown!.getResponse() as Record<string, unknown>;
    expect(body).toEqual({
      statusCode: 429,
      errorCode: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
      retryAfterSeconds: expect.any(Number),
    });

    // No heuristic may appear anywhere in the response or headers.
    const exposed = JSON.stringify({ body, headers }).toLowerCase();
    for (const forbidden of [
      'scrape',
      'spam',
      'credential',
      'storm',
      'flood',
      'subject',
      'reason',
      'severity',
      'confidence',
      'threshold',
      action.id,
      resolution.subject.key,
    ]) {
      expect(exposed).not.toContain(forbidden);
    }
    expect(headers['Retry-After']).toEqual(
      String(body.retryAfterSeconds),
    );
  });

  it('denies when enforcement cannot prove an action is absent', async () => {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    jest
      .spyOn(harness.store, 'activeAction')
      .mockRejectedValue(new Error('store unavailable'));
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );

    await expect(
      new Promise<void>((resolve, reject) => {
        interceptor
          .intercept(
            contextFor(
              {
                originalUrl: '/claims/list',
                method: 'GET',
                user: { sub: 'principal-intercepted' },
              },
              {},
            ),
            next,
          )
          .subscribe({ next: () => resolve(), error: reject });
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('does not delay a response on a store failure while observing', async () => {
    const harness = buildHarness();
    jest
      .spyOn(harness.store, 'record')
      .mockRejectedValue(new Error('store unavailable'));
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );

    // The observable still emits the handler's value: observation failures are
    // dropped, never propagated.
    const emitted = await new Promise<string>((resolve, reject) => {
      interceptor
        .intercept(
          contextFor(
            {
              originalUrl: '/claims/list',
              method: 'GET',
              socket: { remoteAddress: '198.51.100.7' },
            },
            {},
          ),
          next,
        )
        .subscribe({ next: resolve, error: reject });
    });
    expect(emitted).toBe('handled');
  });

  it('records an observation without exposing the observation shape', async () => {
    const harness = buildHarness();
    const recorded: unknown[] = [];
    jest
      .spyOn(harness.store, 'record')
      .mockImplementation(async (key, kind, observation) => {
        recorded.push(observation);
        return {
          subjectKey: key,
          subjectKind: kind,
          windowStart: FIXTURE_NOW,
          windowMs: harness.policy.windowMs,
          total: 0,
          reads: 0,
          writes: 0,
          authFailures: 0,
          authSuccesses: 0,
          distinctRoutes: [],
          routeSaturationHit: false,
          distinctCredentials: [],
          credentialSaturationHit: false,
          duplicatePayloadCounts: new Map(),
          duplicatePayloadOverflow: 0,
          supportDuplicateCounts: new Map(),
          supportDuplicateRequests: 0,
          supportRequests: 0,
          supportContacts: [],
          supportContactSaturationHit: false,
          webhookEndpointWrites: 0,
          webhookSecretRotations: 0,
          webhookDeliveries: 0,
          streamConnect: 0,
          streamDisconnect: 0,
          streamSubscribeOps: 0,
          streamMessages: 0,
          subjectsPerCredential: new Map(),
        };
      });
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );

    await new Promise<void>((resolve) => {
      interceptor
        .intercept(
          contextFor(
            {
              originalUrl: '/claims/list',
              method: 'GET',
              socket: { remoteAddress: '198.51.100.7' },
            },
            {},
          ),
          next,
        )
        .subscribe({ complete: resolve });
    });
    // Fire-and-forget: give the pending promise a turn.
    await new Promise((resolve) => setImmediate(resolve));

    expect(recorded).toHaveLength(1);
    const observation = recorded[0] as Record<string, unknown>;
    expect(observation.kind).toBe(AbuseObservationKind.READ);
    expect(observation.routeGroup).toBe('claims/list');
    expect(JSON.stringify(observation)).not.toMatch(
      /authorization|cookie|user-?agent|ip/i,
    );
  });

  it('resolves anonymous subjects to a masked prefix, not a host', async () => {
    const harness = buildHarness();
    const resolutions: string[] = [];
    jest
      .spyOn(harness.service, 'observe')
      .mockImplementation(async (resolution) => {
        if (resolution.attributed) resolutions.push(resolution.subject.key);
        return {
          id: 'x',
          subjectKey: 'x',
          subjectKind: resolution.attributed
            ? resolution.subject.kind
            : AbuseSubjectKind.NETWORK_PREFIX,
          outcome: 'no_signal' as never,
          indeterminateReason: null,
          reasonCode: null,
          reasonCodeVersion: null,
          kind: null,
          severity: null,
          confidence: 0,
          sampleCount: 0,
          corroboratingDimensions: 0,
          modelVersion: 'abuse-model.v1',
          configVersion: 'abuse-config.v1',
          binding: null,
          action: null,
          decidedAt: new Date().toISOString(),
        };
      });
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );

    await new Promise<void>((resolve) => {
      interceptor
        .intercept(
          contextFor(
            {
              originalUrl: '/claims/list',
              method: 'GET',
              socket: { remoteAddress: '198.51.100.7' },
              headers: { 'x-wallet-address': '0x' + 'a'.repeat(40) },
            },
            {},
          ),
          next,
        )
        .subscribe({ complete: resolve });
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(resolutions[0]).not.toContain('198.51.100.7');
  });

  it('is a passthrough for a non-HTTP context', () => {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );
    const wsContext = {
      switchToHttp: () => ({ getRequest: () => undefined, getResponse: () => undefined }),
    } as unknown as ExecutionContext;
    expect(interceptor.intercept(wsContext, next)).toBeDefined();
  });

  it('records nothing when detection is disabled', async () => {
    const harness = buildHarness({ policy: { enabled: false } });
    const record = jest.spyOn(harness.store, 'record');
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );
    await new Promise<void>((resolve) => {
      interceptor
        .intercept(
          contextFor(
            { originalUrl: '/claims/list', method: 'GET', socket: { remoteAddress: '198.51.100.7' } },
            {},
          ),
          next,
        )
        .subscribe({ complete: resolve });
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(record).not.toHaveBeenCalled();
  });

  it('does not resolve an unattributable subject into an enforcement read', async () => {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    const enforcementFor = jest.spyOn(harness.service, 'enforcementFor');
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );

    await new Promise<void>((resolve) => {
      interceptor
        .intercept(
          // No salt configured, so nothing is attributable.
          contextFor({ originalUrl: '/claims/list', method: 'GET' }, {}),
          next,
        )
        .subscribe({ complete: resolve });
    });

    expect(enforcementFor).toHaveBeenCalledTimes(1);
    const resolution = enforcementFor.mock.calls[0][0];
    expect(resolution.attributed).toBe(false);
  });

  it('keeps the network subject coarse: two hosts, one budget', () => {
    const a = networkResolution('198.51.100.7');
    const b = networkResolution('198.51.100.8');
    expect(a.attributed && b.attributed).toBe(true);
    if (a.attributed && b.attributed) {
      expect(a.subject.key).toBe(b.subject.key);
      expect(a.subject.kind).toBe(AbuseSubjectKind.NETWORK_PREFIX);
    }
    expect(TEST_SALT.length).toBeGreaterThanOrEqual(32);
  });

  it('propagates a thrown error from the handler when nothing is enforced', async () => {
    const harness = buildHarness({ policy: { enforcementEnabled: true } });
    const interceptor = new AbuseSignalInterceptor(
      harness.service,
      harness.policy,
    );
    await expect(
      new Promise<void>((resolve, reject) => {
        interceptor
          .intercept(
            contextFor(
              {
                originalUrl: '/claims/list',
                method: 'GET',
                user: { sub: 'principal-clean' },
              },
              {},
            ),
            { handle: () => throwError(() => new Error('downstream failed')) },
          )
          .subscribe({ next: () => resolve(), error: reject });
      }),
    ).rejects.toThrow('downstream failed');
  });
});