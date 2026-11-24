import { DeliveryChannel } from '../interfaces/notification.types';
import { ErrorClassification } from '../../queue/retry-utils';

/**
 * Deterministic failure kinds for notification delivery.
 *
 * Every thrown value is narrowed into exactly one of these kinds before any
 * provider-specific field (HTTP status, provider error code, etc.) is read.
 * The kind → disposition mapping is a total `Record`, so adding a kind
 * without deciding whether it is retryable is a compile error.
 */
export enum DeliveryFailureKind {
  /** Provider did not answer within the deadline. Retryable. */
  TIMEOUT = 'TIMEOUT',
  /** Provider is reachable but temporarily overloaded (5xx / 429 / offline). Retryable. */
  UNAVAILABLE = 'UNAVAILABLE',
  /** Provider rejected the request on its merits (4xx). Terminal. */
  REJECTION = 'REJECTION',
  /** Payload could not be serialized/parsed for the provider. Terminal. */
  MALFORMED_PAYLOAD = 'MALFORMED_PAYLOAD',
  /** Delivery already happened (unique/idempotency conflict). Terminal. */
  DUPLICATE = 'DUPLICATE',
  /** Permanently undeliverable (invalid destination, unsubscribed, ...). Terminal. */
  PERMANENT = 'PERMANENT',
  /** Null/unknown delivery channel could not be mapped to a worker. Terminal. */
  UNKNOWN_CHANNEL = 'UNKNOWN_CHANNEL',
  /** Unclassified failure. Fail-closed: terminal. */
  UNKNOWN = 'UNKNOWN',
}

export type RetryDisposition = 'retryable' | 'terminal';

/**
 * Total map from failure kind to disposition. The `Record` type makes the
 * classification compile-time exhaustive: a new kind forces an explicit
 * decision here.
 */
export const DELIVERY_FAILURE_DISPOSITION: Readonly<
  Record<DeliveryFailureKind, RetryDisposition>
> = {
  [DeliveryFailureKind.TIMEOUT]: 'retryable',
  [DeliveryFailureKind.UNAVAILABLE]: 'retryable',
  [DeliveryFailureKind.REJECTION]: 'terminal',
  [DeliveryFailureKind.MALFORMED_PAYLOAD]: 'terminal',
  [DeliveryFailureKind.DUPLICATE]: 'terminal',
  [DeliveryFailureKind.PERMANENT]: 'terminal',
  [DeliveryFailureKind.UNKNOWN_CHANNEL]: 'terminal',
  [DeliveryFailureKind.UNKNOWN]: 'terminal',
};

/**
 * Total map from failure kind to the shared retry classification used by the
 * queue retry budget (`src/queue/retry-utils`). Terminal kinds intentionally
 * map to zero-attempt classifications so a budget can never resurrect them.
 */
export const DELIVERY_FAILURE_CLASSIFICATION: Readonly<
  Record<DeliveryFailureKind, ErrorClassification>
> = {
  [DeliveryFailureKind.TIMEOUT]: ErrorClassification.NETWORK,
  [DeliveryFailureKind.UNAVAILABLE]: ErrorClassification.RESOURCE,
  [DeliveryFailureKind.REJECTION]: ErrorClassification.VALIDATION,
  [DeliveryFailureKind.MALFORMED_PAYLOAD]: ErrorClassification.VALIDATION,
  [DeliveryFailureKind.DUPLICATE]: ErrorClassification.VALIDATION,
  [DeliveryFailureKind.PERMANENT]: ErrorClassification.UNKNOWN,
  [DeliveryFailureKind.UNKNOWN_CHANNEL]: ErrorClassification.VALIDATION,
  [DeliveryFailureKind.UNKNOWN]: ErrorClassification.UNKNOWN,
};

export function dispositionForKind(
  kind: DeliveryFailureKind,
): RetryDisposition {
  return DELIVERY_FAILURE_DISPOSITION[kind];
}

export function classificationForKind(
  kind: DeliveryFailureKind,
): ErrorClassification {
  return DELIVERY_FAILURE_CLASSIFICATION[kind];
}

/** Compile-time exhaustiveness guard for `switch` statements over a union. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled delivery failure kind: ${String(value)}`);
}

export interface NotificationDeliveryErrorOptions {
  channel?: DeliveryChannel | null;
  providerStatusCode?: number;
  cause?: unknown;
}

/**
 * Base class for every expected notification-delivery failure.
 *
 * Carries a deterministic `kind` and `disposition` so callers never have to
 * guess whether an error is safe to retry. `toJSON` is sanitized: it never
 * includes provider bodies, destinations, or credentials.
 */
export abstract class NotificationDeliveryError extends Error {
  abstract readonly kind: DeliveryFailureKind;

  readonly channel: DeliveryChannel | null;
  readonly providerStatusCode?: number;

