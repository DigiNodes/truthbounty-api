import { createHash } from 'crypto';

export function computeSHA256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
