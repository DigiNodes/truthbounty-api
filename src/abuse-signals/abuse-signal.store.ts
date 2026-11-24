import {
  AbuseAction,
  AbuseActionStatus,
  AbuseDecision,
  AbuseObservation,
  AbuseObservationKind,
  AbuseSubjectKind,
  AbuseSubjectWindow,
  AbuseSurface,
  ABUSE_WINDOW_LIMITS,
} from './abuse-signals.types';

/**
 * Persistence seam for abuse signals (PREWAVE-BE-086, #681).
 *
 * Two responsibilities, both bound through this one interface so the whole
 * module has a single replaceable dependency:
 *
 *  - **Windows.** Per-subject aggregates for the current evaluation window.
 *    Because the aggregate is keyed by subject and window rather than held in
 *    request scope, two replicas fed the same observations converge on the same
 *    counters — which is what makes detection work across a fleet.
 *  - **Decisions and actions.** Every decision and every bounded action, so an
 *    appeal filed on one replica can be seen by another, and so an action
 *    survives the process that created it.
 *
 * The default {@link InMemoryAbuseSignalStore} keeps the module free of any new
 * external dependency while it is in observe-only mode. Deployments that turn
 * enforcement on bind a shared implementation to {@link ABUSE_SIGNAL_STORE};
 * until then nothing here is a single point of failure for live traffic.
 */

/** Injection token for the abuse signal store. */
export const ABUSE_SIGNAL_STORE = Symbol('ABUSE_SIGNAL_STORE');

/** Filter for listing decisions. */
export interface AbuseDecisionFilter {
  subjectKey?: string;
  outcome?: AbuseDecision['outcome'];
  limit?: number;
}

export interface AbuseSignalStore {
  /** Folds one observation into the subject's window and returns the result. */
  record(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    observation: AbuseObservation,
    windowMs: number,
    now: number,
  ): Promise<AbuseSubjectWindow>;

  /** Reads the current window without mutating it. */
  windowFor(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    windowMs: number,
    now: number,
  ): Promise<AbuseSubjectWindow>;

  /**
   * Distinct subjects that presented one credential fingerprint inside the
   * window. Backs the "one credential, many subjects" credential-stuffing
   * signal without any replica needing local state.
   */
  distinctSubjectsForCredential(
    credentialFingerprint: string,
    windowMs: number,
    now: number,
  ): Promise<number>;

  recordDecision(decision: AbuseDecision): Promise<void>;
  getDecision(id: string): Promise<AbuseDecision | null>;
  listDecisions(filter?: AbuseDecisionFilter): Promise<AbuseDecision[]>;

  /**
   * The action currently in force for a subject at `now`, or null. Expired
   * actions are treated as absent, which is what stops enforcement without any
   * operator intervention.
   */
  activeAction(subjectKey: string, now: number): Promise<AbuseAction | null>;
  putAction(action: AbuseAction): Promise<void>;
  getAction(actionId: string): Promise<AbuseAction | null>;
  actionsFor(subjectKey: string): Promise<AbuseAction[]>;
  /** Number of the subject's actions whose `startedAt` is strictly before `beforeMs`. */
  actionsStartedBefore(subjectKey: string, beforeMs: number): Promise<number>;
}

interface WindowEntry {
  subjectKey: string;
  subjectKind: AbuseSubjectKind;
  windowStart: number;
  windowMs: number;
  observations: AbuseObservation[];
  subjectCountByCredential: Map<string, Set<string>>;
  window: AbuseSubjectWindow;
}

