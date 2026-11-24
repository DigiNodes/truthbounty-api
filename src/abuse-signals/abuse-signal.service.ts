import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ABUSE_HARD_MAX_ACTION_DURATION_MS,
  ABUSE_POLICY,
  ABUSE_RELEASE_BINDING,
  AbusePolicyConfig,
} from './abuse-signals.config';
import {
  ABUSE_SIGNAL_STORE,
  AbuseDecisionFilter,
  AbuseSignalStore,
  windowStartFor,
} from './abuse-signal.store';
import {
  ABUSE_ACTION_LADDER,
  ABUSE_CONFIG_VERSION,
  ABUSE_MODEL_VERSION,
  AbuseAction,
  AbuseActionKind,
  AbuseActionStatus,
  AbuseDecision,
  AbuseDecisionOutcome,
  AbuseEnforcementState,
  AbuseIndeterminateReason,
  AbuseObservation,
  AbuseReasonCode,
  AbuseReleaseBinding,
  AbuseSeverity,
  AbuseSignal,
  AbuseSignalKind,
  AbuseSubjectKind,
  AbuseSubjectResolution,
  AbuseSubjectWindow,
  describeReasonCode,
} from './abuse-signals.types';
import {
  AbuseDetector,
  AbuseDetectorContext,
  CredentialStuffingDetector,
  ScrapingDetector,
  SpamSubmissionDetector,
  StreamStormDetector,
  SupportFloodingDetector,
  WebhookAbuseDetector,
} from './detectors';

/** Injection token for the module's injectable detectors. */
export const ABUSE_DETECTORS = Symbol('ABUSE_DETECTORS');

/** Injection token for the clock, so bounds can be exercised deterministically. */
export const ABUSE_CLOCK = Symbol('ABUSE_CLOCK');

/** Time source. Overridden in tests to exercise expiry and recovery. */
export interface AbuseClock {
  now(): number;
}

/** A resolution already narrowed to the attributed branch. */
type AttributedResolution = Extract<
  AbuseSubjectResolution,
  { attributed: true }
>;

/**
 * The signal shape a decision records. `kind` is widened to allow the synthetic
 * `suppressed` marker, which is deliberately not one of the abuse classes.
 */
type RecordedSignal = Omit<AbuseSignal, 'kind'> & {
  kind: AbuseSignalKind | 'suppressed';
};

/** The production clock. */
export class SystemAbuseClock implements AbuseClock {
  now(): number {
    return Date.now();
  }
}

/** Builds the detector set for a policy. Exported so tests can mirror it. */
export function buildAbuseDetectors(
  policy: AbusePolicyConfig,
): AbuseDetector[] {
  const { thresholds } = policy;
  return [
    new ScrapingDetector({
      maxAnonymousReads: thresholds.scraping.maxAnonymousReads,
      maxDistinctRoutes: thresholds.scraping.maxDistinctRoutes,
    }),
    new CredentialStuffingDetector({
      maxFailures: thresholds.credentialStuffing.maxFailures,
      maxDistinctCredentials: thresholds.credentialStuffing.maxDistinctCredentials,
      maxDistinctSubjectsPerCredential:
        thresholds.credentialStuffing.maxDistinctSubjectsPerCredential,
    }),
    new SpamSubmissionDetector({
      maxWrites: thresholds.spamSubmission.maxWrites,
      maxDuplicatePayloads: thresholds.spamSubmission.maxDuplicatePayloads,
    }),
    new WebhookAbuseDetector({
      maxEndpointWrites: thresholds.webhook.maxEndpointWrites,
      maxSecretRotations: thresholds.webhook.maxSecretRotations,
      maxDeliveries: thresholds.webhook.maxDeliveries,
    }),
    new StreamStormDetector({
      maxConcurrentConnections: thresholds.stream.maxConcurrentConnections,
      maxSubscribeOps: thresholds.stream.maxSubscribeOps,
      maxMessages: thresholds.stream.maxMessages,
    }),
    new SupportFloodingDetector({
      maxRequests: thresholds.support.maxRequests,
      maxDuplicateRequests: thresholds.support.maxDuplicateRequests,
      maxDistinctContacts: thresholds.support.maxDistinctContacts,
    }),
  ];
}

