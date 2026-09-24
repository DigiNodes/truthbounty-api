import { serializeBigInts } from './bigint-serialization.util';

describe('serializeBigInts', () => {
  it('serializes nested BigInt values as decimal strings', () => {
    const serialized = serializeBigInts({
      amount: 9007199254740993n,
      nested: {
        values: [1n, 2n],
      },
    });

    expect(serialized).toEqual({
      amount: '9007199254740993',
      nested: {
        values: ['1', '2'],
      },
    });
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it('serializes ethers-style Result objects through toObject', () => {
    const resultLike = {
      toObject: () => ({
        user: '0x0000000000000000000000000000000000000001',
        amount: 123456789012345678901234567890n,
      }),
    };

    expect(serializeBigInts(resultLike)).toEqual({
      user: '0x0000000000000000000000000000000000000001',
      amount: '123456789012345678901234567890',
    });
  });
});
