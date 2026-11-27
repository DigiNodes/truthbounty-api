import { BadRequestException } from '@nestjs/common';
import { advisoryConfidence } from './claim-advisory-analytics';

describe('advisoryConfidence', () => {
  it('labels vote-weight output advisory and never returns a canonical state', () => {
    const result = advisoryConfidence({ trueWeight: 180, falseWeight: 20 });

    expect(result).toMatchObject({
      kind: 'advisory',
      score: 0.8,
      suggestedVerdict: 'true',
      totalWeight: 200,
    });
    expect(result).not.toHaveProperty('finalized');
    expect(result).not.toHaveProperty('resolvedVerdict');
  });

  it('does not produce an estimate below the participation threshold', () => {
    expect(
      advisoryConfidence({ trueWeight: 30, falseWeight: 20 }),
    ).toBeNull();
  });

  it('rejects invalid weights', () => {
    expect(() =>
      advisoryConfidence({ trueWeight: -1, falseWeight: 10 }),
    ).toThrow(BadRequestException);
  });
});
