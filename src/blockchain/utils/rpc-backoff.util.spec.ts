import {
  withRpcBackoff,
  isRateLimitError,
  isRetryableRpcError,
} from './rpc-backoff.util';

describe('rpc-backoff', () => {
  // No-op sleep so tests don't wait on real timers.
  const sleep = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => jest.clearAllMocks());

  describe('isRateLimitError', () => {
    it.each([
      { status: 429 },
      { statusCode: 429 },
      { info: { responseStatus: '429 Too Many Requests' } },
      { code: -32005 },
      { message: 'Too Many Requests' },
      { message: 'request failed: rate limit exceeded' },
    ])('detects 429 / rate limit shape %j', (err) => {
      expect(isRateLimitError(err)).toBe(true);
    });

    it('ignores unrelated errors', () => {
      expect(isRateLimitError(new Error('execution reverted'))).toBe(false);
      expect(isRateLimitError({ status: 400 })).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
    });
  });

  describe('isRetryableRpcError', () => {
    it('retries transient server/network errors', () => {
      expect(isRetryableRpcError({ code: 'SERVER_ERROR' })).toBe(true);
      expect(isRetryableRpcError({ code: 'TIMEOUT' })).toBe(true);
      expect(isRetryableRpcError({ code: 'ECONNRESET' })).toBe(true);
      expect(isRetryableRpcError({ status: 503 })).toBe(true);
    });

    it('does not retry deterministic client errors', () => {
      expect(isRetryableRpcError({ code: 'CALL_EXCEPTION' })).toBe(false);
      expect(isRetryableRpcError({ status: 400 })).toBe(false);
    });
  });

  describe('withRpcBackoff', () => {
    it('returns immediately when the call succeeds', async () => {
      const fn = jest.fn().mockResolvedValue('ok');

      await expect(withRpcBackoff(fn, { sleep })).resolves.toBe('ok');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('retries on 429 and eventually succeeds', async () => {
      const rateLimit = { status: 429, message: 'Too Many Requests' };
      const fn = jest
        .fn()
        .mockRejectedValueOnce(rateLimit)
        .mockRejectedValueOnce(rateLimit)
        .mockResolvedValue('recovered');

      const onRetry = jest.fn();
      const result = await withRpcBackoff(fn, { sleep, onRetry, jitter: false });

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it('backs off exponentially (no jitter)', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ status: 429 })
        .mockRejectedValueOnce({ status: 429 })
        .mockResolvedValue('done');

      await withRpcBackoff(fn, { sleep, jitter: false, baseDelayMs: 100 });

      // 100 * 2^0, then 100 * 2^1
      expect(sleep).toHaveBeenNthCalledWith(1, 100);
      expect(sleep).toHaveBeenNthCalledWith(2, 200);
    });

    it('gives up after maxRetries and rethrows the last error', async () => {
      const rateLimit = { status: 429, message: 'Too Many Requests' };
      const fn = jest.fn().mockRejectedValue(rateLimit);

      await expect(
        withRpcBackoff(fn, { sleep, maxRetries: 3, jitter: false }),
      ).rejects.toBe(rateLimit);

      // initial attempt + 3 retries
      expect(fn).toHaveBeenCalledTimes(4);
      expect(sleep).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-retryable errors', async () => {
      const reverted = { code: 'CALL_EXCEPTION', message: 'execution reverted' };
      const fn = jest.fn().mockRejectedValue(reverted);

      await expect(withRpcBackoff(fn, { sleep })).rejects.toBe(reverted);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