/** Base duration per severity before escalation multipliers. */
const BASE_ACTION_DURATION_MS: Record<AbuseSeverity, number> = {
  [AbuseSeverity.LOW]: 60_000,
  [AbuseSeverity.MEDIUM]: 5 * 60_000,
  [AbuseSeverity.HIGH]: 15 * 60_000,
};

/** First action issued for each severity. */
const FIRST_ACTION: Record<AbuseSeverity, AbuseActionKind> = {
  [AbuseSeverity.LOW]: AbuseActionKind.OBSERVE,
  [AbuseSeverity.MEDIUM]: AbuseActionKind.THROTTLE,
  [AbuseSeverity.HIGH]: AbuseActionKind.CHALLENGE,
};

/** The lowest corroboration any shared-egress subject must reach. */
const SHARED_EGRESS_MIN_DIMENSIONS = 2;

const SEVERITY_RANK: Record<AbuseSeverity, number> = {
  [AbuseSeverity.LOW]: 0,
  [AbuseSeverity.MEDIUM]: 1,
  [AbuseSeverity.HIGH]: 2,
};

/**
 * Abuse signal evaluation and bounded enforcement (PREWAVE-BE-086, #681).
 *
 * **What this service can do:** observe traffic, decide whether a subject is
 * abusing a delivery surface, issue a bounded action with a mandatory expiry,
 * and answer whether an action is currently in force.
 *
 * **What it deliberately cannot do:** touch protocol state. It holds no
 * repository for claims, verification, disputes, rewards, treasury or
 * governance, injects no chain client and no signer, and the only thing it
 * writes is an abuse decision and a bounded action. Finalized canonical
 * contract events remain the authority for anything that matters on-chain.
 *
 * **Fail-closed rules**, all of which produce an `INDETERMINATE` decision
 * rather than a guess:
 *  - no verified subject          -> `UNATTRIBUTED`
 *  - missing/ambiguous binding    -> `RELEASE_BINDING_INVALID`
 *  - store read/write failure     -> `STORE_UNAVAILABLE`
 *
 * **Bound rules:** every action carries an `expiresAt` strictly after its
 * `startedAt`, capped by {@link AbusePolicyConfig.maxActionDurationMs} and by a
 * hard 24h ceiling that configuration cannot raise. Escalation is monotonic per
 * window and capped, so repeated abuse cannot grow an action without limit, and
 * an open appeal pins the escalation level instead of granting immunity.
 */
@Injectable()
export class AbuseSignalService {
  private readonly logger = new Logger(AbuseSignalService.name);

  constructor(
    @Inject(ABUSE_SIGNAL_STORE) private readonly store: AbuseSignalStore,
    @Inject(ABUSE_POLICY) private readonly policy: AbusePolicyConfig,
    @Inject(ABUSE_RELEASE_BINDING)
    private readonly binding: AbuseReleaseBinding | null,
    @Inject(ABUSE_DETECTORS) private readonly detectors: AbuseDetector[],
    @Optional() @Inject(ABUSE_CLOCK) private readonly clock?: AbuseClock,
  ) {}

  private now(): number {
    return this.clock ? this.clock.now() : Date.now();
  }

  /**
   * Whether the request path has to consult this module at all.
   *
   * False while the module is observe-only, which is the default: detection
   * runs, nothing is refused, and the interceptor does no per-request work.
   */
  enforcementActive(): boolean {
    return this.policy.enabled && this.policy.enforcementEnabled;
  }

  /** The resolved policy, for callers that need the activation gates. */
  getPolicy(): AbusePolicyConfig {
    return this.policy;
  }

  /** The release binding actions are stamped with, or null when unbound. */
  getBinding(): AbuseReleaseBinding | null {
    return this.binding;
  }

