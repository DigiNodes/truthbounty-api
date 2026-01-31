import { ReputationService } from './reputation.service';

// Minimal mocks for constructor dependencies — tests only call pure method
const fakeRepo: any = {};
const fakeDataSource: any = { transaction: async (fn: any) => fn({}) };

describe('ReputationService.computeReputationDelta', () => {
  const service = new ReputationService(fakeRepo, fakeRepo, fakeDataSource);

  test('cold start correct small stake increases by at least 1', () => {
    const delta = service.computeReputationDelta({
      oldScore: 50,
      totalVerifications: 0,
      correctVerifications: 0,
      stakeAmount: 1,
      isCorrect: true,
    });

    expect(delta).toBeGreaterThanOrEqual(1);
  });

  test('incorrect small stake decreases by at least 1', () => {
    const delta = service.computeReputationDelta({
      oldScore: 50,
      totalVerifications: 10,
      correctVerifications: 5,
      stakeAmount: 1,
      isCorrect: false,
    });

    expect(delta).toBeLessThanOrEqual(-1);
  });

  test('high stake bounded by cap does not produce extreme delta', () => {
    const delta = service.computeReputationDelta({
      oldScore: 20,
      totalVerifications: 100,
      correctVerifications: 90,
      stakeAmount: 999999999,
      isCorrect: true,
    });

    expect(delta).toBeLessThanOrEqual(10);
  });

  test('diminishing returns for high reputation', () => {
    const deltaLow = service.computeReputationDelta({
      oldScore: 10,
      totalVerifications: 20,
      correctVerifications: 18,
      stakeAmount: 10,
      isCorrect: true,
    });

    const deltaHigh = service.computeReputationDelta({
      oldScore: 90,
      totalVerifications: 20,
      correctVerifications: 18,
      stakeAmount: 10,
      isCorrect: true,
    });

    expect(deltaHigh).toBeLessThanOrEqual(deltaLow);
  });
});
