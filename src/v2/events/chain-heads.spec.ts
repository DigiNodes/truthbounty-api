import { RpcChainHeadsProvider, validateChainHeads } from './chain-heads';
import { IndexerConfigService } from '../../config/indexer-config.service';

function config(rpcUrl: string) {
  return {
    getEventIndexerConfig: () => ({ rpcUrl, chainId: 10 }),
  } as unknown as IndexerConfigService;
}

describe('canonical chain heads', () => {
  describe('validateChainHeads', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const valid = {
      chainId: 10,
      observedHead: 200n,
      safeHead: 150n,
      finalizedHead: 100n,
      observedAt: now,
      source: 'provider:test',
    };

    it('accepts ordered, fresh, chain-scoped heads', () => {
      expect(validateChainHeads(valid, 10, now)).toMatchObject(valid);
    });

    it.each([
      ['absent', null, 10, now],
      ['wrong chain', valid, 137, now],
      ['stale', valid, 10, new Date(now.getTime() + 120_001)],
      ['future', valid, 10, new Date(now.getTime() - 10_000)],
      ['finalized above safe', { ...valid, finalizedHead: 160n }, 10, now],
      ['safe above observed', { ...valid, safeHead: 300n }, 10, now],
      ['negative', { ...valid, finalizedHead: -1n }, 10, now],
      ['missing source', { ...valid, source: '' }, 10, now],
      ['malformed hash', { ...valid, safeBlockHash: '0x1234' }, 10, now],
    ])('rejects %s heads', (_label, heads, chainId, at) => {
      expect(
        validateChainHeads(
          heads as typeof valid | null,
          chainId as number,
          at as Date,
        ),
      ).toBeNull();
    });
  });

  describe('RpcChainHeadsProvider', () => {
    it('fails closed when no RPC URL is configured', async () => {
      const provider = new RpcChainHeadsProvider(config(''));
      expect(await provider.getHeads(10)).toBeNull();
    });

    it('rejects a provider on a different chain', async () => {
      const provider = new RpcChainHeadsProvider(config('http://localhost:1'));
      const rpc = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 137n }),
        getBlock: jest.fn(),
      };
      (provider as unknown as { rpc: typeof rpc }).rpc = rpc;

      expect(await provider.getHeads(10)).toBeNull();
      expect(rpc.getBlock).not.toHaveBeenCalled();
    });

    it('reads latest/safe/finalized tags from the provider', async () => {
      const provider = new RpcChainHeadsProvider(config('http://localhost:1'));
      const rpc = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10n }),
        getBlock: jest.fn(async (tag: string) => ({
          number: tag === 'latest' ? 200 : tag === 'safe' ? 150 : 100,
          hash: '0x' + 'ab'.repeat(32),
        })),
      };
      (provider as unknown as { rpc: typeof rpc }).rpc = rpc;
      const now = new Date();

      const heads = await provider.getHeads(10, now);

      expect(rpc.getBlock.mock.calls.map((call) => call[0])).toEqual([
        'latest',
        'safe',
        'finalized',
      ]);
      expect(heads).toMatchObject({
        chainId: 10,
        observedHead: 200n,
        safeHead: 150n,
        finalizedHead: 100n,
        observedAt: now,
      });
    });

    it('fails closed when a tag is missing or the RPC throws', async () => {
      const provider = new RpcChainHeadsProvider(config('http://localhost:1'));
      const missing = {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 10n }),
        getBlock: jest.fn(async (tag: string) =>
          tag === 'finalized' ? null : { number: 100 },
        ),
      };
      (provider as unknown as { rpc: typeof missing }).rpc = missing;
      expect(await provider.getHeads(10)).toBeNull();

      const broken = {
        getNetwork: jest.fn().mockRejectedValue(new Error('rpc down')),
        getBlock: jest.fn(),
      };
      (provider as unknown as { rpc: typeof broken }).rpc = broken;
      expect(await provider.getHeads(10)).toBeNull();
    });
  });
});