  /**
   * Records one observation and returns the decision it produced.
   *
   * Observation is best-effort by design: losing a sample must never break live
   * traffic, so a store failure is reported as an indeterminate decision and
   * swallowed. Only the enforcement read below fails closed.
   */
  async observe(
    resolution: AbuseSubjectResolution,
    observation: AbuseObservation,
  ): Promise<AbuseDecision> {
    if (!resolution.attributed) {
      return this.indeterminate(resolution, AbuseIndeterminateReason.UNATTRIBUTED);
    }
    if (!this.policy.enabled) {
      return this.noSignal(resolution);
    }

    const now = this.now();
    try {
      await this.store.record(
        resolution.subject.key,
        resolution.subject.kind,
        observation,
        this.policy.windowMs,
        now,
      );
    } catch (error) {
      this.logger.error(
        `Abuse observation could not be recorded: ${(error as Error).message}`,
      );
      return this.indeterminate(
        resolution,
        AbuseIndeterminateReason.STORE_UNAVAILABLE,
      );
    }

    return this.evaluate(resolution, now);
  }

  /** Evaluates the subject's current window without recording anything. */
  async evaluate(
    resolution: AbuseSubjectResolution,
    now = this.now(),
  ): Promise<AbuseDecision> {
    if (!resolution.attributed) {
      return this.indeterminate(resolution, AbuseIndeterminateReason.UNATTRIBUTED);
    }
    if (!this.policy.enabled) return this.noSignal(resolution);
    if (!this.binding) {
      return this.indeterminate(
        resolution,
        AbuseIndeterminateReason.RELEASE_BINDING_INVALID,
      );
    }

    const { subject } = resolution;
    let window: AbuseSubjectWindow;
    try {
      window = await this.store.windowFor(
        subject.key,
        subject.kind,
        this.policy.windowMs,
        now,
      );
    } catch (error) {
      this.logger.error(
        `Abuse window could not be read: ${(error as Error).message}`,
      );
      return this.indeterminate(
        resolution,
        AbuseIndeterminateReason.STORE_UNAVAILABLE,
      );
    }

    if (window.total === 0) return this.noSignal(resolution);

    const maxDistinctSubjects = await this.maxDistinctSubjectsPerCredential(
      window,
      now,
    );

    const context: AbuseDetectorContext = {
      window: {
        reads: window.reads,
        writes: window.writes,
        authFailures: window.authFailures,
        authSuccesses: window.authSuccesses,
        distinctRoutes: window.distinctRoutes.length,
        distinctCredentials: window.distinctCredentials.length,
        credentialSaturationHit: window.credentialSaturationHit,
        routeSaturationHit: window.routeSaturationHit,
        duplicatePayloadRepeats:
          sumCounts(window.duplicatePayloadCounts) +
          window.duplicatePayloadOverflow,
        supportDuplicateRequests: window.supportDuplicateRequests,
        supportRequests: window.supportRequests,
        supportDistinctContacts: window.supportContacts.length,
        supportContactSaturationHit: window.supportContactSaturationHit,
        webhookEndpointWrites: window.webhookEndpointWrites,
        webhookSecretRotations: window.webhookSecretRotations,
        webhookDeliveries: window.webhookDeliveries,
        streamConnect: window.streamConnect,
        streamDisconnect: window.streamDisconnect,
        streamSubscribeOps: window.streamSubscribeOps,
        streamMessages: window.streamMessages,
      },
      sharedEgress: subject.kind === AbuseSubjectKind.NETWORK_PREFIX,
      maxDistinctSubjectsPerCredential: maxDistinctSubjects,
      appealPending: this.appealPending(subject.key),
    };

    const signals = this.detectors.flatMap((detector) =>
      // A detector that throws is isolated: one bad detector must not be able
      // to silence the others or to fail open on a subject it mis-scores.
      this.runDetector(detector, context),
    );

    if (signals.length === 0) return this.noSignal(resolution);

    const qualifying = this.qualifyingSignals(signals, context.sharedEgress);
    if (qualifying.length === 0) {
      return this.record(
        resolution,
        {
          outcome: AbuseDecisionOutcome.SUPPRESSED,
          reasonCode: AbuseReasonCode.INSUFFICIENT_CORROBORATION,
          signal: {
            kind: 'suppressed',
            reasonCode: AbuseReasonCode.INSUFFICIENT_CORROBORATION,
            dimension: 'corroboration',
            sampleCount: signals.length,
            confidence: 0,
          },
          corroboratingDimensions: new Set(
            signals.map((signal) => signal.dimension),
          ).size,
        },
        now,
        null,
      );
    }

    const chosen = this.highestSeverity(qualifying);
    const descriptor = describeReasonCode(chosen.reasonCode);

    if (!this.policy.enforcementEnabled) {
      return this.record(
        resolution,
        {
          outcome: AbuseDecisionOutcome.OBSERVED_ONLY,
          reasonCode: chosen.reasonCode,
          signal: chosen,
          corroboratingDimensions: new Set(
            qualifying.map((signal) => signal.dimension),
          ).size,
        },
        now,
        null,
      );
    }

    const action = await this.issueAction(
      resolution,
      chosen,
      descriptor.severity,
      now,
    );

    return this.record(
      resolution,
      {
        outcome: action
          ? AbuseDecisionOutcome.ACTIONED
          : AbuseDecisionOutcome.OBSERVED_ONLY,
        reasonCode: chosen.reasonCode,
        signal: chosen,
        corroboratingDimensions: new Set(
          qualifying.map((signal) => signal.dimension),
        ).size,
      },
      now,
      action,
    );
  }

