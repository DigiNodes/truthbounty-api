import { GoneException } from '@nestjs/common';
import { ClaimFeedController } from './claim-feed.controller';

describe('ClaimFeedController', () => {
  const controller = new ClaimFeedController();

  it('returns 410 for the legacy feed and detail routes', async () => {
    await expect(controller.getFeed({} as never)).rejects.toBeInstanceOf(
      GoneException,
    );
    await expect(
      controller.getDetail({ id: 'legacy-id' }),
    ).rejects.toMatchObject({
      status: 410,
      response: expect.objectContaining({
        code: 'CANONICAL_CHAIN_STATE_REQUIRED',
      }),
    });
  });
});
