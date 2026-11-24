import {
  ABUSE_HARD_MAX_ACTION_DURATION_MS,
  DEFAULT_ABUSE_POLICY,
  loadAbusePolicyConfig,
  loadAbuseReleaseBinding,
} from './abuse-signals.config';
import { TEST_SALT } from './abuse-signals.harness';

const VALID_RELEASE = {
  INDEXER_RELEASE_ID: 'v2.1.0-sepolia',
  INDEXER_DEPLOYMENT_BLOCK: '12345678',
  INDEXER_ARTIFACT_CHECKSUM: 'a'.repeat(64),
  BLOCKCHAIN_CHAIN_ID: '11155420',
};

describe('abuse policy configuration (PREWAVE-BE-086)', () => {
  describe('activation gates', () => {
    it('is observe-only by default: detection on, enforcement off', () => {
      const policy = loadAbusePolicyConfig({});
      expect(policy.enabled).toBe(true);
      expect(policy.enforcementEnabled).toBe(false);
    });

    it('requires enforcement to be turned on explicitly', () => {
      expect(
        loadAbusePolicyConfig({ ABUSE_SIGNALS_ENFORCEMENT_ENABLED: 'true' })
          .enforcementEnabled,
      ).toBe(true);
    });

    it('fails closed on a non-boolean gate rather than defaulting', () => {
      expect(() =>
        loadAbusePolicyConfig({ ABUSE_SIGNALS_ENFORCEMENT_ENABLED: 'yes' }),
      ).toThrow('ABUSE_SIGNALS_ENFORCEMENT_ENABLED must be "true" or "false"');
      expect(() =>
        loadAbusePolicyConfig({ ABUSE_SIGNALS_ENABLED: '1' }),
      ).toThrow('ABUSE_SIGNALS_ENABLED must be "true" or "false"');
    });
  });

  describe('subject salt', () => {
    it('is null when unset, which makes every subject unattributable', () => {
      expect(loadAbusePolicyConfig({}).subjectSalt).toBeNull();
    });

    it('is trimmed when set', () => {
      expect(
        loadAbusePolicyConfig({ ABUSE_SIGNALS_SUBJECT_SALT: `  ${TEST_SALT}  ` })
          .subjectSalt,
      ).toBe(TEST_SALT);
    });

    it.each(['short', 'x'.repeat(31)])(
      'refuses the too-short salt %p rather than weakening the digest',
      (salt) => {
        expect(() =>
          loadAbusePolicyConfig({ ABUSE_SIGNALS_SUBJECT_SALT: salt }),
        ).toThrow('ABUSE_SIGNALS_SUBJECT_SALT must be at least 32 characters');
      },
    );
  });

  describe('thresholds fail closed', () => {
    it.each([
      'ABUSE_SIGNALS_SCRAPE_MAX_READS',
      'ABUSE_SIGNALS_SCRAPE_MAX_ROUTES',
      'ABUSE_SIGNALS_STUFFING_MAX_FAILURES',
      'ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_CREDENTIALS',
      'ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_SUBJECTS',
      'ABUSE_SIGNALS_SPAM_MAX_WRITES',
      'ABUSE_SIGNALS_SPAM_MAX_DUPLICATE_PAYLOADS',
      'ABUSE_SIGNALS_WEBHOOK_MAX_ENDPOINT_WRITES',
      'ABUSE_SIGNALS_WEBHOOK_MAX_SECRET_ROTATIONS',
      'ABUSE_SIGNALS_WEBHOOK_MAX_DELIVERIES',
      'ABUSE_SIGNALS_STREAM_MAX_CONNECTIONS',
      'ABUSE_SIGNALS_STREAM_MAX_SUBSCRIBE_OPS',
      'ABUSE_SIGNALS_STREAM_MAX_MESSAGES',
      'ABUSE_SIGNALS_SUPPORT_MAX_REQUESTS',
      'ABUSE_SIGNALS_SUPPORT_MAX_DUPLICATE_REQUESTS',
      'ABUSE_SIGNALS_SUPPORT_MAX_DISTINCT_CONTACTS',
      'ABUSE_SIGNALS_WINDOW_SECONDS',
      'ABUSE_SIGNALS_MAX_ACTION_SECONDS',
      'ABUSE_SIGNALS_MAX_ACTIONS_PER_SUBJECT',
    ])('refuses a malformed %s', (key) => {
      for (const value of ['0', '-1', 'abc', '1.5', '']) {
        if (value === '') {
          // An empty string means "unset" and falls back to the default.
          expect(loadAbusePolicyConfig({ [key]: value })).toBeDefined();
          continue;
        }
        expect(() => loadAbusePolicyConfig({ [key]: value })).toThrow(key);
      }
    });

    it('accepts a zero trusted-hop count but refuses a negative one', () => {
      expect(
        loadAbusePolicyConfig({ ABUSE_SIGNALS_TRUSTED_PROXY_HOPS: '0' })
          .trustedProxyHops,
      ).toBe(0);
      expect(() =>
        loadAbusePolicyConfig({ ABUSE_SIGNALS_TRUSTED_PROXY_HOPS: '-1' }),
      ).toThrow('ABUSE_SIGNALS_TRUSTED_PROXY_HOPS must be a non-negative integer');
    });
  });

  describe('action bounds cannot be raised past the hard ceiling', () => {
    it('clamps an over-long configured duration', () => {
      const policy = loadAbusePolicyConfig({
        ABUSE_SIGNALS_MAX_ACTION_SECONDS: String(
          ABUSE_HARD_MAX_ACTION_DURATION_MS / 1000 + 86_400,
        ),
      });
      expect(policy.maxActionDurationMs).toBe(ABUSE_HARD_MAX_ACTION_DURATION_MS);
    });

    it('honours a shorter configured duration', () => {
      expect(
        loadAbusePolicyConfig({ ABUSE_SIGNALS_MAX_ACTION_SECONDS: '120' })
          .maxActionDurationMs,
      ).toBe(120_000);
    });

    it('ships a default that is already well inside the ceiling', () => {
      expect(DEFAULT_ABUSE_POLICY.maxActionDurationMs).toBeLessThanOrEqual(
        ABUSE_HARD_MAX_ACTION_DURATION_MS,
      );
    });
  });

  describe('release binding', () => {
    it('is null when the deployment has none configured', () => {
      expect(loadAbuseReleaseBinding({})).toBeNull();
    });

    it('reuses the finalized-cursor binding so there is one definition', () => {
      const binding = loadAbuseReleaseBinding(VALID_RELEASE);
      expect(binding).toEqual({
        chainId: 11155420,
        releaseId: 'v2.1.0-sepolia',
        deploymentBlock: 12345678n,
        artifactChecksum: 'a'.repeat(64),
      });
    });

    it.each([
      { INDEXER_RELEASE_ID: undefined },
      { INDEXER_DEPLOYMENT_BLOCK: undefined },
      { INDEXER_ARTIFACT_CHECKSUM: undefined },
      { BLOCKCHAIN_CHAIN_ID: undefined },
    ])('fails closed on a partial binding (%p)', (override) => {
      const env = { ...VALID_RELEASE, ...override };
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined) delete env[key as keyof typeof env];
      }
      expect(() => loadAbuseReleaseBinding(env)).toThrow('INVALID_BINDING');
    });

    it('fails closed on a malformed checksum or block', () => {
      expect(() =>
        loadAbuseReleaseBinding({ ...VALID_RELEASE, INDEXER_ARTIFACT_CHECKSUM: 'short' }),
      ).toThrow('INVALID_BINDING');
      expect(() =>
        loadAbuseReleaseBinding({ ...VALID_RELEASE, INDEXER_DEPLOYMENT_BLOCK: 'abc' }),
      ).toThrow('INVALID_BINDING');
    });

    it('fails closed on an unsupported chain id', () => {
      expect(() =>
        loadAbuseReleaseBinding({ ...VALID_RELEASE, BLOCKCHAIN_CHAIN_ID: '0' }),
      ).toThrow('INVALID_BINDING');
    });
  });
});