  /**
   * Whether an action is currently in force for a subject.
   *
   * This is the read the request path depends on, so it **fails closed for an
   * attributable subject**: when the store is unreachable, or the release
   * binding that authorizes enforcement is missing, the result is
   * `indeterminate` and the caller denies with a bounded `Retry-After` rather
   * than assuming no action exists.
   *
   * An *unattributable* request is the one case that is not denied: actions are
   * keyed by subject, so "no verified subject" provably means "no action for
   * this request". That is a proof rather than a guess, and it keeps a store
   * outage from turning into a denial of all anonymous traffic.
   *
   * Expired actions are simply absent, which is how enforcement stops without
   * any operator intervention.
   */
  async enforcementFor(
    resolution: AbuseSubjectResolution,
    now = this.now(),
  ): Promise<AbuseEnforcementState> {
    if (!this.policy.enabled || !this.policy.enforcementEnabled) {
      return {
        enforced: false,
        indeterminate: false,
        action: null,
        retryAfterMs: null,
      };
    }
    if (!resolution.attributed) {
      return {
        enforced: false,
        indeterminate: false,
        action: null,
        retryAfterMs: null,
      };
    }
    if (!this.binding) {
      return {
        enforced: false,
        indeterminate: true,
        action: null,
        retryAfterMs: this.policy.maxActionDurationMs,
      };
    }

    let action: AbuseAction | null;
    try {
      action = await this.store.activeAction(resolution.subject.key, now);
    } catch (error) {
      this.logger.error(
        `Abuse enforcement read failed, failing closed: ${(error as Error).message}`,
      );
      return {
        enforced: false,
        indeterminate: true,
        action: null,
        retryAfterMs: this.policy.maxActionDurationMs,
      };
    }

    if (!action) {
      return {
        enforced: false,
        indeterminate: false,
        action: null,
        retryAfterMs: null,
      };
    }

    // An action issued under a different release/artifact may never be applied
    // to this deployment, even if its expiry has not passed.
    if (!this.sameBinding(action.binding, this.binding)) {
      this.logger.warn(
        'Ignoring abuse action issued under a different release binding',
      );
      return {
        enforced: false,
        indeterminate: false,
        action: null,
        retryAfterMs: null,
      };
    }

    const expiresAt = Date.parse(action.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return {
        enforced: false,
        indeterminate: false,
        action: null,
        retryAfterMs: null,
      };
    }

    return {
      enforced:
        action.kind === AbuseActionKind.THROTTLE ||
        action.kind === AbuseActionKind.CHALLENGE ||
        action.kind === AbuseActionKind.SUSPEND,
      indeterminate: false,
      action,
      retryAfterMs: Math.min(
        expiresAt - now,
        this.policy.maxActionDurationMs,
        ABUSE_HARD_MAX_ACTION_DURATION_MS,
      ),
    };
  }

  async getDecision(id: string): Promise<AbuseDecision | null> {
    return this.store.getDecision(id);
  }

  async listDecisions(
    filter?: AbuseDecisionFilter,
  ): Promise<AbuseDecision[]> {
    return this.store.listDecisions(filter);
  }

