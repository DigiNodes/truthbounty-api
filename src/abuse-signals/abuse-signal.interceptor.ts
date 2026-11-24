import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { PublicErrorCode } from '../common/constants/error-codes';
import { AbuseSignalService } from './abuse-signal.service';
import { ABUSE_POLICY, AbusePolicyConfig } from './abuse-signals.config';
import {
  AbuseRequestLike,
  identityInputFromRequest,
  resolveAbuseSubject,
} from './abuse-subject';
import { AbuseActionKind } from './abuse-signals.types';
import {
  isScoredRoute,
  observationFromRequest,
  routeGroupFor,
} from './abuse-signals.util';

/**
 * Request-path observer and enforcer (PREWAVE-BE-086, #681).
 *
 * Two responsibilities, deliberately ordered so telemetry can never become an
 * availability problem:
 *
 *  1. **Observe** every scored request. Fire-and-forget: the response is never
 *     delayed by detection, and a store failure drops the sample rather than
 *     failing the request.
 *  2. **Enforce** only once a maintainer has enabled enforcement *and* an
 *     action is in force. Enforcement is awaited, because it is the one place
 *     where this module is allowed to say no, and it denies with the canonical
 *     {@link PublicErrorCode.RATE_LIMITED} plus a bounded `Retry-After`.
 *
 * **Nothing sensitive crosses this boundary.** The denial body carries no reason
 * code, no detector identity, no threshold, no subject key and no signal
 * counts: a client learns only that it must wait, and for how long. Heuristic
 * detail stays on the admin plane.
 *
 * **No protocol authority.** The interceptor reads the request, writes abuse
 * observations and returns `HttpException`s. It cannot settle, resolve, reward
 * or alter a claim, dispute or vote, and it holds no chain client.
 */
@Injectable()
export class AbuseSignalInterceptor {
  private readonly logger = new Logger(AbuseSignalInterceptor.name);

  constructor(
    private readonly signals: AbuseSignalService,
    @Inject(ABUSE_POLICY) private readonly policy: AbusePolicyConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AbuseRequestLike | undefined>();
    const res = http.getResponse<{ setHeader?: (name: string, value: string) => void } | undefined>();
    if (!req || typeof req !== 'object') return next.handle();

    const routeGroup = routeGroupFor(
      typeof req.originalUrl === 'string' ? req.originalUrl : undefined,
    );
    if (!isScoredRoute(routeGroup)) return next.handle();

    if (this.signals.enforcementActive()) {
      return from(this.decide(req, res, routeGroup)).pipe(
        mergeMap((verdict) => (verdict ? verdict : next.handle())),
      );
    }

    // Detection must never add latency or availability risk to a response.
    void this.record(req, routeGroup).catch(() => undefined);
    return next.handle();
  }

  /**
   * Enforcement read for one request.
   *
   * Denies on an active `CHALLENGE` or `SUSPEND`, and denies on an
   * indeterminate result for an attributable subject: an unknown enforcement
   * answer is not a clean one. An enforced request is still observed, so it
   * keeps contributing to its own window.
   */
  private async decide(
    req: AbuseRequestLike,
    res: { setHeader?: (name: string, value: string) => void } | undefined,
    routeGroup: string,
  ): Promise<Observable<never> | null> {
    const resolution = this.resolve(req);
    const state = await this.signals.enforcementFor(resolution);

    if (state.action?.kind === AbuseActionKind.THROTTLE) {
      // A throttle advertises a cost multiplier rather than refusing the
      // request; the cost-aware limiter is the consumer of that number. This
      // interceptor deliberately does not rewire that limiter.
      this.logger.debug(
        'Abuse throttle active; cost multiplier advertised to the rate limiter',
      );
    }

    if (state.indeterminate) {
      return throwError(() =>
        this.denial(res, state.retryAfterMs ?? this.policy.maxActionDurationMs),
      );
    }

    if (
      state.enforced &&
      (state.action?.kind === AbuseActionKind.CHALLENGE ||
        state.action?.kind === AbuseActionKind.SUSPEND)
    ) {
      this.logger.warn(
        `Abuse ${state.action.kind} enforced on route group ${routeGroup}`,
      );
      return throwError(() =>
        this.denial(
          res,
          state.retryAfterMs ?? this.policy.maxActionDurationMs,
        ),
      );
    }

    void this.record(req, routeGroup).catch(() => undefined);
    return null;
  }

  /** Records an observation without ever blocking or delaying the response. */
  private async record(
    req: AbuseRequestLike,
    routeGroup: string,
  ): Promise<void> {
    await this.signals.observe(
      this.resolve(req),
      observationFromRequest(
        routeGroup,
        typeof req.method === 'string' ? req.method : undefined,
        undefined,
        Date.now(),
      ),
    );
  }

  private resolve(req: AbuseRequestLike) {
    return resolveAbuseSubject(
      identityInputFromRequest(req, {
        trustedProxyHops: this.policy.trustedProxyHops,
        subjectSalt: this.policy.subjectSalt,
      }),
    );
  }

  /**
   * The public denial.
   *
   * Deliberately uniform: the same code, message and header whether the cause
   * was a challenge, a suspension or an indeterminate read, so a client cannot
   * probe the module by comparing denial shapes.
   */
  private denial(
    res: { setHeader?: (name: string, value: string) => void } | undefined,
    retryAfterMs: number,
  ): HttpException {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    try {
      res?.setHeader?.('Retry-After', String(retryAfterSeconds));
    } catch {
      // A response that is already committed cannot carry the header; the
      // status code still carries the bound.
    }
    return new HttpException(
      {
        statusCode: 429,
        errorCode: PublicErrorCode.RATE_LIMITED,
        message: 'Too many requests. Please try again later.',
        retryAfterSeconds,
      },
      429,
    );
  }
}