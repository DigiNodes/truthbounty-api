import { BadRequestException } from '@nestjs/common';
import { ClaimResolutionService } from './claim-resolution.service';

describe('ClaimResolutionService', () => {
  const createService = () => {
    const service = new ClaimResolutionService();
    return { service };
  };

  it('keeps confidence scoring advisory and rejects invalid weights', () => {
    const { service } = createService();
    expect(
      service.computeConfidenceScore({ trueWeight: 180, falseWeight: 20 })
        ?.verdict,
    ).toBe('true');
    expect(
      service.computeConfidenceScore({ trueWeight: 100, falseWeight: 100 })
        ?.verdict,
    ).toBe('inconclusive');
    expect(() =>
      service.computeConfidenceScore({ trueWeight: -1, falseWeight: 50 }),
    ).toThrow(BadRequestException);
  });

  it('rejects API-authoritative claim resolution without a database transaction', async () => {
    const { service } = createService();

    await expect(
      service.resolveClaim('claim-id', { trueWeight: 150, falseWeight: 50 }),
    ).rejects.toMatchObject({ status: 410 });
  });
});