  /**
   * Marks every expired action as expired. Purely bookkeeping: enforcement
   * already ignores expired actions, so this exists so operators can see when
   * a bound ended rather than inferring it.
   *
   * Reads the *stored* action rather than the copy embedded in the decision,
   * so a second run finds nothing left to do instead of re-expiring the same
   * action forever.
   */
  async expireActions(now = this.now()): Promise<AbuseAction[]> {
    const expired: AbuseAction[] = [];
    for (const decision of await this.store.listDecisions({ limit: 500 })) {
      if (!decision.action) continue;
      const action = await this.store.getAction(decision.action.id);
      if (!action) continue;
      if (action.status !== AbuseActionStatus.ACTIVE) continue;
      if (Date.parse(action.expiresAt) > now) continue;
      const updated: AbuseAction = { ...action, status: AbuseActionStatus.EXPIRED };
      await this.store.putAction(updated);
      expired.push(updated);
    }
    return expired;
  }

  /** Marks an action lifted, ending enforcement before its bound. */
  async liftAction(actionId: string, now = this.now()): Promise<AbuseAction | null> {
    const action = await this.store.getAction(actionId);
    if (!action) return null;
    if (action.status !== AbuseActionStatus.ACTIVE) return action;
    if (Date.parse(action.expiresAt) <= now) return action;
    const lifted: AbuseAction = { ...action, status: AbuseActionStatus.LIFTED };
    await this.store.putAction(lifted);
    return lifted;
  }

  async findDecisionByAction(
    actionId: string,
  ): Promise<AbuseDecision | null> {
    const decisions = await this.store.listDecisions({ limit: 500 });
    return decisions.find((d) => d.action?.id === actionId) ?? null;
  }

/**
 * Escalation level: how many actions the subject already holds from *earlier*
 * windows.
 *
 * Counting windows rather than calls is what keeps a single abusive window
 * stable. `evaluate()` runs on every observed request, so counting evaluate
 * calls would walk a scraper up the ladder within seconds. Counting actions
 * from earlier windows means escalation needs repeated, separated abuse —
 * which is also what a reviewer can explain — and the cap in `issueAction`
 * keeps it finite.
 */
async priorWindowActionCount(
    subjectKey: string,
    now = this.now(),
  ): Promise<number> {
    return this.store.actionsStartedBefore(
      subjectKey,
      windowStartFor(now, this.policy.windowMs),
    );
  }

  private async maxDistinctSubjectsPerCredential(
    window: { distinctCredentials: string[] },
    now: number,
  ): Promise<number> {
    let max = 0;
    for (const fingerprint of window.distinctCredentials) {
      try {
        const count = await this.store.distinctSubjectsForCredential(
          fingerprint,
          this.policy.windowMs,
          now,
        );
        if (count > max) max = count;
      } catch (error) {
        this.logger.error(
          `Credential spread lookup failed, failing closed for that dimension: ${
            (error as Error).message
          }`,
        );
        return 0;
      }
    }
    return max;
  }

  /** An appeal freezes escalation; injectable so appeals can pin the level. */
  private pinnedEscalation = new Map<string, number>();

  /** An open appeal pins the escalation level; see {@link pinEscalation}. */
  private appealPending(subjectKey: string): boolean {
    return this.pinnedEscalation.has(subjectKey);
  }

  /**
   * Pins a subject's escalation level while an appeal is open.
   *
   * Pinning, rather than lifting, is deliberate: an appeal must blunt a
   * decision without becoming an immunity button an abuser can press.
   */
  pinEscalation(subjectKey: string, level: number): void {
    this.pinnedEscalation.set(subjectKey, level);
  }

  /** Releases a pin once the appeal has been decided. */
  releaseEscalation(subjectKey: string): void {
    this.pinnedEscalation.delete(subjectKey);
  }

  private runDetector(
    detector: AbuseDetector,
    context: AbuseDetectorContext,
  ): AbuseSignal[] {
    try {
      return detector.evaluate(context) ?? [];
    } catch (error) {
      this.logger.error(
        `Abuse detector ${detector.id} failed and was skipped: ${
          (error as Error).message
        }`,
      );
      return [];
    }
  }

