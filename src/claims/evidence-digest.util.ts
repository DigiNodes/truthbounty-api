import { CID } from 'multiformats/cid';

/**
 * A content digest derived from a content-addressed (CID) identifier.
 *
 * The CID is self-describing: it carries the multihash content digest for the
 * addressed bytes. Exposing this digest lets consumers verify that the content
 * served for an evidence version matches the on-chain reference without the
 * API re-implementing any protocol outcome logic (an explicit non-goal).
 */
export interface CidDigest {
  cid: string;
  version: number;
  /** Multihash digest bytes rendered as lowercase hex. */
  digestHex: string;
  /** Multicodec code of the payload (e.g. 0x55 = raw). */
  codecCode: number;
  /** Multihash function code (e.g. 0x12 = sha2-256). */
  hashCode: number;
}

/**
 * Extract the content digest encoded in a CID v0/v1 string.
 * Returns null when the string is not a parseable CID (malformed input),
 * so the caller can treat it as invalid rather than crashing.
 */
export function extractCidDigest(cidStr: string): CidDigest | null {
  try {
    const cid = CID.parse(cidStr);
    if (!cid || !cid.multihash || !cid.multihash.digest) {
      return null;
    }
    return {
      cid: cidStr,
      version: cid.version,
      digestHex: Buffer.from(cid.multihash.digest).toString('hex'),
      codecCode: cid.code,
      hashCode: cid.multihash.code,
    };
  } catch {
    return null;
  }
}
