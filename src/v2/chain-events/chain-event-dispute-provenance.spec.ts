jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../generated/client/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
import { ChainEventDedupService } from './chain-event-dedup.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('dispute journal provenance', () => {
  const log = {
    chainId: 10,
    contractAddress: `0x${'a'.repeat(40)}`,
    eventName: 'DisputeRaised',
    blockNumber: 10n,
    blockHash: `0x${'b'.repeat(64)}`,
    txHash: `0x${'c'.repeat(64)}`,
    logIndex: 0,
    payload: { claimId: 'c', roundId: 'r' },
    rawArgs: {},
  };
  it('refuses dispute inputs without decoder and release identity', async () => {
    const create = jest.fn();
    const service = new ChainEventDedupService({
      chainEvent: { create },
    } as unknown as PrismaService);
    await expect(service.ingest(log)).rejects.toThrow('provenance');
    expect(create).not.toHaveBeenCalled();
  });
  it('stores complete provenance and canonical identity', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event' });
    const service = new ChainEventDedupService({
      chainEvent: { create },
    } as unknown as PrismaService);
    await service.ingest({
      ...log,
      releaseId: 'release',
      decoderVersion: 'approved',
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      releaseId: 'release',
      decoderVersion: 'approved',
      canonicalKey: JSON.stringify([
        10,
        'release',
        log.blockHash,
        log.txHash,
        0,
        'approved',
      ]),
    });
  });
});
