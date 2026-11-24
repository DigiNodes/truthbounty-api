import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import {
  DEFAULT_ALLOWED_METHODS,
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_ALLOWED_PROTOCOLS,
  SENSITIVE_HEADERS_TO_STRIP,
  SSRF_DEFAULTS,
} from './ssrf.constants';
import {
  validateTargetUrl,
  resolveAndValidateDns,
  SsrfSecurityException,
  SsrfValidatorOptions,
} from './ssrf-url-validator';
import { validateIpAddress } from './ip-parser.util';

export interface SafeHttpRequestOptions {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string | Buffer | Uint8Array;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxRedirects?: number;
  maxResponseSizeBytes?: number;
  allowedProtocols?: readonly string[];
  allowedPorts?: readonly number[];
  allowedMethods?: readonly string[];
  allowPrivateIps?: boolean;
  signal?: AbortSignal;
  customDnsResolver?: (
    host: string,
    opts: dns.LookupAllOptions,
  ) => Promise<dns.LookupAddress[]>;
}

export interface SafeHttpResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  url: string;
  body: Buffer;
  ok: boolean;
  text(): string;
  json<T = unknown>(): T;
}

@Injectable()
export class SafeHttpClientService {
  private readonly logger = new Logger(SafeHttpClientService.name);

