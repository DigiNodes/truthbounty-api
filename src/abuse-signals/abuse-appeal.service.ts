import { Inject, Injectable, Logger } from '@nestjs/common';
import { PublicErrorCode } from '../common/constants/error-codes';
import { AbuseSignalService } from './abuse-signal.service';
import { AbuseAction, AbuseSubjectResolution } from './abuse-signals.types';

/**
 * Appeal workflow for abuse actions (PREWAVE-BE-086, #681).
 *
 * Every automated action is appealable, and the appeal path is deliberately
 * bounded in both directions:
 *
 *  - **Bounded for the appellant.** At most {@link AbuseAppealPolicy.maxOpenAppealsPerSubject}
 *    open appeals per subject, each with a review deadline. Filing appeals in a
 *    loop cannot manufacture a review queue.
 *  - **Bounded for the accused.** Filing an appeal does **not** lift the
 *    action. It pins the escalation level, so the next decision can renew the
 *    existing bound but can never grow it. Immunity-by-appeal would be an abuse
 *    channel; blunting escalation is not.
 *  - **Bounded by time.** If nobody reviews it, the appeal expires at its SLA
 *    and the pin is released. Nothing waits on a human forever.
 *
 * Only an authenticated administrator may decide an appeal. There is no
 * self-service lift and no path from this module to protocol state.
 */

export enum AbuseAppealStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

export interface AbuseAppealPolicy {
  /** Review deadline after submission. */
  reviewSlaMs: number;
  /** Open appeals allowed per subject at once. */
  maxOpenAppealsPerSubject: number;
}

export const DEFAULT_ABUSE_APPEAL_POLICY: AbuseAppealPolicy = Object.freeze({
  reviewSlaMs: 72 * 60 * 60 * 1000,
  maxOpenAppealsPerSubject: 2,
});

/** An appeal, as recorded. */
export interface AbuseAppeal {
  id: string;
  actionId: string;
  subjectKey: string;
  reason: string;
  status: AbuseAppealStatus;
  submittedAt: string;
  reviewDueAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

/** Failure carrying a canonical code; surfaced as an HTTP error by the board. */
export class AbuseAppealError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: PublicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AbuseAppealError';
  }
}

export interface SubmitAbuseAppealInput {
  resolution: AbuseSubjectResolution;
  actionId: string;
  reason: string;
}

export interface DecideAbuseAppealInput {
  appealId: string;
  approved: boolean;
  reviewerId: string;
  note?: string;
}

const MAX_REASON_LENGTH = 500;

/**
 * In-process appeal register.
 *
 * Bounded like every other store in this module. A deployment that needs
 * appeals to outlive a restart binds a persistent implementation behind the
 * same interface; nothing above this line changes.
 */
export class InMemoryAbuseAppealRegister {
  private readonly appeals = new Map<string, AbuseAppeal>();
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly order: string[] = [];

  constructor(private readonly limit = 10_000) {}

  put(appeal: AbuseAppeal): void {
    if (!this.appeals.has(appeal.id)) {
      this.order.push(appeal.id);
      let ids = this.bySubject.get(appeal.subjectKey);
      if (!ids) {
        ids = new Set<string>();
        this.bySubject.set(appeal.subjectKey, ids);
      }
      ids.add(appeal.id);
    }
    this.appeals.set(appeal.id, appeal);
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (!oldest) break;
      const evicted = this.appeals.get(oldest);
      this.appeals.delete(oldest);
      if (evicted) {
        this.bySubject.get(evicted.subjectKey)?.delete(oldest);
      }
    }
  }

  get(id: string): AbuseAppeal | null {
    return this.appeals.get(id) ?? null;
  }

  list(filter?: { subjectKey?: string; status?: AbuseAppealStatus }): AbuseAppeal[] {
    const items: AbuseAppeal[] = [];
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const appeal = this.appeals.get(this.order[i]);
      if (!appeal) continue;
      if (filter?.subjectKey && appeal.subjectKey !== filter.subjectKey) continue;
      if (filter?.status && appeal.status !== filter.status) continue;
      items.push(appeal);
    }
    return items;
  }

  countOpen(subjectKey: string): number {
    const ids = this.bySubject.get(subjectKey);
    if (!ids) return 0;
    let open = 0;
    for (const id of ids) {
      const appeal = this.appeals.get(id);
      if (appeal && appeal.status === AbuseAppealStatus.PENDING) open += 1;
    }
    return open;
  }
}

/** Injection token for the appeal register. */
export const ABUSE_APPEAL_REGISTER = Symbol('ABUSE_APPEAL_REGISTER');

/** Injection token for the appeal policy. */
export const ABUSE_APPEAL_POLICY = Symbol('ABUSE_APPEAL_POLICY');

@Injectable()
export class AbuseAppealService {
  private readonly logger = new Logger(AbuseAppealService.name);

  constructor(
    private readonly signals: AbuseSignalService,
    @Inject(ABUSE_APPEAL_REGISTER)
    private readonly register: InMemoryAbuseAppealRegister,
    @Inject(ABUSE_APPEAL_POLICY)
    private readonly policy: AbuseAppealPolicy = DEFAULT_ABUSE_APPEAL_POLICY,
  ) {}

