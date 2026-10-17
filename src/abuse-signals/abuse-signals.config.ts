import { getRuntimeEnvironment } from '../config/runtime-config';
import { assertValidBinding, loadFinalizedCursorConfig } from '../indexer/finalized-cursor/finalized-cursor.config';
import { AbuseReleaseBinding } from './abuse-signals.types';

/**
 * Abuse policy configuration (PREWAVE-BE-086, #681).
 *
 * Two gates govern activation, and they are deliberately separate:
 *
 *  - `ABUSE_SIGNALS_ENABLED` (default on) records observations and decisions.
 *  - `ABUSE_SIGNALS_ENFORCEMENT_ENABLED` (default **off**) is the only thing
 *    that lets a decision refuse a request. It stays off until a maintainer
 *    turns it on, because this is a pre-wave candidate: detection is safe to
 *    merge, automated refusal is not safe to ship unannounced.
 *
 * Every explicitly provided value is validated fail-closed: a malformed
 * threshold aborts startup rather than silently disabling a guard. Omitted
 * values fall back to the documented defaults below.
 *
 * The release binding is **not** parsed here. It is read through
 * `loadFinalizedCursorConfig` so abuse decisions carry exactly the same
 * chain/release/deployment/artifact provenance the finalized indexer cursor
 * uses, and are rejected when that binding is missing or ambiguous.
 */

/** Hard ceiling on any automated action, regardless of configuration. */
export const ABUSE_HARD_MAX_ACTION_DURATION_MS = 24 * 60 * 60 * 1000;

/** Per-detector thresholds. Values are counts inside one evaluation window. */
export interface AbuseThresholds {
  scraping: {
    /** Anonymous reads inside the window before the read-velocity code fires. */
    maxAnonymousReads: number;
    /** Distinct route groups inside the window before breadth code fires. */
    maxDistinctRoutes: number;
  };
  credentialStuffing: {
    /** Auth failures from one subject inside the window. */
    maxFailures: number;
    /** Distinct credential fingerprints from one subject. */
    maxDistinctCredentials: number;
    /** Distinct subjects presenting one credential fingerprint. */
    maxDistinctSubjectsPerCredential: number;
  };
  spamSubmission: {
    /** Writes from one subject inside the window. */
    maxWrites: number;
    /** Repeated writes sharing one payload fingerprint. */
    maxDuplicatePayloads: number;
  };
  webhook: {
    /** Endpoint create/update/delete operations from one subject. */
    maxEndpointWrites: number;
    /** Secret rotations from one subject inside the window. */
    maxSecretRotations: number;
    /** Delivery/replay operations from one subject. */
    maxDeliveries: number;
  };
  stream: {
    /** Concurrent connections attributed to one subject. */
    maxConcurrentConnections: number;
    /** Subscribe/unsubscribe operations inside the window. */
    maxSubscribeOps: number;
    /** Stream messages inside the window. */
    maxMessages: number;
  };
  support: {
    /** Support requests from one subject inside the window. */
    maxRequests: number;
    /** Requests sharing one duplicate fingerprint inside the window. */
    maxDuplicateRequests: number;
    /** Distinct contacts referenced by one subject. */
    maxDistinctContacts: number;
  };
}

export interface AbusePolicyConfig {
  /** Record observations and decisions at all. */
  enabled: boolean;
  /** Maintainer gate: when false, decisions never refuse a request. */
  enforcementEnabled: boolean;
  /**
   * Salt for subject-key derivation. Null when unset, which makes every
   * subject unattributable and every decision indeterminate (fail closed)
   * rather than attributing traffic to an unsalted digest.
   */
  subjectSalt: string | null;
  /** Evaluation window; counters reset when it passes. */
  windowMs: number;
  /** Ceiling for any issued action's duration. */
  maxActionDurationMs: number;
  /** Ceiling on actions issued for one subject inside `windowMs`. */
  maxActionsPerSubjectPerWindow: number;
  /**
   * Number of proxy hops the deployment trusts. `0` means the socket address
   * only. Anything beyond the trusted hops is discarded, so a caller cannot
   * widen its own trusted prefix with `X-Forwarded-For`.
   */
  trustedProxyHops: number;
  thresholds: AbuseThresholds;
}