  /**
   * Keeps only signals backed by enough independent dimensions.
   *
   * Dimensions are counted per abuse kind, because two different kinds
   * agreeing is weaker evidence than one kind agreeing with itself. A shared
   * egress subject always needs at least two, no matter what the registry says,
   * so a single measure can never punish a whole NAT.
   */
  private qualifyingSignals(
    signals: AbuseSignal[],
    sharedEgress: boolean,
  ): AbuseSignal[] {
    const byKind = new Map<string, Set<string>>();
    for (const signal of signals) {
      const set = byKind.get(signal.kind) ?? new Set<string>();
      set.add(signal.dimension);
      byKind.set(signal.kind, set);
    }
    return signals.filter((signal) => {
      const required = Math.max(
        describeReasonCode(signal.reasonCode).minCorroboratingDimensions,
        sharedEgress ? SHARED_EGRESS_MIN_DIMENSIONS : 1,
      );
      return (byKind.get(signal.kind)?.size ?? 0) >= required;
    });
  }

  private highestSeverity(signals: AbuseSignal[]): AbuseSignal {
    return signals.reduce((best, signal) => {
      const bestRank = SEVERITY_RANK[describeReasonCode(best.reasonCode).severity];
      const rank = SEVERITY_RANK[describeReasonCode(signal.reasonCode).severity];
      return rank > bestRank ? signal : best;
    }, signals[0]);
  }

  /**
   * Issues a bounded action, or returns null when issuing one would breach a
   * bound.
   *
   * Escalation level counts the windows in which the subject was already
   * actioned inside the trailing period, capped by
   * `maxActionsPerSubjectPerWindow` and pinned while an appeal is open.
   * Duration grows with the level but is always clamped by the policy maximum
   * and the hard ceiling.
   */
  private async issueAction(
    resolution: AttributedResolution,
    signal: AbuseSignal,
    severity: AbuseSeverity,
    now: number,
  ): Promise<AbuseAction | null> {
    const { subject } = resolution;
    if (!this.binding) return null;

    const issued = await this.priorWindowActionCount(subject.key, now);
    const pinned = this.pinnedEscalation.get(subject.key);
    const level = Math.min(
      pinned ?? Math.max(0, issued),
      this.policy.maxActionsPerSubjectPerWindow,
    );

    const kind =
      level === 0
        ? FIRST_ACTION[severity]
        : ABUSE_ACTION_LADDER[
            Math.min(
              ABUSE_ACTION_LADDER.indexOf(FIRST_ACTION[severity]) + level,
              ABUSE_ACTION_LADDER.length - 1,
            )
          ];

    const durationMs = Math.min(
      BASE_ACTION_DURATION_MS[severity] * Math.pow(2, level),
      this.policy.maxActionDurationMs,
      ABUSE_HARD_MAX_ACTION_DURATION_MS,
    );

    const startedAt = now;
    const expiresAt = now + durationMs;
    if (!(expiresAt > startedAt)) return null;

    const windowStart = windowStartFor(now, this.policy.windowMs);
    const id = deterministicId(
      subject.key,
      signal.reasonCode,
      windowStart,
      level,
    );

    const action: AbuseAction = {
      id,
      subjectKey: subject.key,
      subjectKind: subject.kind,
      kind,
      status: AbuseActionStatus.ACTIVE,
      reasonCode: signal.reasonCode,
      reasonCodeVersion: describeReasonCode(signal.reasonCode).version,
      modelVersion: ABUSE_MODEL_VERSION,
      configVersion: ABUSE_CONFIG_VERSION,
      binding: this.binding,
      costMultiplier: kind === AbuseActionKind.THROTTLE ? 4 : 1,
      startedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      appealable: true,
      escalationLevel: level,
    };

    await this.store.putAction(action);
    return action;
  }

  private sameBinding(
    a: AbuseReleaseBinding,
    b: AbuseReleaseBinding,
  ): boolean {
    return (
      a.chainId === b.chainId &&
      a.releaseId === b.releaseId &&
      a.deploymentBlock === b.deploymentBlock &&
      a.artifactChecksum === b.artifactChecksum
    );
  }

