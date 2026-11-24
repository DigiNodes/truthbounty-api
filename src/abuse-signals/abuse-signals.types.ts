/**
 * PREWAVE-BE-086 (issue #681): abuse signal contract.
 *
 * These types are the wire contract for abuse detection and enforcement. The
 * boundary is deliberately narrow:
 *
 *  - Abuse signals are **advisory to the API's own delivery surface only**.
 *    Nothing here can create, mutate, settle, resolve, reward or otherwise
 *    change protocol truth. Claims, verification, disputes, rewards, treasury
 *    and governance remain reproducible from finalized canonical contract
 *    events, and the deployed contracts remain authoritative.
 *  - Every automated action is **bounded and time-limited**: an action without
 *    a valid, future `expiresAt` is never issued and never enforced.
 *  - Every decision carries a **versioned reason code** plus the model and
 *    config versions that produced it, so a historical decision is never
 *    re-interpreted after thresholds change.
 *  - Heuristics, thresholds, aggregates and subject keys are **internal**. The
 *    public surface exposes only the canonical {@link PublicErrorCode} and a
 *    `Retry-After` bound.
 *
 * Precedents mirrored here: `src/operations/operations.types.ts` (versioned
 * reason codes + bounded authority), `src/indexer/finalized-cursor` (release
 * binding + fail-closed provenance) and
 * `src/v2/events/entities/event-quarantine.entity.ts` (enum mirrored by a
 * database CHECK constraint).
 */

/** Wire-contract version for anything this module returns or accepts. */
export const ABUSE_SIGNAL_SCHEMA_VERSION = 'abuse-signals.v1';

/**
 * Version of the detection model (the set of detectors and how their signals
 * combine). Bump when detector logic changes meaning, not when a threshold
 * moves — threshold moves are a {@link ABUSE_CONFIG_VERSION} change.
 */
export const ABUSE_MODEL_VERSION = 'abuse-model.v1';

/**
 * Version of the threshold/bound configuration a decision was evaluated
 * against. Recorded on every decision so operators can tell "the rule changed"
 * from "the traffic changed".
 */
export const ABUSE_CONFIG_VERSION = 'abuse-config.v1';

/**
 * Release binding every abuse decision is stamped with.
 *
 * Abuse enforcement is bound to the same provenance the indexer uses, so a
 * decision can never be replayed across chains, releases, deployments or
 * contract artifacts. Mirrors `ReleaseBinding` in
 * `src/indexer/finalized-cursor/finalized-cursor.types.ts`.
 */
export interface AbuseReleaseBinding {
  chainId: number;
  releaseId: string;
  deploymentBlock: bigint;
  artifactChecksum: string;
}

/** Abuse classes this module is responsible for detecting. */
export enum AbuseSignalKind {
  SCRAPING = 'scraping',
  CREDENTIAL_STUFFING = 'credential_stuffing',
  SPAM_SUBMISSION = 'spam_submission',
  WEBHOOK_ABUSE = 'webhook_abuse',
  STREAM_STORM = 'stream_storm',
  SUPPORT_FLOODING = 'support_flooding',
}

/** How a subject was identified. Only verifiable sources are accepted. */
export enum AbuseSubjectKind {
  /** Verified authenticated principal (JWT `sub`). */
  PRINCIPAL = 'principal',
  /** Verified wallet address taken from a validated JWT claim. */
  WALLET = 'wallet',
  /**
   * Masked network prefix (IPv4 /24 or IPv6 /64). Deliberately coarse so a
   * shared NAT or corporate egress cannot be attributed or punished as one
   * abusive party.
   */
  NETWORK_PREFIX = 'network_prefix',
}

/** Why a subject could not be attributed. Attributions never fall back. */
export enum AbuseAttributionFailure {
  /** No verified identity and no usable network address. */
  UNIDENTIFIED = 'unidentified',
  /** Only attacker-supplied headers were present; never trusted. */
  UNTRUSTED_IDENTIFIER_ONLY = 'untrusted_identifier_only',
  /** Present but malformed beyond safe normalization. */
  MALFORMED_IDENTIFIER = 'malformed_identifier',
  /**
   * The subject salt is missing or unusable, so no stable subject key can be
   * derived. Attribution is refused instead of falling back to a weak digest.
   */
  CONFIGURATION_UNAVAILABLE = 'configuration_unavailable',
}

