import { base32 } from 'multiformats/bases/base32';
import { CID } from 'multiformats/cid';
import { Digest } from 'multiformats/hashes/digest';
import { sha256 } from 'multiformats/hashes/sha2';
import { verifyCIDIntegrity } from './cid-verifier';
import {
  EVIDENCE_CID_RAW_CODEC,
  EVIDENCE_CID_SHA256_MULTIHASH_CODE,
} from './evidence-cid.constants';

describe('verifyCIDIntegrity', () => {
  const content = Buffer.from('protocol-approved evidence');
  let validCid: string;
  let digest: Uint8Array;

  beforeAll(async () => {
    const hash = await sha256.digest(content);
    digest = hash.digest;
    validCid = CID.createV1(EVIDENCE_CID_RAW_CODEC, hash).toString();
  });

  it('accepts protocol-approved CIDv1 raw/sha2-256 evidence', async () => {
    expect(await verifyCIDIntegrity(content, validCid)).toBe(true);
  });

  it('rejects a different multihash code even with the same digest bytes', async () => {
    const substitutedHash = Digest.create(0x13, digest);
    const cid = CID.createV1(
      EVIDENCE_CID_RAW_CODEC,
      substitutedHash,
    ).toString();

    expect(await verifyCIDIntegrity(content, cid)).toBe(false);
  });

  it('rejects unsupported codecs, CIDv0, and identity multihashes', async () => {
    const unsupportedCodecCid = CID.createV1(
      0x71,
      Digest.create(EVIDENCE_CID_SHA256_MULTIHASH_CODE, digest),
    ).toString();
    const cidV0 = CID.createV0(await sha256.digest(content)).toString();
    const identityCid = CID.createV1(
      EVIDENCE_CID_RAW_CODEC,
      Digest.create(0x00, content),
    ).toString();

    for (const cid of [unsupportedCodecCid, cidV0, identityCid]) {
      expect(await verifyCIDIntegrity(content, cid)).toBe(false);
    }
  });

  it('rejects malformed, truncated, and non-canonical varint encodings', async () => {
    const truncatedVersion = base32.encode(Uint8Array.of(0x81));
    const truncatedHashCode = base32.encode(
      Uint8Array.of(0x01, EVIDENCE_CID_RAW_CODEC, 0x92),
    );
    const truncatedDigest = base32.encode(
      Uint8Array.from([
        0x01,
        EVIDENCE_CID_RAW_CODEC,
        EVIDENCE_CID_SHA256_MULTIHASH_CODE,
        digest.length,
        ...digest.slice(0, -1),
      ]),
    );
    const nonCanonicalVersion = base32.encode(
      Uint8Array.from([
        0x81,
        0x00,
        EVIDENCE_CID_RAW_CODEC,
        EVIDENCE_CID_SHA256_MULTIHASH_CODE,
        digest.length,
        ...digest,
      ]),
    );

    expect(await verifyCIDIntegrity(content, truncatedVersion)).toBe(false);
    expect(await verifyCIDIntegrity(content, truncatedHashCode)).toBe(false);
    expect(await verifyCIDIntegrity(content, truncatedDigest)).toBe(false);
    expect(await verifyCIDIntegrity(content, nonCanonicalVersion)).toBe(false);
  });

  it('rejects tampered content', async () => {
    expect(
      await verifyCIDIntegrity(Buffer.from('tampered evidence'), validCid),
    ).toBe(false);
  });
});
