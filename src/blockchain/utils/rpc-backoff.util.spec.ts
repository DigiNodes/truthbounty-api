import {
  withRpcBackoff,
  isRateLimitError,
  isRetryableRpcError,
  RpcProviderManager,
  withRpcFailover,
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

  describe('rpc provider failover', () => {
    it('fails over to the next ordered provider after a rate limit', async () => {
      const primary = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10 }),
        getBlockNumber: jest.fn().mockRejectedValue({ status: 429 }),
      };
      const secondary = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10 }),
        getBlockNumber: jest.fn().mockResolvedValue(42),
      };

      const manager = new RpcProviderManager([primary as any, secondary as any], {
        chainId: 10,
        maxRetries: 0,
        rateLimitMs: 0,
      });

      await expect(manager.call('getBlockNumber')).resolves.toBe(42);
      expect(primary.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(secondary.getBlockNumber).toHaveBeenCalledTimes(1);
    });

    it('opens the circuit after repeated failures and blocks unhealthy providers', async () => {
      const primary = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10 }),
        getBlockNumber: jest.fn().mockRejectedValue(new Error('boom')),
      };
      const secondary = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10 }),
        getBlockNumber: jest.fn().mockResolvedValue(9),
      };

      const manager = new RpcProviderManager([primary as any, secondary as any], {
        chainId: 10,
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 60000,
        maxRetries: 0,
        rateLimitMs: 0,
      });

      await expect(manager.call('getBlockNumber')).rejects.toThrow();
      await expect(manager.call('getBlockNumber')).rejects.toThrow();
      expect(manager.getProviderState('primary')).toMatchObject({ status: 'open' });
    });

    it('validates chain id and block hash before trusting a read result', async () => {
      const block = { number: 123, hash: '0xabc', parentHash: '0xdef' };
      const provider = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10 }),
        getBlock: jest.fn().mockResolvedValue(block),
      };

      const manager = new RpcProviderManager([provider as any], {
        chainId: 10,
        maxRetries: 0,
        rateLimitMs: 0,
      });

      await expect(
        manager.call('getBlock', [123, true], {
          expectedBlockHash: '0xabc',
        }),
      ).resolves.toMatchObject({ hash: '0xabc' });

      await expect(
        manager.call('getBlock', [123, true], {
          expectedBlockHash: '0xdef',
        }),
      ).rejects.toThrow('block hash');
    });
  });

  describe('withRpcFailover', () => {
    it('uses failover wrapper for a provider chain', async () => {
      const primary = {
        getBlockNumber: jest.fn().mockRejectedValue({ status: 429 }),
      };
      const secondary = {
        getBlockNumber: jest.fn().mockResolvedValue(7),
      };

      await expect(
        withRpcFailover(
          [primary as any, secondary as any],
          (provider: any) => provider.getBlockNumber(),
          { chainId: 10, maxRetries: 0, rateLimitMs: 0 },
        ),
      ).resolves.toBe(7);
    });
  });
});