/**
 * A deterministically derived, non-reversible subject key.
 *
 * Never the raw address, wallet or user id: the key is a salted hash so that
 * stored signals and audit records cannot be reversed into personal data.
 */
export interface AbuseSubject {
  kind: AbuseSubjectKind;
  /** Salted digest; the only identifier stored or logged. */
  key: string;
}

/** Result of subject resolution, including the fail-closed unattributed case. */
export type AbuseSubjectResolution =
  | { attributed: true; subject: AbuseSubject }
  | { attributed: false; reason: AbuseAttributionFailure };

/** Surface an observation came from. Used only to route detectors. */
export enum AbuseSurface {
  HTTP = 'http',
  AUTH = 'auth',
  CLAIMS = 'claims',
  SUPPORT = 'support',
  WEBHOOK = 'webhook',
  STREAM = 'stream',
  SEARCH = 'search',
  ADMIN = 'admin',
}

/** What happened, in the smallest vocabulary that lets detectors work. */
export enum AbuseObservationKind {
  READ = 'read',
  WRITE = 'write',
  AUTH_FAILURE = 'auth_failure',
  AUTH_SUCCESS = 'auth_success',
  STREAM_SUBSCRIBE = 'stream_subscribe',
  STREAM_CONNECT = 'stream_connect',
  STREAM_DISCONNECT = 'stream_disconnect',
  STREAM_MESSAGE = 'stream_message',
  WEBHOOK_ENDPOINT_WRITE = 'webhook_endpoint_write',
  WEBHOOK_SECRET_ROTATION = 'webhook_secret_rotation',
  WEBHOOK_DELIVERY = 'webhook_delivery',
}

/**
 * One observed event.
 *
 * `credentialFingerprint` is a salted digest produced by the caller and is
 * never a credential, signature, token or raw secret. `routeGroup` is the
 * coarse, low-cardinality path shape used for breadth scoring — never a full
 * path with user-supplied segments.
 */
export interface AbuseObservation {
  kind: AbuseObservationKind;
  surface: AbuseSurface;
  routeGroup: string;
  method?: string;
  occurredAt: number;
  outcome?: 'success' | 'failure';
  /**
   * Salted digest of the attempted credential (auth only). Lets a detector see
   * "one credential, many subjects" without ever seeing the credential.
   */
  credentialFingerprint?: string;
  /** Salted digest of the submitted payload, used for duplicate detection. */
  payloadFingerprint?: string;
}

/** A single detector's finding. */
export interface AbuseSignal {
  kind: AbuseSignalKind;
  /** Versioned, stable code for this specific finding. */
  reasonCode: AbuseReasonCode;
  /**
   * The independent axis this signal measured, e.g. `read_volume`,
   * `route_breadth`, `credential_spread`. Two signals with the same dimension
   * corroborate nothing, so a single noisy measure can never clear a bar.
   */
  dimension: string;
  /** How many observations back the finding. */
  sampleCount: number;
  /** Confidence in [0, 1]; never exposed publicly. */
  confidence: number;
}

/**
 * Bounded per-subject aggregate for one evaluation window.
 *
 * Every collection is capped so a hostile subject cannot grow the process heap
 * by sending distinct values: `distinctRoutes`, `distinctCredentials` and
 * friends stop adding past {@link AbuseWindowLimits.distinctCap} and record
 * that they saturated instead.
 */
export interface AbuseSubjectWindow {
  subjectKey: string;
  subjectKind: AbuseSubjectKind;
  windowStart: number;
  windowMs: number;
  total: number;
  reads: number;
  writes: number;
  authFailures: number;
  authSuccesses: number;
  distinctRoutes: string[];
  routeSaturationHit: boolean;
  distinctCredentials: string[];
  credentialSaturationHit: boolean;
  /** payloadFingerprint -> repeat count beyond the first occurrence. */
  duplicatePayloadCounts: Map<string, number>;
  /** Repeats that arrived after `payloadCap` distinct fingerprints. */
  duplicatePayloadOverflow: number;
  /** Support-only duplicate fingerprint repeats. */
  supportDuplicateCounts: Map<string, number>;
  supportDuplicateRequests: number;
  /** Requests observed on the support surface specifically. */
  supportRequests: number;
  supportContacts: string[];
  supportContactSaturationHit: boolean;
  webhookEndpointWrites: number;
  webhookSecretRotations: number;
  webhookDeliveries: number;
  streamConnect: number;
  streamDisconnect: number;
  streamSubscribeOps: number;
  streamMessages: number;
  /** Distinct subjects seen for each credential fingerprint in this window. */
  subjectsPerCredential: Map<string, number>;
}

