import { getMetadataArgsStorage } from 'typeorm';
import { Claim } from './claim.entity';

describe('Claim legacy protocol columns', () => {
  it('excludes verdict and finality columns from TypeORM reads and writes', () => {
    const columns = getMetadataArgsStorage().columns.filter(
      (column) => column.target === Claim,
    );

    for (const propertyName of [
      'resolvedVerdict',
      'confidenceScore',
      'finalized',
      'resolvedAt',
    ]) {
      const column = columns.find(
        (candidate) => candidate.propertyName === propertyName,
      );

      expect(column?.options).toMatchObject({
        select: false,
        insert: false,
        update: false,
      });
    }
  });
});