function emptyWindow(
  subjectKey: string,
  subjectKind: AbuseSubjectKind,
  windowStart: number,
  windowMs: number,
): AbuseSubjectWindow {
  return {
    subjectKey,
    subjectKind,
    windowStart,
    windowMs,
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
}

/** Fixed-window start, so every replica agrees on which window it is in. */
export function windowStartFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function addDistinct(
  list: string[],
  seen: Set<string>,
  value: string,
): { saturated: boolean } {
  if (seen.has(value)) return { saturated: false };
  if (list.length >= ABUSE_WINDOW_LIMITS.distinctCap) {
    return { saturated: true };
  }
  seen.add(value);
  list.push(value);
  return { saturated: false };
}

/**
 * Bounded in-process store.
 *
 * Bounded on every axis (windows, observations per window, decisions, actions)
 * so a long-running process cannot be grown without limit. Entries are evicted
 * oldest-first. Deployments that enable enforcement across more than one
 * replica bind a shared implementation to {@link ABUSE_SIGNAL_STORE}; the
 * interface is the same, so nothing above this line changes.
 */
export class InMemoryAbuseSignalStore implements AbuseSignalStore {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly decisions = new Map<string, AbuseDecision>();
  private readonly actions = new Map<string, AbuseAction>();
  private readonly decisionOrder: string[] = [];
  private readonly actionOrder: string[] = [];

  constructor(
    private readonly limits = {
      windows: 10_000,
      decisions: 5_000,
      actions: 5_000,
    },
  ) {}

  record(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    observation: AbuseObservation,
    windowMs: number,
    now: number,
  ): Promise<AbuseSubjectWindow> {
    const windowStart = windowStartFor(now, windowMs);
    const entry = this.entryFor(subjectKey, subjectKind, windowStart, windowMs);
    this.apply(entry, observation);
    return Promise.resolve(this.snapshot(entry));
  }

  windowFor(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    windowMs: number,
    now: number,
  ): Promise<AbuseSubjectWindow> {
    const windowStart = windowStartFor(now, windowMs);
    const existing = this.windows.get(subjectKey);
    if (!existing || existing.windowStart !== windowStart) {
      return Promise.resolve(
        emptyWindow(subjectKey, subjectKind, windowStart, windowMs),
      );
    }
    return Promise.resolve(this.snapshot(existing));
  }

  distinctSubjectsForCredential(
    credentialFingerprint: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const windowStart = windowStartFor(now, windowMs);
    let count = 0;
    for (const entry of this.windows.values()) {
      if (entry.windowStart !== windowStart) continue;
      count +=
        entry.subjectCountByCredential.get(credentialFingerprint)?.size ?? 0;
    }
    return Promise.resolve(count);
  }

  recordDecision(decision: AbuseDecision): Promise<void> {
    if (!this.decisions.has(decision.id)) this.decisionOrder.push(decision.id);
    this.decisions.set(decision.id, decision);
    this.evict('decisions', this.limits.decisions);
    return Promise.resolve();
  }

  getDecision(id: string): Promise<AbuseDecision | null> {
    return Promise.resolve(this.decisions.get(id) ?? null);
  }

  listDecisions(
    filter: AbuseDecisionFilter = {},
  ): Promise<AbuseDecision[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const items: AbuseDecision[] = [];
    for (let i = this.decisionOrder.length - 1; i >= 0; i -= 1) {
      const decision = this.decisions.get(this.decisionOrder[i]);
      if (!decision) continue;
      if (filter.subjectKey && decision.subjectKey !== filter.subjectKey) continue;
      if (filter.outcome && decision.outcome !== filter.outcome) continue;
      items.push(decision);
      if (items.length >= limit) break;
    }
    return Promise.resolve(items);
  }

  /**
   * The action currently in force for a subject at `now`, or null.
   *
   * Expired actions are treated as absent, which is what stops enforcement with
   * no operator intervention, and an action that is no longer `ACTIVE` (lifted
   * by an approved appeal, superseded by a newer one) is never returned.
   */
  activeAction(
    subjectKey: string,
    now: number,
  ): Promise<AbuseAction | null> {
    const action = this.currentAction(subjectKey);
    if (!action) return Promise.resolve(null);
    if (action.status !== AbuseActionStatus.ACTIVE) return Promise.resolve(null);
    if (Date.parse(action.expiresAt) <= now) return Promise.resolve(null);
    return Promise.resolve(action);
  }

  putAction(action: AbuseAction): Promise<void> {
    if (!this.actions.has(action.id)) this.actionOrder.push(action.id);
    this.actions.set(action.id, action);
    this.evict('actions', this.limits.actions);
    return Promise.resolve();
  }

  getAction(actionId: string): Promise<AbuseAction | null> {
    return Promise.resolve(this.actions.get(actionId) ?? null);
  }

  actionsFor(subjectKey: string): Promise<AbuseAction[]> {
    return Promise.resolve(
      [...this.actions.values()].filter(
        (action) => action.subjectKey === subjectKey,
      ),
    );
  }

  actionsStartedBefore(
    subjectKey: string,
    beforeMs: number,
  ): Promise<number> {
    const actions = [...this.actions.values()].filter(
      (action) => action.subjectKey === subjectKey,
    );
    return Promise.resolve(
      actions.filter((action) => Date.parse(action.startedAt) < beforeMs).length,
    );
  }

  /** Most recent action for a subject regardless of expiry. */
  private currentAction(subjectKey: string): AbuseAction | null {
    let newest: AbuseAction | null = null;
    for (const action of this.actions.values()) {
      if (action.subjectKey !== subjectKey) continue;
      if (!newest || Date.parse(action.startedAt) > Date.parse(newest.startedAt)) {
        newest = action;
      }
    }
    return newest;
  }

  private entryFor(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    windowStart: number,
    windowMs: number,
  ): WindowEntry {
    const existing = this.windows.get(subjectKey);
    if (existing && existing.windowStart === windowStart) return existing;

    const entry: WindowEntry = {
      subjectKey,
      subjectKind,
      windowStart,
      windowMs,
      observations: [],
      subjectCountByCredential: new Map(),
      window: emptyWindow(subjectKey, subjectKind, windowStart, windowMs),
    };
    this.windows.set(subjectKey, entry);
    this.evict('windows', this.limits.windows);
    return entry;
  }

  private apply(entry: WindowEntry, observation: AbuseObservation): void {
    const win = entry.window;
    win.total += 1;

    const routes = new Set(win.distinctRoutes);
    if (addDistinct(win.distinctRoutes, routes, observation.routeGroup).saturated) {
      win.routeSaturationHit = true;
    }

    if (observation.credentialFingerprint) {
      const credentials = new Set(win.distinctCredentials);
      if (
        addDistinct(
          win.distinctCredentials,
          credentials,
          observation.credentialFingerprint,
        ).saturated
      ) {
        win.credentialSaturationHit = true;
      }
      let subjects = entry.subjectCountByCredential.get(
        observation.credentialFingerprint,
      );
      if (!subjects) {
        subjects = new Set<string>();
        entry.subjectCountByCredential.set(observation.credentialFingerprint, subjects);
      }
      subjects.add(entry.subjectKey);
      win.subjectsPerCredential.set(
        observation.credentialFingerprint,
        subjects.size,
      );
    }

    if (observation.payloadFingerprint) {
      const fp = observation.payloadFingerprint;
      const previous = win.duplicatePayloadCounts.get(fp);
      if (previous === undefined) {
        if (win.duplicatePayloadCounts.size < ABUSE_WINDOW_LIMITS.payloadCap) {
          win.duplicatePayloadCounts.set(fp, 0);
        } else {
          win.duplicatePayloadOverflow += 1;
        }
      } else {
        win.duplicatePayloadCounts.set(fp, previous + 1);
      }
    }

    if (entry.observations.length < ABUSE_WINDOW_LIMITS.observationsPerSubject) {
      entry.observations.push(observation);
    }

    switch (observation.kind) {
      case AbuseObservationKind.READ:
        win.reads += 1;
        break;
      case AbuseObservationKind.WRITE:
        win.writes += 1;
        break;
      case AbuseObservationKind.AUTH_FAILURE:
        win.authFailures += 1;
        break;
      case AbuseObservationKind.AUTH_SUCCESS:
        win.authSuccesses += 1;
        break;
      case AbuseObservationKind.WEBHOOK_ENDPOINT_WRITE:
        win.webhookEndpointWrites += 1;
        break;
      case AbuseObservationKind.WEBHOOK_SECRET_ROTATION:
        win.webhookSecretRotations += 1;
        break;
      case AbuseObservationKind.WEBHOOK_DELIVERY:
        win.webhookDeliveries += 1;
        break;
      case AbuseObservationKind.STREAM_CONNECT:
        win.streamConnect += 1;
        break;
      case AbuseObservationKind.STREAM_DISCONNECT:
        win.streamDisconnect += 1;
        break;
      case AbuseObservationKind.STREAM_SUBSCRIBE:
        win.streamSubscribeOps += 1;
        break;
      case AbuseObservationKind.STREAM_MESSAGE:
        win.streamMessages += 1;
        break;
      default:
        break;
    }

    if (observation.surface === AbuseSurface.SUPPORT) {
      win.supportRequests += 1;
      const contacts = new Set(win.supportContacts);
      addDistinct(
        win.supportContacts,
        contacts,
        observation.routeGroup,
      );
      if (win.supportContacts.length >= ABUSE_WINDOW_LIMITS.distinctCap) {
        win.supportContactSaturationHit = true;
      }
      const fp = observation.payloadFingerprint;
      if (fp) {
        const prior = win.supportDuplicateCounts.get(fp);
        if (prior === undefined) {
          if (win.supportDuplicateCounts.size < ABUSE_WINDOW_LIMITS.payloadCap) {
            win.supportDuplicateCounts.set(fp, 0);
          }
        } else {
          win.supportDuplicateCounts.set(fp, prior + 1);
          win.supportDuplicateRequests += 1;
        }
      }
    }
  }

  /** Defensive copy so callers cannot mutate stored aggregates. */
  private snapshot(entry: WindowEntry): AbuseSubjectWindow {
    const win = entry.window;
    return {
      ...win,
      distinctRoutes: [...win.distinctRoutes],
      distinctCredentials: [...win.distinctCredentials],
      supportContacts: [...win.supportContacts],
      duplicatePayloadCounts: new Map(win.duplicatePayloadCounts),
      duplicatePayloadOverflow: win.duplicatePayloadOverflow,
      supportDuplicateCounts: new Map(win.supportDuplicateCounts),
      subjectsPerCredential: new Map(win.subjectsPerCredential),
    };
  }

  private evict(
    bucket: 'windows' | 'decisions' | 'actions',
    limit: number,
  ): void {
    const map =
      bucket === 'windows'
        ? (this.windows as Map<string, unknown>)
        : bucket === 'decisions'
          ? (this.decisions as Map<string, unknown>)
          : (this.actions as Map<string, unknown>);
    // Maps preserve insertion order, so the first key is the oldest entry.
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
      if (bucket === 'decisions') {
        const index = this.decisionOrder.indexOf(oldest.value);
        if (index !== -1) this.decisionOrder.splice(index, 1);
      }
      if (bucket === 'actions') {
        const index = this.actionOrder.indexOf(oldest.value);
        if (index !== -1) this.actionOrder.splice(index, 1);
      }
    }
  }
}