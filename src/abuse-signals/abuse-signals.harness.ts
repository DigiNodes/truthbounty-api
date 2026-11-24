import {
  ABUSE_CONFIG_VERSION,
  ABUSE_MODEL_VERSION,
  AbuseReasonCode,
  ABUSE_REASON_CODE_REGISTRY,
} from './abuse-signals.types';
import {
  ABUSE_POLICY,
  ABUSE_RELEASE_BINDING,
  AbusePolicyConfig,
  loadAbusePolicyConfig,
} from './abuse-signals.config';
import { ABUSE_SIGNAL_STORE, InMemoryAbuseSignalStore } from './abuse-signal.store';
import {
  ABUSE_CLOCK,
  ABUSE_DETECTORS,
  AbuseClock,
  AbuseSignalService,
  buildAbuseDetectors,
} from './abuse-signal.service';
import { resolveAbuseSubject } from './abuse-subject';
import { AbuseSubjectResolution } from './abuse-signals.types';

/** Shared harness so each spec states only what it is actually testing. */

/** Salt long enough to satisfy the configuration's minimum length. */
export const TEST_SALT = 'test-subject-salt-that-is-long-enough-0123456789';

export const TEST_BINDING = {
  chainId: 11155420,
  releaseId: 'v2.1.0-sepolia',
  deploymentBlock: 12345678n,
  artifactChecksum: 'a'.repeat(64),
};

export const OTHER_BINDING = {
  chainId: 10,
  releaseId: 'v2.1.0-mainnet',
  deploymentBlock: 99999999n,
  artifactChecksum: 'b'.repeat(64),
};

/** A clock the test drives by hand, so bounds are exact rather than timed. */
export class ManualClock implements AbuseClock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(value: number): void {
    this.current = value;
  }
}

export interface HarnessOptions {
  policy?: Partial<AbusePolicyConfig>;
  binding?: typeof TEST_BINDING | null;
  now?: number;
  store?: InMemoryAbuseSignalStore;
  detectors?: ReturnType<typeof buildAbuseDetectors>;
}

export interface Harness {
  service: AbuseSignalService;
  store: InMemoryAbuseSignalStore;
  policy: AbusePolicyConfig;
  clock: ManualClock;
  /** Tokens the module's providers are keyed by, for DI-level assertions. */
  tokens: {
    policy: typeof ABUSE_POLICY;
    binding: typeof ABUSE_RELEASE_BINDING;
    store: typeof ABUSE_SIGNAL_STORE;
    detectors: typeof ABUSE_DETECTORS;
    clock: typeof ABUSE_CLOCK;
  };
}

/**
 * Builds the service the same way the module does, with the clock injected.
 *
 * `enforcementEnabled` defaults to **false** here exactly as it does in
 * `loadAbusePolicyConfig`, so a spec that wants refusal has to opt in
 * explicitly — the same way a maintainer would.
 */
export function buildHarness(options: HarnessOptions = {}): Harness {
  const base = loadAbusePolicyConfig({ ABUSE_SIGNALS_SUBJECT_SALT: TEST_SALT });
  const policy: AbusePolicyConfig = {
    ...base,
    ...options.policy,
  };
  const store = options.store ?? new InMemoryAbuseSignalStore();
  const clock = new ManualClock(options.now ?? 1_700_000_000_000);
  const service = new AbuseSignalService(
    store,
    policy,
    options.binding === undefined ? TEST_BINDING : options.binding,
    options.detectors ?? buildAbuseDetectors(policy),
    clock,
  );
  return {
    service,
    store,
    policy,
    clock,
    tokens: {
      policy: ABUSE_POLICY,
      binding: ABUSE_RELEASE_BINDING,
      store: ABUSE_SIGNAL_STORE,
      detectors: ABUSE_DETECTORS,
      clock: ABUSE_CLOCK,
    },
  };
}

/** Narrows a resolution, failing the test rather than narrowing silently. */
export function assertAttributed(resolution: AbuseSubjectResolution) {
  if (!resolution.attributed) {
    throw new Error(`expected attribution, got ${resolution.reason}`);
  }
  return resolution;
}

/** A subject resolution for a named principal. */
export function principalResolution(principalId: string) {
  return assertAttributed(
    resolveAbuseSubject({
      principalId,
      socketRemoteAddress: '203.0.113.9',
      trustedProxyHops: 0,
      subjectSalt: TEST_SALT,
    }),
  );
}

/** A subject resolution for an anonymous caller behind one egress. */
export function networkResolution(address: string, hops = 0) {
  return assertAttributed(
    resolveAbuseSubject({
      socketRemoteAddress: address,
      forwardedFor: null,
      trustedProxyHops: hops,
      subjectSalt: TEST_SALT,
    }),
  );
}

/** Asserts the given reason code is present in the versioned registry. */
export function expectRegisteredReasonCode(code: AbuseReasonCode): void {
  expect(ABUSE_REASON_CODE_REGISTRY[code]).toBeDefined();
}

/** The versions every decision must carry. */
export const EXPECTED_VERSIONS = {
  modelVersion: ABUSE_MODEL_VERSION,
  configVersion: ABUSE_CONFIG_VERSION,
} as const;