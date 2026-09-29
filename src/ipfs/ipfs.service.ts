import { Inject, Injectable, Logger } from '@nestjs/common';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'stream';
import { IPFS_PROVIDER, IpfsAddResult, IpfsProvider } from './interfaces';

type AddressFamily = 'ipv4' | 'ipv6';

const blockedGatewayAddresses = new BlockList();
const blockedGatewaySubnets: Array<[string, number, AddressFamily]> = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
];

for (const [address, prefix, family] of blockedGatewaySubnets) {
  blockedGatewayAddresses.addSubnet(address, prefix, family);
}

const isUnsafeHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const addressFamily = isIP(normalized);
  if (addressFamily === 4 || addressFamily === 6) {
    return blockedGatewayAddresses.check(
      normalized,
      addressFamily === 4 ? 'ipv4' : 'ipv6',
    );
  }

  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized === 'metadata.google.internal'
  );
};

/**
 * High-level IPFS service providing deterministic, provider-agnostic uploads.
 * - Accepts streams to remain memory-safe
 * - Returns deterministic content-addressed IDs (CID-like)
 */
@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  constructor(@Inject(IPFS_PROVIDER) private provider: IpfsProvider) {}

  async uploadStream(
    stream: Readable,
    filename?: string,
  ): Promise<IpfsAddResult> {
    this.logger.debug('Uploading stream to IPFS provider');
    const result = await this.provider.add(stream, { filename });
    return result;
  }

  async uploadBuffer(
    buffer: Buffer,
    filename?: string,
  ): Promise<IpfsAddResult> {
    const stream = Readable.from(buffer);
    return this.uploadStream(stream, filename);
  }

  getGatewayUrl(cid: string): string | undefined {
    if (typeof this.provider.getUrl !== 'function') return undefined;

    const raw = this.provider.getUrl(cid);
    if (!raw) return undefined;

    return this.sanitizeGatewayUrl(raw);
  }

  /**
   * Sanitize a gateway URL returned by an IPFS provider.
   * - Only allow http/https schemes
   * - Reject URLs containing control characters or angle brackets
   * - Return a normalized URL string or undefined for unsafe values
   */
  private sanitizeGatewayUrl(urlStr: string): string | undefined {
    try {
      // Trim and disallow characters commonly used in XSS vectors in the raw provider string
      const raw = typeof urlStr === 'string' ? urlStr.trim() : '';
      if (!raw) return undefined;

      const unsafePattern = /[<>\r\n]/;
      if (unsafePattern.test(raw)) return undefined;

      const url = new URL(raw);

      // Only allow http(s)
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return undefined;

      // Gateway URLs must not target private infrastructure or carry credentials.
      if (
        url.username ||
        url.password ||
        (url.port !== '' && url.port !== '80' && url.port !== '443') ||
        isUnsafeHostname(url.hostname)
      ) {
        return undefined;
      }

      // Return normalized URL (this will percent-encode parts as needed)
      return url.toString();
    } catch {
      this.logger.warn(`Invalid gateway URL from provider: ${urlStr}`);
      return undefined;
    }
  }
}