export const DEFAULT_ABUSE_THRESHOLDS: AbuseThresholds = Object.freeze({
  scraping: { maxAnonymousReads: 600, maxDistinctRoutes: 40 },
  credentialStuffing: {
    maxFailures: 20,
    maxDistinctCredentials: 5,
    maxDistinctSubjectsPerCredential: 10,
  },
  spamSubmission: { maxWrites: 30, maxDuplicatePayloads: 10 },
  webhook: { maxEndpointWrites: 15, maxSecretRotations: 5, maxDeliveries: 200 },
  stream: { maxConcurrentConnections: 25, maxSubscribeOps: 60, maxMessages: 300 },
  support: { maxRequests: 30, maxDuplicateRequests: 20, maxDistinctContacts: 25 },
});

export const DEFAULT_ABUSE_POLICY: AbusePolicyConfig = Object.freeze({
  enabled: true,
  enforcementEnabled: false,
  subjectSalt: null,
  windowMs: 5 * 60 * 1000,
  maxActionDurationMs: 15 * 60 * 1000,
  maxActionsPerSubjectPerWindow: 3,
  trustedProxyHops: 0,
  thresholds: DEFAULT_ABUSE_THRESHOLDS,
});

/** Reads a strictly positive integer; a malformed value aborts startup. */
function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Reads a non-negative integer; a malformed value aborts startup. */
function readNonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function readBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function readSalt(env: NodeJS.ProcessEnv): string | null {
  const raw = env.ABUSE_SIGNALS_SUBJECT_SALT;
  if (raw === undefined || raw === '') return null;
  const trimmed = raw.trim();
  // A short salt makes the subject digest reversible by brute force, so it is
  // rejected rather than warned about.
  if (trimmed.length < 32) {
    throw new Error('ABUSE_SIGNALS_SUBJECT_SALT must be at least 32 characters');
  }
  return trimmed;
}

/**
 * Loads abuse policy from the environment.
 *
 * Throws on any explicitly provided but malformed value, and on a malformed
 * release binding (reused verbatim from the finalized-cursor loader).
 */