/** Caps applied while accumulating a window. */
export const ABUSE_WINDOW_LIMITS = Object.freeze({
  /** Distinct values retained per distinct-set before saturating. */
  distinctCap: 256,
  /** Distinct payload fingerprints retained before saturating. */
  payloadCap: 128,
  /** Observations retained for the newest window of one subject. */
  observationsPerSubject: 512,
});

/**
 * Versioned reason codes.
 *
 * The `version` in {@link ABUSE_REASON_CODE_REGISTRY} is the contract: a code
 * is never redefined in place. A change of meaning requires a new code, and
 * the registry keeps the superseded version so stored decisions stay
 * interpretable.
 */
export enum AbuseReasonCode {
  SCRAPE_HIGH_BREADTH_ANONYMOUS = 'scrape_high_breadth_anonymous',
  SCRAPE_SUSTAINED_READ_VELOCITY = 'scrape_sustained_read_velocity',

  CREDENTIAL_STUFFING_DISTINCT_CREDENTIALS = 'credential_stuffing_distinct_credentials',
  CREDENTIAL_STUFFING_DISTINCT_SUBJECTS = 'credential_stuffing_distinct_subjects',

  SPAM_SUBMISSION_WRITE_BURST = 'spam_submission_write_burst',
  SPAM_SUBMISSION_DUPLICATE_PAYLOAD = 'spam_submission_duplicate_payload',

  WEBHOOK_ENDPOINT_CHURN = 'webhook_endpoint_churn',
  WEBHOOK_SECRET_ROTATION_ABUSE = 'webhook_secret_rotation_abuse',
  WEBHOOK_DELIVERY_STORM = 'webhook_delivery_storm',

  STREAM_CONNECTION_STORM = 'stream_connection_storm',
  STREAM_SUBSCRIBE_STORM = 'stream_subscribe_storm',
  STREAM_MESSAGE_STORM = 'stream_message_storm',

  SUPPORT_VOLUME_FLOOD = 'support_volume_flood',
  SUPPORT_DUPLICATE_FLOOD = 'support_duplicate_flood',
  SUPPORT_CONTACT_FANOUT = 'support_contact_fanout',

  /**
   * Not abuse: the module could not prove anything and declined to act.
   * Recorded so that suppression is observable instead of silent.
   */
  INSUFFICIENT_CORROBORATION = 'insufficient_corroboration',
}

/** Severity ordering used to pick an action when several signals fire. */
export enum AbuseSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

/** Registry entry describing one reason code. Never contains a threshold. */
export interface AbuseReasonCodeDescriptor {
  /** Version of this code's meaning. Never changed in place. */
  version: number;
  kind: AbuseSignalKind | 'suppressed';
  severity: AbuseSeverity;
  /**
   * A finding on a coarse `NETWORK_PREFIX` subject requires at least this many
   * independent corroborating dimensions before it may produce an action, so a
   * shared NAT is never punished on one dimension alone.
   */
  minCorroboratingDimensions: number;
  /** Whether an automated action may be issued from this code alone. */
  allowsAutomatedAction: boolean;
}

/**
 * The versioned reason-code registry.
 *
 * Public surface: the codes themselves are safe to publish (they are stable
 * machine codes), but severity, corroboration requirements and the detector
 * internals behind them are **not** exposed outside the admin plane.
 */
export const ABUSE_REASON_CODE_REGISTRY: Readonly<
  Record<AbuseReasonCode, AbuseReasonCodeDescriptor>
