import {
  IpfsFetchOptions,
  IpfsProvider,
  IpfsProviderResponse,
} from './ipfs-provider.interface';

/**
 * HTTP gateway provider. Redirects are never followed (a 3xx is surfaced to
 * the quorum service, which rejects it), and the body is size-capped.
 * The gateway URL is only a transport detail; identity remains the CID.
 */
export class HttpGatewayProvider implements IpfsProvider {
  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetch(
    cid: string,
    options: IpfsFetchOptions,
  ): Promise<IpfsProviderResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/ipfs/${encodeURIComponent(cid)}`;
    const response = await this.fetchImpl(url, {
      redirect: 'manual',
      signal: options.signal,
    });
    if (response.status !== 200) {
      return { status: response.status, bytes: new Uint8Array() };
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > options.maxBytes) {
      return { status: 200, bytes: new Uint8Array(options.maxBytes + 1) };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: 200, bytes };
  }
}