  private async record(
    resolution: AttributedResolution,
    payload: {
      outcome: AbuseDecisionOutcome;
      reasonCode: AbuseReasonCode;
      signal: RecordedSignal;
      corroboratingDimensions: number;
    },
    now: number,
    action: AbuseAction | null,
  ): Promise<AbuseDecision> {
    const { subject } = resolution;
    const descriptor = describeReasonCode(payload.reasonCode);
    const windowStart = windowStartFor(now, this.policy.windowMs);

    const decision: AbuseDecision = {
      id: deterministicId(
        subject.key,
        payload.reasonCode,
        windowStart,
        action?.escalationLevel ?? 0,
      ),
      subjectKey: subject.key,
      subjectKind: subject.kind,
      outcome: payload.outcome,
      indeterminateReason: null,
      reasonCode: payload.reasonCode,
      reasonCodeVersion: descriptor.version,
      kind:
        descriptor.kind === 'suppressed'
          ? null
          : (payload.signal.kind as AbuseSignalKind),
      severity: descriptor.severity,
      confidence: payload.signal.confidence,
      sampleCount: payload.signal.sampleCount,
      corroboratingDimensions: payload.corroboratingDimensions,
      modelVersion: ABUSE_MODEL_VERSION,
      configVersion: ABUSE_CONFIG_VERSION,
      binding: this.binding,
      action,
      decidedAt: new Date(now).toISOString(),
    };

    try {
      await this.store.recordDecision(decision);
    } catch (error) {
      this.logger.error(
        `Abuse decision could not be persisted: ${(error as Error).message}`,
      );
    }
    return decision;
  }

  private noSignal(resolution: AttributedResolution): AbuseDecision {
    return this.baseDecision(resolution, {
      outcome: AbuseDecisionOutcome.NO_SIGNAL,
      indeterminateReason: null,
      reasonCode: null,
      signal: null,
      action: null,
    });
  }

  private indeterminate(
    resolution: AbuseSubjectResolution,
    reason: AbuseIndeterminateReason,
  ): AbuseDecision {
    return this.baseDecision(resolution, {
      outcome: AbuseDecisionOutcome.INDETERMINATE,
      indeterminateReason: reason,
      reasonCode: null,
      signal: null,
      action: null,
    });
  }

  private baseDecision(
    resolution: AbuseSubjectResolution,
    payload: {
      outcome: AbuseDecisionOutcome;
      indeterminateReason: AbuseIndeterminateReason | null;
      reasonCode: AbuseReasonCode | null;
      signal: RecordedSignal | null;
      action: AbuseAction | null;
    },
  ): AbuseDecision {
    const now = this.now();
    const subject = resolution.attributed
      ? resolution.subject
      : { kind: AbuseSubjectKind.NETWORK_PREFIX, key: 'unattributed' };
    const descriptor = payload.reasonCode
      ? describeReasonCode(payload.reasonCode)
      : null;

    return {
      id: deterministicId(
        subject.key,
        payload.reasonCode ?? payload.outcome,
        windowStartFor(now, this.policy.windowMs),
        0,
      ),
      subjectKey: subject.key,
      subjectKind: subject.kind,
      outcome: payload.outcome,
      indeterminateReason: payload.indeterminateReason,
      reasonCode: payload.reasonCode,
      reasonCodeVersion: descriptor?.version ?? null,
      kind:
        payload.signal?.kind === 'suppressed' || !payload.signal
          ? null
          : payload.signal.kind,
      severity: descriptor?.severity ?? null,
      confidence: payload.signal?.confidence ?? 0,
      sampleCount: payload.signal?.sampleCount ?? 0,
      corroboratingDimensions: 0,
      modelVersion: ABUSE_MODEL_VERSION,
      configVersion: ABUSE_CONFIG_VERSION,
      binding: this.binding,
      action: payload.action,
      decidedAt: new Date(now).toISOString(),
    };
  }
}

/** Sums the repeat counts of every tracked payload fingerprint. */
function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}

/**
 * Deterministic decision id.
 *
 * Two replicas that observe the same subject, reason code and window produce
 * the same id, so recording a decision is idempotent across the fleet instead
 * of depending on which replica happened to be first.
 */
function deterministicId(
  subjectKey: string,
  reasonCode: string,
  windowStart: number,
  escalationLevel: number,
): string {
  return createHash('sha256')
    .update(
      [
        ABUSE_MODEL_VERSION,
        ABUSE_CONFIG_VERSION,
        subjectKey,
        reasonCode,
        windowStart,
        escalationLevel,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 32);
}