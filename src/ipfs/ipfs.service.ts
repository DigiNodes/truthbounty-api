import { Inject, Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { IPFS_PROVIDER, IpfsAddResult, IpfsProvider } from './interfaces';

/**
 * High-level IPFS service providing deterministic, provider-agnostic uploads.
 * - Accepts streams to remain memory-safe
 * - Returns deterministic content-addressed IDs (CID-like)
 */
@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  constructor(@Inject(IPFS_PROVIDER) private provider: IpfsProvider) {}

  async uploadStream(stream: Readable, filename?: string): Promise<IpfsAddResult> {
    this.logger.debug('Uploading stream to IPFS provider');
    const result = await this.provider.add(stream, { filename });
    return result;
  }

  async uploadBuffer(buffer: Buffer, filename?: string): Promise<IpfsAddResult> {
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
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

      // Return normalized URL (this will percent-encode parts as needed)
      return url.toString();
    } catch (err) {
      this.logger.warn(`Invalid gateway URL from provider: ${urlStr}`);
      return undefined;
    }
  }
}
