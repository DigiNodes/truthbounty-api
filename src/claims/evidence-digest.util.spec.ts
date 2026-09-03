/* eslint-disable @typescript-eslint/unbound-method */
import { extractCidDigest } from './evidence-digest.util';
import { CID } from 'multiformats/cid';

const cidParse = CID.parse as unknown as jest.Mock;

describe('extractCidDigest', () => {
  afterEach(() => {
    cidParse.mockReset();
  });

  it('extracts the multihash digest from a valid CID', () => {
    cidParse.mockReturnValue({
      version: 1,
      code: 0x55,
      multihash: { code: 0x12, digest: new Uint8Array([1, 2, 3, 4]) },
    });

    const result = extractCidDigest('bafybeig-dummy');
    expect(result).toEqual({
      cid: 'bafybeig-dummy',
      version: 1,
      digestHex: '01020304',
      codecCode: 0x55,
      hashCode: 0x12,
    });
  });

  it('returns null for a missing digest', () => {
    cidParse.mockReturnValue({
      version: 1,
      code: 0x55,
      multihash: { code: 0x12 },
    });
    expect(extractCidDigest('cid')).toBeNull();
  });

  it('returns null when parse throws', () => {
    cidParse.mockImplementation(() => {
      throw new Error('bad');
    });
    expect(extractCidDigest('not-a-cid')).toBeNull();
  });
});