  /**
   * Files an appeal against a subject's own active action.
   *
   * The appellant must resolve to the same subject the action was issued to —
   * there is no "appeal someone else's action" path.
   */
  async submitAppeal(
    input: SubmitAbuseAppealInput,
    now = Date.now(),
  ): Promise<AbuseAppeal> {
    if (!input.resolution.attributed) {
      throw new AbuseAppealError(
        403,
        PublicErrorCode.FORBIDDEN,
        'An appeal requires an authenticated identity.',
      );
    }

    const reason = (input.reason ?? '').trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      throw new AbuseAppealError(
        400,
        PublicErrorCode.BAD_REQUEST,
        'An appeal reason is required.',
      );
    }

    const subjectKey = input.resolution.subject.key;
    const decision = await this.signals.findDecisionByAction(input.actionId);
    const action: AbuseAction | null = decision?.action ?? null;
    if (!action || action.subjectKey !== subjectKey) {
      throw new AbuseAppealError(
        404,
        PublicErrorCode.NOT_FOUND,
        'No active action was found for this account.',
      );
    }

    const existing = this.register
      .list({ subjectKey })
      .find(
        (appeal) =>
          appeal.actionId === action.id &&
          appeal.status === AbuseAppealStatus.PENDING,
      );
    if (existing) {
      throw new AbuseAppealError(
        409,
        PublicErrorCode.CONFLICT,
        'An appeal for this action is already under review.',
      );
    }

    this.releaseExpiredAppeals(subjectKey, now);
    if (
      this.register.countOpen(subjectKey) >=
      this.policy.maxOpenAppealsPerSubject
    ) {
      throw new AbuseAppealError(
        429,
        PublicErrorCode.RATE_LIMITED,
        'Too many open appeals. Please wait for a decision.',
      );
    }

    const appeal: AbuseAppeal = {
      id: `appeal-${subjectKey.slice(0, 12)}-${action.id}`,
      actionId: action.id,
      subjectKey,
      reason,
      status: AbuseAppealStatus.PENDING,
      submittedAt: new Date(now).toISOString(),
      reviewDueAt: new Date(now + this.policy.reviewSlaMs).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
    };

    this.register.put(appeal);
    // Pin escalation so the appeal is worth filing, without granting immunity.
    this.signals.pinEscalation(subjectKey, action.escalationLevel);
    this.logger.log(
      `Abuse appeal filed for action ${action.id}; escalation pinned at ${action.escalationLevel}`,
    );
    return appeal;
  }

  /** Lists appeals, optionally filtered. */
  listAppeals(filter?: {
    subjectKey?: string;
    status?: AbuseAppealStatus;
  }): AbuseAppeal[] {
    return this.register.list(filter);
  }

  getAppeal(id: string): AbuseAppeal | null {
    return this.register.get(id);
  }

  /**
   * Decides an appeal.
   *
   * Authorization is the caller's responsibility to establish before this is
   * invoked; an empty reviewer id is refused fail-closed rather than recorded
   * as an anonymous decision.
   */
  async decideAppeal(
    input: DecideAbuseAppealInput,
    now = Date.now(),
  ): Promise<AbuseAppeal> {
    const reviewerId = (input.reviewerId ?? '').trim();
    if (!reviewerId) {
      throw new AbuseAppealError(
        403,
        PublicErrorCode.FORBIDDEN,
        'A reviewer identity is required.',
      );
    }

    const appeal = this.register.get(input.appealId);
    if (!appeal) {
      throw new AbuseAppealError(
        404,
        PublicErrorCode.NOT_FOUND,
        'The appeal was not found.',
      );
    }
    if (appeal.status !== AbuseAppealStatus.PENDING) {
      throw new AbuseAppealError(
        409,
        PublicErrorCode.CONFLICT,
        'The appeal has already been decided.',
      );
    }

    const decided: AbuseAppeal = {
      ...appeal,
      status: input.approved ? AbuseAppealStatus.APPROVED : AbuseAppealStatus.REJECTED,
      decidedAt: new Date(now).toISOString(),
      decidedBy: reviewerId,
      decisionNote: (input.note ?? '').slice(0, MAX_REASON_LENGTH) || null,
    };

    if (input.approved) {
      await this.signals.liftAction(appeal.actionId, now);
    }
    this.signals.releaseEscalation(appeal.subjectKey);
    this.register.put(decided);
    return decided;
  }

  /**
   * Expires overdue appeals and releases their pins.
   *
   * This is the recovery path: an appeal nobody reviewed stops holding the
   * subject's escalation level once its SLA passes, without operator action.
   */
  releaseExpiredAppeals(subjectKey: string, now = Date.now()): AbuseAppeal[] {
    const released: AbuseAppeal[] = [];
    for (const appeal of this.register.list({ subjectKey })) {
      if (appeal.status !== AbuseAppealStatus.PENDING) continue;
      if (Date.parse(appeal.reviewDueAt) > now) continue;
      const expired: AbuseAppeal = {
        ...appeal,
        status: AbuseAppealStatus.EXPIRED,
        decidedAt: new Date(now).toISOString(),
        decisionNote: 'Review SLA elapsed without a decision.',
      };
      this.signals.releaseEscalation(subjectKey);
      this.register.put(expired);
      released.push(expired);
    }
    return released;
  }
}