export function loadAbusePolicyConfig(
  env: NodeJS.ProcessEnv = getRuntimeEnvironment(),
): AbusePolicyConfig {
  const thresholds: AbuseThresholds = {
    scraping: {
      maxAnonymousReads: readPositiveInt(
        env,
        'ABUSE_SIGNALS_SCRAPE_MAX_READS',
        DEFAULT_ABUSE_THRESHOLDS.scraping.maxAnonymousReads,
      ),
      maxDistinctRoutes: readPositiveInt(
        env,
        'ABUSE_SIGNALS_SCRAPE_MAX_ROUTES',
        DEFAULT_ABUSE_THRESHOLDS.scraping.maxDistinctRoutes,
      ),
    },
    credentialStuffing: {
      maxFailures: readPositiveInt(
        env,
        'ABUSE_SIGNALS_STUFFING_MAX_FAILURES',
        DEFAULT_ABUSE_THRESHOLDS.credentialStuffing.maxFailures,
      ),
      maxDistinctCredentials: readPositiveInt(
        env,
        'ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_CREDENTIALS',
        DEFAULT_ABUSE_THRESHOLDS.credentialStuffing.maxDistinctCredentials,
      ),
      maxDistinctSubjectsPerCredential: readPositiveInt(
        env,
        'ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_SUBJECTS',
        DEFAULT_ABUSE_THRESHOLDS.credentialStuffing
          .maxDistinctSubjectsPerCredential,
      ),
    },
    spamSubmission: {
      maxWrites: readPositiveInt(
        env,
        'ABUSE_SIGNALS_SPAM_MAX_WRITES',
        DEFAULT_ABUSE_THRESHOLDS.spamSubmission.maxWrites,
      ),
      maxDuplicatePayloads: readPositiveInt(
        env,
        'ABUSE_SIGNALS_SPAM_MAX_DUPLICATE_PAYLOADS',
        DEFAULT_ABUSE_THRESHOLDS.spamSubmission.maxDuplicatePayloads,
      ),
    },
    webhook: {
      maxEndpointWrites: readPositiveInt(
        env,
        'ABUSE_SIGNALS_WEBHOOK_MAX_ENDPOINT_WRITES',
        DEFAULT_ABUSE_THRESHOLDS.webhook.maxEndpointWrites,
      ),
      maxSecretRotations: readPositiveInt(
        env,
        'ABUSE_SIGNALS_WEBHOOK_MAX_SECRET_ROTATIONS',
        DEFAULT_ABUSE_THRESHOLDS.webhook.maxSecretRotations,
      ),
      maxDeliveries: readPositiveInt(
        env,
        'ABUSE_SIGNALS_WEBHOOK_MAX_DELIVERIES',
        DEFAULT_ABUSE_THRESHOLDS.webhook.maxDeliveries,
      ),
    },
    stream: {
      maxConcurrentConnections: readPositiveInt(
        env,
        'ABUSE_SIGNALS_STREAM_MAX_CONNECTIONS',
        DEFAULT_ABUSE_THRESHOLDS.stream.maxConcurrentConnections,
      ),
      maxSubscribeOps: readPositiveInt(
        env,
        'ABUSE_SIGNALS_STREAM_MAX_SUBSCRIBE_OPS',
        DEFAULT_ABUSE_THRESHOLDS.stream.maxSubscribeOps,
      ),
      maxMessages: readPositiveInt(
        env,
        'ABUSE_SIGNALS_STREAM_MAX_MESSAGES',
        DEFAULT_ABUSE_THRESHOLDS.stream.maxMessages,
      ),
    },
    support: {
      maxRequests: readPositiveInt(
        env,
        'ABUSE_SIGNALS_SUPPORT_MAX_REQUESTS',
        DEFAULT_ABUSE_THRESHOLDS.support.maxRequests,
      ),
      maxDuplicateRequests: readPositiveInt(
        env,
        'ABUSE_SIGNALS_SUPPORT_MAX_DUPLICATE_REQUESTS',
        DEFAULT_ABUSE_THRESHOLDS.support.maxDuplicateRequests,
      ),
      maxDistinctContacts: readPositiveInt(
        env,
        'ABUSE_SIGNALS_SUPPORT_MAX_DISTINCT_CONTACTS',
        DEFAULT_ABUSE_THRESHOLDS.support.maxDistinctContacts,
      ),
    },
  };

  const maxActionDurationMs = Math.min(
    readPositiveInt(
      env,
      'ABUSE_SIGNALS_MAX_ACTION_SECONDS',
      DEFAULT_ABUSE_POLICY.maxActionDurationMs / 1000,
    ) * 1000,
    ABUSE_HARD_MAX_ACTION_DURATION_MS,
  );

  return {
    enabled: readBoolean(env, 'ABUSE_SIGNALS_ENABLED', true),
    enforcementEnabled: readBoolean(
      env,
      'ABUSE_SIGNALS_ENFORCEMENT_ENABLED',
      false,
    ),
    subjectSalt: readSalt(env),
    windowMs:
      readPositiveInt(
        env,
        'ABUSE_SIGNALS_WINDOW_SECONDS',
        DEFAULT_ABUSE_POLICY.windowMs / 1000,
      ) * 1000,
    maxActionDurationMs,
    maxActionsPerSubjectPerWindow: readPositiveInt(
      env,
      'ABUSE_SIGNALS_MAX_ACTIONS_PER_SUBJECT',
      DEFAULT_ABUSE_POLICY.maxActionsPerSubjectPerWindow,
    ),
    trustedProxyHops: readNonNegativeInt(
      env,
      'ABUSE_SIGNALS_TRUSTED_PROXY_HOPS',
      DEFAULT_ABUSE_POLICY.trustedProxyHops,
    ),
    thresholds,
  };
}

/**
 * Reads the release binding abuse decisions are stamped with.
 *
 * Delegates to the finalized-cursor loader so there is exactly one definition
 * of a valid chain/release/deployment/artifact binding in the codebase. Returns
 * null when the deployment has no binding configured, which callers must treat
 * as fail-closed (indeterminate), never as "unbound is fine".
 */
export function loadAbuseReleaseBinding(
  env: NodeJS.ProcessEnv = getRuntimeEnvironment(),
): AbuseReleaseBinding | null {
  const { binding } = loadFinalizedCursorConfig(env);
  if (!binding) return null;
  assertValidBinding(binding);
  return {
    chainId: binding.chainId,
    releaseId: binding.releaseId,
    deploymentBlock: binding.deploymentBlock,
    artifactChecksum: binding.artifactChecksum,
  };
}

/** Injection token for the resolved abuse policy. */
export const ABUSE_POLICY = Symbol('ABUSE_POLICY');
/** Injection token for the resolved abuse release binding. */
export const ABUSE_RELEASE_BINDING = Symbol('ABUSE_RELEASE_BINDING');