  constructor(message: string, options: NotificationDeliveryErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.channel = options.channel ?? null;
    this.providerStatusCode = options.providerStatusCode;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get disposition(): RetryDisposition {
    return dispositionForKind(this.kind);
  }

  get retryable(): boolean {
    return this.disposition === 'retryable';
  }

  get classification(): ErrorClassification {
    return classificationForKind(this.kind);
  }

  /** Sanitized representation that is safe for logs and public diagnostics. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      disposition: this.disposition,
      channel: this.channel,
      providerStatusCode: this.providerStatusCode,
      message: this.message,
    };
  }
}

export class ProviderTimeoutError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.TIMEOUT;
}

export class ProviderUnavailableError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.UNAVAILABLE;
}

export class ProviderRejectionError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.REJECTION;
}

export class MalformedPayloadError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.MALFORMED_PAYLOAD;
}

export class DuplicateDeliveryError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.DUPLICATE;
}

export class PermanentDeliveryError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.PERMANENT;
}

export class UnknownDeliveryChannelError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.UNKNOWN_CHANNEL;
}

export class UnknownDeliveryError extends NotificationDeliveryError {
  readonly kind = DeliveryFailureKind.UNKNOWN;
}

/** Narrow structural view of a provider error. */
interface ProviderErrorShape {
  message?: string;
  name?: string;
  code?: string;
  status?: number;
  statusCode?: number;
  response?: { status?: number; statusCode?: number };
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNABORTED',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
]);

const DUPLICATE_CODES = new Set([
  '23505',
  'ER_DUP_ENTRY',
  'SQLITE_CONSTRAINT',
  'SQLITE_CONSTRAINT_UNIQUE',
]);

const TIMEOUT_PATTERN = /timeout|timed out|deadline exceeded/;
const UNAVAILABLE_PATTERN =
  /rate limit|too many requests|service unavailable|bad gateway|gateway timeout|temporarily unavailable|overloaded/;
const DUPLICATE_PATTERN =
  /duplicate|already delivered|already exists|already processed/;
const MALFORMED_PATTERN =
  /malformed|invalid (payload|json|body|request)|validation|schema|parse (error|failure)|unexpected token/;
const PERMANENT_PATTERN =
  /permanent|unrecoverable|not found|does not exist|no such|unsubscribed|bounced|invalid (recipient|destination|address|token|channel)|missing (recipient|destination)/;

/**
 * Read only the fields we understand off an untrusted thrown value. This is the
 * single place where provider-specific fields are touched; every branch below
 * operates on the narrowed shape, never on the raw `unknown`.
 */
function readProviderShape(error: unknown): ProviderErrorShape {
  if (typeof error !== 'object' || error === null) {
    return {};
  }

  const record = error as Record<string, unknown>;
  const shape: ProviderErrorShape = {};

  if (typeof record.message === 'string') shape.message = record.message;
  if (typeof record.name === 'string') shape.name = record.name;
  if (typeof record.code === 'string') shape.code = record.code;
  if (typeof record.status === 'number') shape.status = record.status;
  if (typeof record.statusCode === 'number')
    shape.statusCode = record.statusCode;

  const response = record.response;
  if (typeof response === 'object' && response !== null) {
    const responseRecord = response as Record<string, unknown>;
    const status =
      typeof responseRecord.status === 'number'
        ? responseRecord.status
        : undefined;
    const statusCode =
      typeof responseRecord.statusCode === 'number'
        ? responseRecord.statusCode
        : undefined;
    if (status !== undefined || statusCode !== undefined) {
      shape.response = { status, statusCode };
    }
  }

  return shape;
}

function resolveStatusCode(shape: ProviderErrorShape): number | undefined {
  return (
    shape.response?.status ??
    shape.response?.statusCode ??
    shape.status ??
    shape.statusCode
  );
}

function hasCode(shape: ProviderErrorShape, codes: Set<string>): boolean {
  return shape.code !== undefined && codes.has(shape.code.toUpperCase());
}

function isSyntaxError(error: unknown, shape: ProviderErrorShape): boolean {
  return error instanceof SyntaxError || shape.name === 'SyntaxError';
}

/**
 * Narrow any thrown value into a typed, deterministic delivery error.
 *
 * Order matters: identity is preserved for domain errors, then transient
 * network/timeout shapes are recognised, then duplicate/malformed terminal
 * shapes, then status-based rejection/unavailability, and finally the
 * fail-closed `UNKNOWN` terminal bucket.
 */
export function narrowDeliveryError(
  error: unknown,
  context: { channel?: DeliveryChannel | null } = {},
): NotificationDeliveryError {
  if (error instanceof NotificationDeliveryError) {
    return error;
  }

  const shape = readProviderShape(error);
  const message =
    shape.message ??
    (typeof error === 'string' ? error : 'Notification delivery failed');
  const lower = message.toLowerCase();
  const statusCode = resolveStatusCode(shape);
  const options: NotificationDeliveryErrorOptions = {
    channel: context.channel ?? null,
    providerStatusCode: statusCode,
    cause: error,
  };

  if (
    shape.name === 'AbortError' ||
    shape.name === 'TimeoutError' ||
    hasCode(shape, TIMEOUT_CODES) ||
    TIMEOUT_PATTERN.test(lower)
  ) {
    return new ProviderTimeoutError(message, options);
  }

  if (hasCode(shape, DUPLICATE_CODES) || DUPLICATE_PATTERN.test(lower)) {
    return new DuplicateDeliveryError(message, options);
  }

  if (isSyntaxError(error, shape) || MALFORMED_PATTERN.test(lower)) {
    return new MalformedPayloadError(message, options);
  }

  if (
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
    hasCode(shape, UNAVAILABLE_CODES) ||
    UNAVAILABLE_PATTERN.test(lower)
  ) {
    return new ProviderUnavailableError(message, options);
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return new ProviderRejectionError(message, options);
  }

  if (PERMANENT_PATTERN.test(lower)) {
    return new PermanentDeliveryError(message, options);
  }

  // Fail-closed: anything we do not understand is terminal.
  return new UnknownDeliveryError(message, options);
}

/** Convenience predicate used by workers that only need the retry decision. */
export function isRetryableDeliveryError(error: unknown): boolean {
  return narrowDeliveryError(error).retryable;
}
