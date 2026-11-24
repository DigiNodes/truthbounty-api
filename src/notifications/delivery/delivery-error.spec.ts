import {
  DELIVERY_FAILURE_CLASSIFICATION,
  DELIVERY_FAILURE_DISPOSITION,
  DeliveryFailureKind,
  DuplicateDeliveryError,
  MalformedPayloadError,
  PermanentDeliveryError,
  ProviderRejectionError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RetryDisposition,
  UnknownDeliveryChannelError,
  UnknownDeliveryError,
  assertNever,
  dispositionForKind,
  narrowDeliveryError,
} from './delivery-error';
import { ErrorClassification } from '../../queue/retry-utils';
import { DeliveryChannel } from '../interfaces/notification.types';

/**
 * Compile-time exhaustiveness: these literal records fail to build if a new
 * `DeliveryFailureKind` is added without a disposition/classification decision.
 */
const EXPECTED_DISPOSITION: Record<DeliveryFailureKind, RetryDisposition> = {
  [DeliveryFailureKind.TIMEOUT]: 'retryable',
  [DeliveryFailureKind.UNAVAILABLE]: 'retryable',
  [DeliveryFailureKind.REJECTION]: 'terminal',
  [DeliveryFailureKind.MALFORMED_PAYLOAD]: 'terminal',
  [DeliveryFailureKind.DUPLICATE]: 'terminal',
  [DeliveryFailureKind.PERMANENT]: 'terminal',
  [DeliveryFailureKind.UNKNOWN_CHANNEL]: 'terminal',
  [DeliveryFailureKind.UNKNOWN]: 'terminal',
};

const EXPECTED_CLASSIFICATION: Record<
  DeliveryFailureKind,
  ErrorClassification
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

