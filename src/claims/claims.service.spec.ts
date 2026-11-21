import { ClaimsService } from './claims.service';

describe('ClaimsService legacy protocol boundary', () => {
  const service = new ClaimsService();

  it('rejects direct claim creation without producing local protocol state', async () => {
    await expect(
      service.createClaim({ title: 'claim', content: 'content' }),
    ).rejects.toMatchObject({
      status: 410,
      response: expect.objectContaining({
        code: 'CANONICAL_CHAIN_STATE_REQUIRED',
      }),
    });
  });

  it('rejects legacy reads so cache or TypeORM rows cannot be served as canonical', async () => {
    const calls = [
      () => service.findOne('legacy-id'),
      () => service.findLatest(),
      () => service.findByUser('0xwallet'),
      () => service.paginateClaims({}, {}, undefined, undefined),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ status: 410 });
    }
  });

  it('rejects API-authoritative claim resolution', async () => {
    await expect(
      service.resolveClaim('claim-id', true, 0.9),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('rejects API-authoritative claim finalization', async () => {
    await expect(
      service.finalizeClaim('claim-id'),
    ).rejects.toMatchObject({ status: 410 });
  });
});
