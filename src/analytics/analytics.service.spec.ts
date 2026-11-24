import { AnalyticsConsentService } from './analytics-consent.service';
import { AnalyticsService } from './analytics.service';
import { CURRENT_CONSENT_POLICY_VERSION } from './analytics.schemas';

describe('AnalyticsService consent & minimization (#669)', () => {
  let consent: AnalyticsConsentService;
  let analytics: AnalyticsService;

  beforeEach(() => {
    consent = new AnalyticsConsentService();
    analytics = new AnalyticsService(consent);
  });

  it('does not emit without consent', () => {
    const r = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_consent');
    expect(analytics.getSink()).toHaveLength(0);
  });

  it('emits after grant with minimized payload', () => {
    consent.grant('user-1');
    const r = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web', locale: 'en', extra: 'drop-me' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.properties).toEqual({ surface: 'web', locale: 'en' });
      expect(r.event.properties).not.toHaveProperty('extra');
    }
  });

  it('withdrawal stops future collection', () => {
    consent.grant('user-1');
    expect(
      analytics.emit({
        name: 'app_opened',
        schemaVersion: 1,
        subjectId: 'user-1',
        properties: { surface: 'web' },
      }).ok,
    ).toBe(true);
    consent.withdraw('user-1');
    const r = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('withdrawn');
  });

  it('renewed policy version is required for valid consent', () => {
    consent.grant('user-1', '2020-01-01');
    const blocked = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web' },
    });
    expect(blocked.ok).toBe(false);
    consent.renew('user-1', CURRENT_CONSENT_POLICY_VERSION);
    const ok = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web' },
    });
    expect(ok.ok).toBe(true);
  });

  it('DNT blocks emission', () => {
    consent.grant('user-1');
    const r = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web' },
      doNotTrack: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dnt');
  });

  it('wallet rotation clears consent (fail closed)', () => {
    consent.grant('wallet-old');
    consent.rotateSubject('wallet-old', 'wallet-new');
    expect(
      analytics.emit({
        name: 'app_opened',
        schemaVersion: 1,
        subjectId: 'wallet-old',
        properties: { surface: 'web' },
      }).ok,
    ).toBe(false);
    expect(
      analytics.emit({
        name: 'app_opened',
        schemaVersion: 1,
        subjectId: 'wallet-new',
        properties: { surface: 'web' },
      }).ok,
    ).toBe(false);
  });

  it('deletion removes consent and stops collection', () => {
    consent.grant('user-1');
    consent.deleteSubject('user-1');
    const r = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_consent');
  });

  it('rejects wallet/signature/evidence fields', () => {
    consent.grant('user-1');
    const r = analytics.emit({
      name: 'app_opened',
      schemaVersion: 1,
      subjectId: 'user-1',
      properties: { surface: 'web', wallet: 'G...', signature: '0xab' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('forbidden_field');
    expect(analytics.getSink()).toHaveLength(0);
  });

  it('unknown event or schema version fails closed', () => {
    consent.grant('user-1');
    expect(
      analytics.emit({
        name: 'not_a_real_event',
        schemaVersion: 1,
        subjectId: 'user-1',
      }).ok,
    ).toBe(false);
    expect(
      analytics.emit({
        name: 'app_opened',
        schemaVersion: 99,
        subjectId: 'user-1',
      }).ok,
    ).toBe(false);
  });
});
