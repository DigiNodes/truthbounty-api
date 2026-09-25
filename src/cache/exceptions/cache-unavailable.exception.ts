/**
 * Cache Unavailable Exception
 *
 * Thrown when cache operations fail due to Redis unavailability, connection errors,
 * or other cache-specific failures. This exception isolates cache failures from
 * canonical state (TypeORM/PostgreSQL) and ensures failures are observable.
 *
 * Per V2-BE-116, cache failures must never silently fallback to fabricated state.
 * Services should catch this exception, log/metric the failure, and serve from
 * the canonical database layer.
 */
export class CacheUnavailableException extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly key?: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'CacheUnavailableException';
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Create a cache unavailable exception for a GET operation
   */
  static forGet(key: string, originalError?: Error): CacheUnavailableException {
    return new CacheUnavailableException(
      `Cache GET failed for key: ${key}`,
      'GET',
      key,
      originalError,
    );
  }

  /**
   * Create a cache unavailable exception for a SET operation
   */
  static forSet(key: string, originalError?: Error): CacheUnavailableException {
    return new CacheUnavailableException(
      `Cache SET failed for key: ${key}`,
      'SET',
      key,
      originalError,
    );
  }

  /**
   * Create a cache unavailable exception for a DELETE operation
   */
  static forDelete(key: string, originalError?: Error): CacheUnavailableException {
    return new CacheUnavailableException(
      `Cache DELETE failed for key: ${key}`,
      'DELETE',
      key,
      originalError,
    );
  }

  /**
   * Create a cache unavailable exception for connection failures
   */
  static forConnection(originalError?: Error): CacheUnavailableException {
    return new CacheUnavailableException(
      'Cache connection unavailable',
      'CONNECTION',
      undefined,
      originalError,
    );
  }
}
