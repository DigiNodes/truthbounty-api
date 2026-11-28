import { AnalyticsConsentService } from './analytics-consent.service';
import { AnalyticsService } from './analytics.service';
import { CURRENT_CONSENT_POLICY_VERSION } from './analytics.schemas';
import { AnalyticsConsentRecord } from './analytics.types';

describe('AnalyticsService consent & minimization', () => {
  let consent: {
    get: jest.Mock<Promise<AnalyticsConsentRecord>, [string]>;
    getSubjectKey: jest.Mock<string, [string]>;
    setDoNotTrack: jest.Mock<
      Promise<AnalyticsConsentRecord>,
      [string, boolean]
    >;
    collectIfValid: jest.Mock;
  };
  let analytics: AnalyticsService;
  const record = (
    overrides: Partial<AnalyticsConsentRecord> = {},
  ): AnalyticsConsentRecord => ({
    status: 'none',
    policyVersion: CURRENT_CONSENT_POLICY_VERSION,
    grantedAt: null,
    withdrawnAt: null,
    doNotTrack: false,
    ...overrides,
  });

  beforeEach(() => {
    consent = {
      get: jest.fn().mockResolvedValue(record()),
      getSubjectKey: jest.fn().mockReturnValue('a'.repeat(64)),
      setDoNotTrack: jest.fn().mockResolvedValue(record({ doNotTrack: true })),
      collectIfValid: jest.fn(
        async (subjectId: string, collect: (tx: never) => Promise<unknown>) => {
          const current = await consent.get(subjectId);
          if (current.doNotTrack)
            return { allowed: false, reason: 'dnt' as const };
          if (current.status === 'withdrawn')
            return { allowed: false, reason: 'withdrawn' as const };
          if (
            current.status !== 'granted' ||
            current.policyVersion !== CURRENT_CONSENT_POLICY_VERSION
          )
            return { allowed: false, reason: 'no_consent' as const };
          return {
            allowed: true,
            value: await collect({} as never),
          };
        },
      ),
    };
    analytics = new AnalyticsService(
      consent as unknown as AnalyticsConsentService,
    );
  });

  it('does not emit without durable consent', async () => {
    const result = await analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web' },
    });

    expect(result).toEqual({ ok: false, reason: 'no_consent' });
    expect(analytics.getSink()).toHaveLength(0);
  });

  it('emits minimized data after current-policy consent and pseudonymizes subject', async () => {
    consent.get.mockResolvedValue(
      record({
        status: 'granted',
        grantedAt: new Date().toISOString(),
      }),
    );
    consent.collectIfValid.mockImplementationOnce(
      async (subjectId: string, collect: (tx: never) => Promise<unknown>) => {
        const current = await consent.get(subjectId);
        if (current.status !== 'granted') {
          return { allowed: false, reason: 'no_consent' as const };
        }
        const value = await collect({} as never);
        expect(analytics.getSink()).toContain(value);
        return { allowed: true, value };
      },
    );
    const result = await analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'raw-user-id',
      properties: { surface: 'web', locale: 'en', extra: 'drop-me' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.properties).toEqual({ surface: 'web', locale: 'en' });
      expect(result.event.properties).not.toHaveProperty('extra');
      expect(result.event.subjectKey).toBe('a'.repeat(64));
      expect(JSON.stringify(result.event)).not.toContain('raw-user-id');
    }
  });

  it('removes a captured event if the consent transaction fails', async () => {
    consent.get.mockResolvedValue(record({ status: 'granted' }));
    consent.collectIfValid.mockImplementationOnce(
      async (_subjectId: string, collect: (tx: never) => Promise<unknown>) => {
        await collect({} as never);
        throw new Error('transaction commit failed');
      },
    );

    await expect(
      analytics.emit({
        name: 'app_opened',
        schemaVersion: 1,
        subjectId: 'user-1',
      }),
    ).rejects.toThrow('transaction commit failed');
    expect(analytics.getSink()).toHaveLength(0);
  });

  it('blocks withdrawn and stale-policy consent', async () => {
    consent.get.mockResolvedValue(
      record({
        status: 'withdrawn',
        withdrawnAt: new Date().toISOString(),
      }),
    );
    expect(
      await analytics.emit({
        name: 'app_opened',
        schemaVersion: 1,
        subjectId: 'user-1',
      }),
    ).toEqual({ ok: false, reason: 'withdrawn' });

    consent.get.mockResolvedValue(
      record({ status: 'granted', policyVersion: 'stale-policy' }),
    );
    expect(
      await analytics.emit({
        name: 'app_opened',
        schemaVersion: 1,
        subjectId: 'user-1',
      }),
    ).toEqual({ ok: false, reason: 'no_consent' });
  });

  it('persists DNT before rejecting the event', async () => {
    const result = await analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      doNotTrack: true,
    });

    expect(result).toEqual({ ok: false, reason: 'dnt' });
    expect(consent.setDoNotTrack).toHaveBeenCalledWith('user-1', true);
    expect(analytics.getSink()).toHaveLength(0);
  });

  it('blocks collection when the durable consent lookup fails', async () => {
    consent.collectIfValid.mockRejectedValue(new Error('database unavailable'));

    await expect(
      analytics.emit({
        name: 'app_opened',
        schemaVersion: 1,
        subjectId: 'user-1',
      }),
    ).rejects.toThrow('database unavailable');
    expect(analytics.getSink()).toHaveLength(0);
  });

  it('rejects wallet, signature, and evidence fields', async () => {
    consent.get.mockResolvedValue(record({ status: 'granted' }));
    const result = await analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web', wallet: 'G...', signature: '0xab' },
    });

    expect(result).toEqual({ ok: false, reason: 'forbidden_field' });
    expect(analytics.getSink()).toHaveLength(0);
  });

  it('rejects unknown events and schema versions', async () => {
    consent.get.mockResolvedValue(record({ status: 'granted' }));
    expect(
      await analytics.emit({
        name: 'not_a_real_event',
        schemaVersion: 1,
        subjectId: 'user-1',
      }),
    ).toEqual({ ok: false, reason: 'unknown_event' });
    expect(
      await analytics.emit({
        name: 'app_opened',
        schemaVersion: 99,
        subjectId: 'user-1',
      }),
    ).toEqual({ ok: false, reason: 'schema_mismatch' });
  });
});