  /**
   * Executes a safe outbound HTTP request enforcing SSRF defenses:
   * - URL and scheme parsing
   * - DNS revalidation at TCP connection time
   * - Cross-origin credential stripping on redirects
   * - Max redirect bounding
   * - Method allowlisting
   * - Response size and timeout bounding
   * - Cancellation via AbortSignal
   */
  async request(
    targetUrl: string,
    options: SafeHttpRequestOptions = {},
  ): Promise<SafeHttpResponse> {
    const method = (options.method || 'GET').toUpperCase();
    const allowedMethods = options.allowedMethods ?? DEFAULT_ALLOWED_METHODS;

    if (!allowedMethods.includes(method)) {
      throw new SsrfSecurityException(
        `HTTP method '${method}' is not allowed. Allowed methods: ${allowedMethods.join(', ')}`,
        'METHOD_NOT_ALLOWED',
      );
    }

    const maxRedirects = options.maxRedirects ?? SSRF_DEFAULTS.MAX_REDIRECTS;
    const maxResponseSizeBytes =
      options.maxResponseSizeBytes ?? SSRF_DEFAULTS.MAX_RESPONSE_SIZE_BYTES;
    const connectTimeoutMs =
      options.connectTimeoutMs ?? SSRF_DEFAULTS.CONNECT_TIMEOUT_MS;
    const requestTimeoutMs =
      options.requestTimeoutMs ?? SSRF_DEFAULTS.REQUEST_TIMEOUT_MS;

    let currentUrlStr = targetUrl;
    let currentMethod = method;
    let currentBody = options.body;
    const currentHeaders: Record<string, string | string[]> = {};

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        if (v !== undefined) {
          currentHeaders[k.toLowerCase()] = v;
        }
      }
    }

    let redirectCount = 0;

    while (true) {
      if (options.signal?.aborted) {
        throw new SsrfSecurityException('Request aborted by caller', 'ABORTED');
      }

      const validatorOpts: SsrfValidatorOptions = {
        allowedProtocols: options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS,
        allowedPorts: options.allowedPorts ?? DEFAULT_ALLOWED_PORTS,
        allowPrivateIps: options.allowPrivateIps,
      };

      // 1. Initial URL validation
      const validated = validateTargetUrl(currentUrlStr, validatorOpts);

      // 2. Pre-flight DNS validation
      await resolveAndValidateDns(validated.hostname, {
        allowPrivateIps: options.allowPrivateIps,
        dnsResolver: options.customDnsResolver,
      });

      // 3. Perform bounded HTTP request with connection-time DNS revalidation
      const res = await this.executeSingleRequest({
        targetUrl: validated.url,
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        connectTimeoutMs,
        requestTimeoutMs,
        maxResponseSizeBytes,
        allowPrivateIps: options.allowPrivateIps,
        signal: options.signal,
        customDnsResolver: options.customDnsResolver,
      });

      // Check for redirect responses (301, 302, 303, 307, 308)
      const isRedirect =
        [301, 302, 303, 307, 308].includes(res.status) && res.headers.location;

      if (!isRedirect) {
        return res;
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new SsrfSecurityException(
          `Maximum redirects (${maxRedirects}) exceeded`,
          'MAX_REDIRECTS_EXCEEDED',
        );
      }

      const locationHeader = res.headers.location as string;
      const nextUrl = new URL(locationHeader, currentUrlStr);

      // Check cross-origin redirect
      const previousOrigin = new URL(currentUrlStr).origin;
      const nextOrigin = nextUrl.origin;
      const isCrossOrigin = previousOrigin !== nextOrigin;

      if (isCrossOrigin) {
        // Strip sensitive credentials on cross-origin redirect
        for (const sensitiveHeader of SENSITIVE_HEADERS_TO_STRIP) {
          delete currentHeaders[sensitiveHeader];
        }
      }

      // Handle HTTP method transitions on redirect per RFC specifications
      if (res.status === 303) {
        currentMethod = 'GET';
        currentBody = undefined;
        delete currentHeaders['content-length'];
        delete currentHeaders['content-type'];
      } else if (
        (res.status === 301 || res.status === 302) &&
        currentMethod === 'POST'
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
        delete currentHeaders['content-length'];
        delete currentHeaders['content-type'];
      }

      currentUrlStr = nextUrl.toString();
    }
  }

  /**
   * Helper for GET requests.
   */
  async get(
    url: string,
    options: Omit<SafeHttpRequestOptions, 'method'> = {},
  ): Promise<SafeHttpResponse> {
    return this.request(url, { ...options, method: 'GET' });
  }

  /**
   * Helper for POST requests.
   */
  async post(
    url: string,
    body?: string | Buffer | Uint8Array,
    options: Omit<SafeHttpRequestOptions, 'method' | 'body'> = {},
  ): Promise<SafeHttpResponse> {
    return this.request(url, { ...options, method: 'POST', body });
  }

  /**
   * Executes a single HTTP request using connection-level DNS lookup revalidation.
   */
  private executeSingleRequest(params: {
    targetUrl: URL;
    method: string;
    headers: Record<string, string | string[]>;
    body?: string | Buffer | Uint8Array;
    connectTimeoutMs: number;
    requestTimeoutMs: number;
    maxResponseSizeBytes: number;
    allowPrivateIps?: boolean;
    signal?: AbortSignal;
    customDnsResolver?: (
      host: string,
      opts: dns.LookupAllOptions,
    ) => Promise<dns.LookupAddress[]>;
  }): Promise<SafeHttpResponse> {
    return new Promise((resolve, reject) => {
      const {
        targetUrl,
        method,
        headers,
        body,
        connectTimeoutMs,
        requestTimeoutMs,
        maxResponseSizeBytes,
        allowPrivateIps,
        signal,
        customDnsResolver,
      } = params;

      if (signal?.aborted) {
        return reject(
          new SsrfSecurityException('Request aborted by caller', 'ABORTED'),
        );
      }

      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const defaultPort = isHttps ? 443 : 80;
      const port = targetUrl.port ? parseInt(targetUrl.port, 10) : defaultPort;

      // Custom DNS lookup invoked right at socket connection time
      // This defends directly against DNS rebinding (TOCTOU attacks)
      const connectionLookup: https.RequestOptions['lookup'] = (
        hostname,
        _lookupOptions,
        callback,
      ) => {
        const resolvePromise = customDnsResolver
          ? customDnsResolver(hostname, { all: true })
          : dns.promises.lookup(hostname, { all: true });

        resolvePromise
          .then((addresses) => {
            if (!addresses || addresses.length === 0) {
              const err = new Error(
                `No DNS records resolved at connection for ${hostname}`,
              ) as NodeJS.ErrnoException;
              err.code = 'ENOTFOUND';
              return callback(err, '');
            }

            // Re-validate every resolved IP at connection time
            for (const record of addresses) {
              const validation = validateIpAddress(record.address);
              if (validation.isForbidden) {
                const isMetadata =
                  validation.reason?.includes('cloud metadata');
                if (isMetadata || !allowPrivateIps) {
                  const err = new SsrfSecurityException(
                    `Connection-time DNS rebinding blocked: '${record.address}' is forbidden: ${validation.reason}`,
                    'DNS_REBINDING_BLOCKED',
                  );
                  return callback(err as unknown as NodeJS.ErrnoException, '');
                }
              }
            }

            // Safely pass the validated IP address
            const chosen = addresses[0];
            callback(null, chosen.address, chosen.family);
          })
          .catch((err) => {
            callback(err as NodeJS.ErrnoException, '');
          });
      };

      const requestOptions: https.RequestOptions = {
        hostname: targetUrl.hostname,
        port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: {
          ...headers,
          host: targetUrl.host,
        },
        lookup: connectionLookup,
      };

      let req: http.ClientRequest;
      let overallTimer: NodeJS.Timeout | null = null;
      let connectTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = () => {
        if (overallTimer) clearTimeout(overallTimer);
        if (connectTimer) clearTimeout(connectTimer);
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          req.destroy(err);
        } catch {
          // ignore
        }
        reject(err);
      };

      const onAbort = () => {
        safeReject(
          new SsrfSecurityException('Request aborted by caller', 'ABORTED'),
        );
      };

      if (signal) {
        signal.addEventListener('abort', onAbort);
      }

      try {
        req = transport.request(requestOptions, (res) => {
          if (connectTimer) clearTimeout(connectTimer);

          // Pre-check Content-Length header against maxResponseSizeBytes
          const contentLengthStr = res.headers['content-length'];
          if (contentLengthStr) {
            const contentLength = parseInt(contentLengthStr, 10);
            if (!isNaN(contentLength) && contentLength > maxResponseSizeBytes) {
              return safeReject(
                new SsrfSecurityException(
                  `Response Content-Length (${contentLength} bytes) exceeds limit of ${maxResponseSizeBytes} bytes`,
                  'RESPONSE_TOO_LARGE',
                ),
              );
            }
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > maxResponseSizeBytes) {
              res.destroy();
              return safeReject(
                new SsrfSecurityException(
                  `Response exceeded maximum allowed size of ${maxResponseSizeBytes} bytes`,
                  'RESPONSE_TOO_LARGE',
                ),
              );
            }
            chunks.push(chunk);
          });

          res.on('end', () => {
            if (settled) return;
            settled = true;
            cleanup();

            const fullBuffer = Buffer.concat(chunks);
            const status = res.statusCode || 0;
            const ok = status >= 200 && status < 300;

            const safeResponse: SafeHttpResponse = {
              status,
              statusText: res.statusMessage || '',
              headers: res.headers,
              url: targetUrl.toString(),
              body: fullBuffer,
              ok,
              text(): string {
                return fullBuffer.toString('utf8');
              },
              json<T = unknown>(): T {
                try {
                  return JSON.parse(fullBuffer.toString('utf8')) as T;
                } catch (e: unknown) {
                  const msg = e instanceof Error ? e.message : String(e);
                  throw new SsrfSecurityException(
                    `Failed to parse response body as JSON: ${msg}`,
                    'INVALID_JSON',
                  );
                }
              },
            };

            resolve(safeResponse);
          });

          res.on('error', (err) => {
            safeReject(err);
          });
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return safeReject(error);
      }

      // Connection timeout
      connectTimer = setTimeout(() => {
        safeReject(
          new SsrfSecurityException(
            `Connection timed out after ${connectTimeoutMs}ms`,
            'CONNECT_TIMEOUT',
          ),
        );
      }, connectTimeoutMs);

      // Overall request timeout
      overallTimer = setTimeout(() => {
        safeReject(
          new SsrfSecurityException(
            `Request timed out after ${requestTimeoutMs}ms`,
            'REQUEST_TIMEOUT',
          ),
        );
      }, requestTimeoutMs);

      req.on('socket', (socket) => {
        socket.on('connect', () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
        });
      });

      req.on('error', (err) => {
        safeReject(err);
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}
