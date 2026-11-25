import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { verifyCIDIntegrity } from '../../src/storage/cid-verifier';

describe('Evidence Integrity Verification', () => {
  async function cidFor(buffer: Buffer): Promise<string> {
    return CID.createV1(0x55, await sha256.digest(buffer)).toString();
  }

  it('accepts valid CID hash match', async () => {
    const buffer = Buffer.from('truthbounty-test');
    const cid = await cidFor(buffer);

    expect(await verifyCIDIntegrity(buffer, cid)).toBe(true);
  });

  it('rejects mismatched CID', async () => {
    const buffer = Buffer.from('original');
    const cid = await cidFor(Buffer.from('different content'));

    expect(await verifyCIDIntegrity(buffer, cid)).toBe(false);
  });

  it('detects tampering attempts', async () => {
    const buffer = Buffer.from('fileA');
    const tampered = Buffer.from('fileB');
    const cid = await cidFor(buffer);

    expect(await verifyCIDIntegrity(tampered, cid)).toBe(false);
  });
});