> = Object.freeze({
  [AbuseReasonCode.SCRAPE_HIGH_BREADTH_ANONYMOUS]: {
    version: 1,
    kind: AbuseSignalKind.SCRAPING,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 2,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.SCRAPE_SUSTAINED_READ_VELOCITY]: {
    version: 1,
    kind: AbuseSignalKind.SCRAPING,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 2,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.CREDENTIAL_STUFFING_DISTINCT_CREDENTIALS]: {
    version: 1,
    kind: AbuseSignalKind.CREDENTIAL_STUFFING,
    severity: AbuseSeverity.HIGH,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.CREDENTIAL_STUFFING_DISTINCT_SUBJECTS]: {
    version: 1,
    kind: AbuseSignalKind.CREDENTIAL_STUFFING,
    severity: AbuseSeverity.HIGH,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.SPAM_SUBMISSION_WRITE_BURST]: {
    version: 1,
    kind: AbuseSignalKind.SPAM_SUBMISSION,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 2,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.SPAM_SUBMISSION_DUPLICATE_PAYLOAD]: {
    version: 1,
    kind: AbuseSignalKind.SPAM_SUBMISSION,
    severity: AbuseSeverity.LOW,
    minCorroboratingDimensions: 2,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.WEBHOOK_ENDPOINT_CHURN]: {
    version: 1,
    kind: AbuseSignalKind.WEBHOOK_ABUSE,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.WEBHOOK_SECRET_ROTATION_ABUSE]: {
    version: 1,
    kind: AbuseSignalKind.WEBHOOK_ABUSE,
    severity: AbuseSeverity.HIGH,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.WEBHOOK_DELIVERY_STORM]: {
    version: 1,
    kind: AbuseSignalKind.WEBHOOK_ABUSE,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.STREAM_CONNECTION_STORM]: {
    version: 1,
    kind: AbuseSignalKind.STREAM_STORM,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.STREAM_SUBSCRIBE_STORM]: {
    version: 1,
    kind: AbuseSignalKind.STREAM_STORM,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.STREAM_MESSAGE_STORM]: {
    version: 1,
    kind: AbuseSignalKind.STREAM_STORM,
    severity: AbuseSeverity.HIGH,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.SUPPORT_VOLUME_FLOOD]: {
    version: 1,
    kind: AbuseSignalKind.SUPPORT_FLOODING,
    severity: AbuseSeverity.MEDIUM,
    minCorroboratingDimensions: 2,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.SUPPORT_DUPLICATE_FLOOD]: {
    version: 1,
    kind: AbuseSignalKind.SUPPORT_FLOODING,
    severity: AbuseSeverity.LOW,
    minCorroboratingDimensions: 2,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.SUPPORT_CONTACT_FANOUT]: {
    version: 1,
    kind: AbuseSignalKind.SUPPORT_FLOODING,
    severity: AbuseSeverity.HIGH,
    minCorroboratingDimensions: 1,
    allowsAutomatedAction: true,
  },
  [AbuseReasonCode.INSUFFICIENT_CORROBORATION]: {
    version: 1,
    kind: 'suppressed',
    severity: AbuseSeverity.LOW,
    minCorroboratingDimensions: 3,
    allowsAutomatedAction: false,
  },
});

/** Thrown when a reason code is not present in the registry. */
export class AbuseReasonCodeError extends Error {
  constructor(readonly code: string) {
    super(`UNREGISTERED_ABUSE_REASON_CODE: ${code}`);
    this.name = 'AbuseReasonCodeError';
  }
}

/** Resolves a reason code's descriptor, failing closed on unknown codes. */
export function describeReasonCode(code: AbuseReasonCode): AbuseReasonCodeDescriptor {
  const descriptor = ABUSE_REASON_CODE_REGISTRY[code];
  if (!descriptor) throw new AbuseReasonCodeError(String(code));
  return descriptor;
}

/**
 * Bounded actions.
 *
 * Every action has an expiry and is appealable. `NONE` is the only action that
 * is not enforced, and it is what every subject gets until a versioned reason
 * code clears the corroboration and escalation bars.
 */
