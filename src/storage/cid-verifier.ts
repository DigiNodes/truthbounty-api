import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

export async function verifyCIDIntegrity(
  fileBuffer: Buffer,
  returnedCid: string
): Promise<boolean> {
  try {
    const cid = CID.parse(returnedCid);

    // Enforce CID v1
    if (cid.version !== 1) return false;

    // Compute SHA-256 digest of content
    const hash = await sha256.digest(fileBuffer);

    // Extract digest from CID
    const cidDigest = cid.multihash.digest;

    // Compare full digest (byte-by-byte)
    if (cidDigest.length !== hash.digest.length) return false;

    for (let i = 0; i < cidDigest.length; i++) {
      if (cidDigest[i] !== hash.digest[i]) return false;
    }

    return true;
  } catch {
    return false;
  }
}