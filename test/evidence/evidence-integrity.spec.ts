import { verifyCIDIntegrity } from '../../src/storage/cid-verifier';
import { computeSHA256 } from '../../src/common/utils/hash.util';

describe('Evidence Integrity Verification', () => {
  it('accepts valid CID hash match', () => {
    const buffer = Buffer.from('truthbounty-test');
    const hash = computeSHA256(buffer);

    const cid = `cid-${hash.slice(0, 16)}`;

    expect(verifyCIDIntegrity(buffer, cid)).toBe(true);
  });

  it('rejects mismatched CID', () => {
    const buffer = Buffer.from('original');
    const cid = 'cid-invalidhash';

    expect(verifyCIDIntegrity(buffer, cid)).toBe(false);
  });

  it('detects tampering attempts', () => {
    const buffer = Buffer.from('fileA');
    const tampered = Buffer.from('fileB');

    const cid = `cid-${computeSHA256(buffer).slice(0, 16)}`;

    expect(verifyCIDIntegrity(tampered, cid)).toBe(false);
  });
});
