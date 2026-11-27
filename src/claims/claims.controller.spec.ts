import { GoneException } from '@nestjs/common';
import { ClaimsController } from './claims.controller';

describe('ClaimsController legacy protocol boundary', () => {
  let controller: ClaimsController;

  beforeEach(() => {
    controller = new ClaimsController({
      recordAccess: jest.fn(),
      list: jest.fn(),
      getMetadata: jest.fn(),
    } as never);
  });

  it('rejects legacy claim and evidence reads and writes with 410', async () => {
    const calls = [
      () => controller.getLatest(),
      () => controller.getByUser('0xwallet'),
      () => controller.getOne('legacy-claim'),
      () => controller.createOne({ title: 'claim', content: 'content' }),
      () => controller.createEvidence('legacy-claim', { cid: 'cid' }),
      () => controller.updateEvidence('legacy-evidence', { cid: 'cid' }),
      () => controller.getEvidenceForClaim('legacy-claim'),
      () => controller.getLatestEvidenceForClaim('legacy-claim'),
      () => controller.getEvidence('legacy-evidence'),
    ];

    for (const call of calls) {
      const result = call();
      await expect(result).rejects.toBeInstanceOf(GoneException);
      await expect(result).rejects.toMatchObject({
        status: 410,
        response: expect.objectContaining({
          code: 'CANONICAL_CHAIN_STATE_REQUIRED',
        }),
      });
    }
  });
});