export enum AbuseActionKind {
  /** Record and surface to operators; change nothing. */
  NONE = 'none',
  /** Record and surface; no additional throttling. */
  OBSERVE = 'observe',
  /** Add an extra cost multiplier to the existing rate-limit budget. */
  THROTTLE = 'throttle',
  /** Demand a step-up challenge before serving the surface. */
  CHALLENGE = 'challenge',
  /** Refuse the surface entirely for the remainder of the bound. */
  SUSPEND = 'suspend',
}

/** Escalation ladder. Order is the ranking; index is the escalation level. */
export const ABUSE_ACTION_LADDER: readonly AbuseActionKind[] = Object.freeze([
  AbuseActionKind.NONE,
  AbuseActionKind.OBSERVE,
  AbuseActionKind.THROTTLE,
  AbuseActionKind.CHALLENGE,
  AbuseActionKind.SUSPEND,
]);

/** Outcome of evaluating observations for one subject. */
export enum AbuseDecisionOutcome {
  /** No signal cleared the bar. */
  NO_SIGNAL = 'no_signal',
  /** Signals seen but not corroborated; deliberately suppressed. */
  SUPPRESSED = 'suppressed',
  /** An action was issued. */
  ACTIONED = 'actioned',
  /** Enforcement disabled by configuration; signals recorded only. */
  OBSERVED_ONLY = 'observed_only',
  /** The module could not decide and refused to guess (fail closed). */
  INDETERMINATE = 'indeterminate',
}

/** Why a decision is `INDETERMINATE`. */
export enum AbuseIndeterminateReason {
  /** No verified subject: never guess an attribution. */
  UNATTRIBUTED = 'unattributed',
  /** Release binding missing, incomplete or not loadable. */
  RELEASE_BINDING_INVALID = 'release_binding_invalid',
  /** Enforcement requested but activation is maintainer-gated. */
  ENFORCEMENT_DISABLED = 'enforcement_disabled',
  /** The signal store could not be read or written. */
  STORE_UNAVAILABLE = 'store_unavailable',
}

/** Lifecycle of an issued action. */
export enum AbuseActionStatus {
  ACTIVE = 'active',
  /** `expiresAt` passed: enforcement stops with no operator action. */
  EXPIRED = 'expired',
  /** Lifted by an approved appeal. */
  LIFTED = 'lifted',
  /** Superseded by a newer bounded action. */
  SUPERSEDED = 'superseded',
}

/** A bounded, appealable action bound to one subject and one release. */
export interface AbuseAction {
  id: string;
  subjectKey: string;
  subjectKind: AbuseSubjectKind;
  kind: AbuseActionKind;
  status: AbuseActionStatus;
  reasonCode: AbuseReasonCode;
  reasonCodeVersion: number;
  modelVersion: string;
  configVersion: string;
  binding: AbuseReleaseBinding;
  /** Bounded multipliers/effects; always finite. */
  costMultiplier: number;
  startedAt: string;
  /** Mandatory, always strictly after `startedAt`. */
  expiresAt: string;
  appealable: true;
  escalationLevel: number;
}

/** One decision, as recorded. */
export interface AbuseDecision {
  id: string;
  subjectKey: string;
  subjectKind: AbuseSubjectKind;
  outcome: AbuseDecisionOutcome;
  indeterminateReason: AbuseIndeterminateReason | null;
  reasonCode: AbuseReasonCode | null;
  reasonCodeVersion: number | null;
  kind: AbuseSignalKind | null;
  severity: AbuseSeverity | null;
  confidence: number;
  sampleCount: number;
  /** Independent dimensions that agreed; used for corroboration. */
  corroboratingDimensions: number;
  modelVersion: string;
  configVersion: string;
  binding: AbuseReleaseBinding | null;
  action: AbuseAction | null;
  decidedAt: string;
}

/** Outcome of the admin-plane enforcement read for one subject. */
export interface AbuseEnforcementState {
  enforced: boolean;
  /**
   * True when the module could not prove that no action is in force (store
   * unreachable, or the release binding that authorizes enforcement is
   * missing). The request path denies in this state: an unknown enforcement
   * result is not the same as a clean one.
   */
  indeterminate: boolean;
  action: AbuseAction | null;
  /** Milliseconds until the bound expires; never negative, never unbounded. */
  retryAfterMs: number | null;
}