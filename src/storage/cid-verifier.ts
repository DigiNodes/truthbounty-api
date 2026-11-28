import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { timingSafeEqualBytes } from '../common/utils/timing-safe.util';
import {
  EVIDENCE_CID_CODEC_ALLOWLIST,
  EVIDENCE_CID_SHA256_DIGEST_LENGTH,
  EVIDENCE_CID_SHA256_MULTIHASH_CODE,
  EVIDENCE_CID_VERSION,
} from './evidence-cid.constants';

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function parseEvidenceCID(returnedCid: string): CID | null {
  try {
    const cid = CID.parse(returnedCid);
    if (
      cid.version !== EVIDENCE_CID_VERSION ||
      !EVIDENCE_CID_CODEC_ALLOWLIST.some((codec) => codec === cid.code) ||
      cid.multihash.code !== EVIDENCE_CID_SHA256_MULTIHASH_CODE ||
      cid.multihash.digest.length !== EVIDENCE_CID_SHA256_DIGEST_LENGTH
    ) {
      return null;
    }

    // Reject non-canonical varint encodings of otherwise valid CID fields.
    const canonicalBytes = CID.createV1(cid.code, cid.multihash).bytes;
    return bytesEqual(cid.bytes, canonicalBytes) ? cid : null;
  } catch {
    return null;
  }
}

export function canonicalizeEvidenceCID(returnedCid: string): string | null {
  return parseEvidenceCID(returnedCid)?.toString() ?? null;
}

export async function verifyCIDIntegrity(
  fileBuffer: Buffer,
  returnedCid: string,
): Promise<boolean> {
  try {
    const cid = parseEvidenceCID(returnedCid);
    if (!cid) return false;

    // Compute SHA-256 digest of content
    const hash = await sha256.digest(fileBuffer);

    return (
      hash.code === EVIDENCE_CID_SHA256_MULTIHASH_CODE &&
      timingSafeEqualBytes(
        Buffer.from(cid.multihash.digest),
        Buffer.from(hash.digest),
      )
    );
  } catch {
    return false;
  }
}