describe('NotificationDeliveryError classification', () => {
  it('covers every failure kind at compile time and runtime', () => {
    expect(Object.keys(DELIVERY_FAILURE_DISPOSITION).sort()).toEqual(
      Object.values(DeliveryFailureKind).sort(),
    );
    expect(DELIVERY_FAILURE_DISPOSITION).toEqual(EXPECTED_DISPOSITION);
    expect(DELIVERY_FAILURE_CLASSIFICATION).toEqual(EXPECTED_CLASSIFICATION);

    for (const kind of Object.values(DeliveryFailureKind)) {
      expect(dispositionForKind(kind)).toBe(EXPECTED_DISPOSITION[kind]);
    }
  });

  it('exhausts the union through an assertNever switch', () => {
    const label = (kind: DeliveryFailureKind): string => {
      switch (kind) {
        case DeliveryFailureKind.TIMEOUT:
          return 'timeout';
        case DeliveryFailureKind.UNAVAILABLE:
          return 'unavailable';
        case DeliveryFailureKind.REJECTION:
          return 'rejection';
        case DeliveryFailureKind.MALFORMED_PAYLOAD:
          return 'malformed';
        case DeliveryFailureKind.DUPLICATE:
          return 'duplicate';
        case DeliveryFailureKind.PERMANENT:
          return 'permanent';
        case DeliveryFailureKind.UNKNOWN_CHANNEL:
          return 'unknown_channel';
        case DeliveryFailureKind.UNKNOWN:
          return 'unknown';
        default:
          return assertNever(kind);
      }
    };

    for (const kind of Object.values(DeliveryFailureKind)) {
      expect(label(kind)).toBeTruthy();
    }
    expect(label(DeliveryFailureKind.UNKNOWN)).toBe('unknown');
  });

  describe('timeout', () => {
    it('narrows AbortError into a retryable provider timeout', () => {
      const error = narrowDeliveryError(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      );
      expect(error).toBeInstanceOf(ProviderTimeoutError);
      expect(error.kind).toBe(DeliveryFailureKind.TIMEOUT);
      expect(error.retryable).toBe(true);
      expect(error.disposition).toBe('retryable');
    });

    it('narrows timeout messages and provider codes', () => {
      expect(
        narrowDeliveryError(new Error('request timed out')),
      ).toBeInstanceOf(ProviderTimeoutError);
      expect(narrowDeliveryError({ code: 'ETIMEDOUT' })).toBeInstanceOf(
        ProviderTimeoutError,
      );
      expect(
        narrowDeliveryError({ code: 'UND_ERR_CONNECT_TIMEOUT' }),
      ).toBeInstanceOf(ProviderTimeoutError);
    });
  });

  describe('provider rejection', () => {
    it('treats 4xx as a terminal rejection and records the status', () => {
      const error = narrowDeliveryError({ response: { status: 400 } });
      expect(error).toBeInstanceOf(ProviderRejectionError);
      expect(error.retryable).toBe(false);
      expect(error.providerStatusCode).toBe(400);
    });

    it('treats 403/404 as terminal', () => {
      expect(narrowDeliveryError({ statusCode: 403 })).toBeInstanceOf(
        ProviderRejectionError,
      );
      expect(narrowDeliveryError({ status: 404 })).toBeInstanceOf(
        ProviderRejectionError,
      );
    });
  });

  describe('provider unavailable', () => {
    it('treats 5xx as retryable', () => {
      const error = narrowDeliveryError({ response: { status: 503 } });
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(error.retryable).toBe(true);
    });

    it('treats 429 and connection resets as retryable', () => {
      expect(narrowDeliveryError({ statusCode: 429 })).toBeInstanceOf(
        ProviderUnavailableError,
      );
      expect(narrowDeliveryError({ code: 'ECONNREFUSED' })).toBeInstanceOf(
        ProviderUnavailableError,
      );
      expect(
        narrowDeliveryError(new Error('service unavailable')),
      ).toBeInstanceOf(ProviderUnavailableError);
    });
  });

  describe('malformed payload', () => {
    it('narrows SyntaxError into a terminal malformed payload', () => {
      const error = narrowDeliveryError(
        new SyntaxError('Unexpected token < in JSON at position 0'),
      );
      expect(error).toBeInstanceOf(MalformedPayloadError);
      expect(error.retryable).toBe(false);
    });

    it('narrows malformed-payload messages', () => {
      expect(
        narrowDeliveryError(new Error('malformed payload')),
      ).toBeInstanceOf(MalformedPayloadError);
    });
  });

  describe('duplicate delivery', () => {
    it('narrows unique-violation codes into a terminal duplicate', () => {
      const error = narrowDeliveryError({ code: '23505' });
      expect(error).toBeInstanceOf(DuplicateDeliveryError);
      expect(error.retryable).toBe(false);
    });

    it('narrows duplicate messages', () => {
      expect(
        narrowDeliveryError(new Error('notification already delivered')),
      ).toBeInstanceOf(DuplicateDeliveryError);
    });
  });

  describe('permanent failure', () => {
    it('narrows invalid destinations into a terminal permanent failure', () => {
      const error = narrowDeliveryError(new Error('invalid recipient address'));
      expect(error).toBeInstanceOf(PermanentDeliveryError);
      expect(error.retryable).toBe(false);
    });

    it('narrows explicit permanent markers', () => {
      expect(
        narrowDeliveryError(new Error('unrecoverable permanent failure')),
      ).toBeInstanceOf(PermanentDeliveryError);
      expect(
        narrowDeliveryError(new Error('user has unsubscribed')),
      ).toBeInstanceOf(PermanentDeliveryError);
    });
  });

  describe('unknown and fail-closed behavior', () => {
    it('fails closed for unrecognized errors', () => {
      const error = narrowDeliveryError(new Error('something unprecedented'));
      expect(error).toBeInstanceOf(UnknownDeliveryError);
      expect(error.retryable).toBe(false);
      expect(error.disposition).toBe('terminal');
    });

    it('does not touch provider fields on non-object thrown values', () => {
      for (const value of [null, undefined, 42, true, 'boom']) {
        const error = narrowDeliveryError(value);
        expect(error).toBeInstanceOf(UnknownDeliveryError);
        expect(error.retryable).toBe(false);
      }
    });

    it('ignores non-string provider codes without throwing', () => {
      const error = narrowDeliveryError({ code: 12345, status: 'nonsense' });
      expect(error).toBeInstanceOf(UnknownDeliveryError);
    });
  });

  it('preserves an existing domain error by identity', () => {
    const original = new ProviderTimeoutError('slow provider', {
      channel: DeliveryChannel.EMAIL,
    });
    expect(narrowDeliveryError(original)).toBe(original);
    expect(original.channel).toBe(DeliveryChannel.EMAIL);
  });

  it('does not leak extra provider fields through toJSON', () => {
    const error = narrowDeliveryError({
      response: { status: 500 },
      secret: 'super-secret-token',
      message: 'upstream failed',
    });
    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).toContain('providerStatusCode');
  });

  it('exposes a terminal unknown-channel error', () => {
    const error = new UnknownDeliveryChannelError('no channel');
    expect(error.retryable).toBe(false);
    expect(error.kind).toBe(DeliveryFailureKind.UNKNOWN_CHANNEL);
  });
});
