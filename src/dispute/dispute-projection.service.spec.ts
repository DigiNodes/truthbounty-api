jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { ConfigService } from '@nestjs/config';
import { DisputeProjectionService } from './dispute-projection.service';
import { DisputeJournalStore } from './dispute-journal.store';
import {
  compatibilityEnvironment,
  parseRuntimeConfig,
} from '../config/runtime-schema';

describe('dispute runtime configuration', () => {
  it('retains the projection settings in the validated runtime environment', () => {
    const environment = compatibilityEnvironment(
      parseRuntimeConfig({
        DISPUTE_PROJECTION_CONTRACT_ADDRESS: `0x${'a'.repeat(40)}`,
        DISPUTE_PROJECTION_DECODER_VERSION: 'approved-v1',
      }),
    );
    expect(environment.DISPUTE_PROJECTION_CONTRACT_ADDRESS).toBe(
      `0x${'a'.repeat(40)}`,
    );
    expect(environment.DISPUTE_PROJECTION_DECODER_VERSION).toBe('approved-v1');
  });

  it('rejects an invalid configured contract address', () => {
    expect(() =>
      parseRuntimeConfig({ DISPUTE_PROJECTION_CONTRACT_ADDRESS: 'invalid' }),
    ).toThrow();
  });
});

const hash = (digit: string) => `0x${digit.repeat(64)}`;
describe('RPC finality boundary', () => {
  let rpc: { getNetwork: jest.Mock; getBlock: jest.Mock; destroy: jest.Mock };
  let service: DisputeProjectionService;
  let rows: unknown[];
  beforeEach(() => {
    rows = [
      {
        chainId: 10,
        releaseId: 'r',
        contractAddress: `0x${'a'.repeat(40)}`,
        decoderVersion: 'v1',
        eventName: 'DisputeRaised',
        blockNumber: '10',
        blockHash: hash('1'),
        txHash: hash('2'),
        logIndex: 0,
        removed: false,
        payload: JSON.stringify({ claimId: 'c', roundId: 'r' }),
      },
    ];
    rpc = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 10n }),
      getBlock: jest.fn().mockResolvedValue({ number: 10, hash: hash('1') }),
      destroy: jest.fn(),
    };
    class Projection extends DisputeProjectionService {
      protected provider(): any {
        return rpc;
      }
    }
    service = new Projection(
      { events: async () => rows } as unknown as DisputeJournalStore,
      new ConfigService({
        CHAIN_ID: 10,
        CONTRACT_RELEASE_ID: 'r',
        DISPUTE_PROJECTION_CONTRACT_ADDRESS: `0x${'a'.repeat(40)}`,
        CONTRACT_RELEASE_DEPLOYMENT_BLOCK: '10',
        DISPUTE_PROJECTION_DECODER_VERSION: 'v1',
      }),
    );
  });
  it('uses the finalized tag, verifies each block, and rechecks the pinned anchor', async () => {
    const result = await service.snapshot();
    expect(result.items[0].status).toBe('OPEN');
    expect(rpc.getBlock.mock.calls).toEqual([['finalized'], ['0xa'], [10]]);
    expect(rpc.destroy).toHaveBeenCalled();
  });
  it('rejects a wrong RPC chain', async () => {
    rpc.getNetwork.mockResolvedValue({ chainId: 1n });
    await expect(service.snapshot()).rejects.toThrow('unavailable');
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable finality or changed anchors', async () => {
    rpc.getBlock.mockResolvedValueOnce(null);
    await expect(service.snapshot()).rejects.toThrow('unavailable');
    rpc.getBlock
      .mockResolvedValueOnce({ number: 10, hash: hash('1') })
      .mockResolvedValueOnce({ number: 10, hash: hash('1') })
      .mockResolvedValueOnce({ number: 10, hash: hash('3') });
    await expect(service.snapshot()).rejects.toThrow('unavailable');
  });
  it('does not project orphaned journal rows even before removed-log cleanup', async () => {
    rpc.getBlock.mockResolvedValue({ number: 10, hash: hash('3') });
    expect((await service.snapshot()).items).toEqual([]);
  });
  it('does not leak RPC errors', async () => {
    rpc.getBlock.mockRejectedValue(new Error('secret-provider-url'));
    await expect(service.snapshot()).rejects.toThrow(
      'Finalized dispute projection unavailable',
    );
  });
});
