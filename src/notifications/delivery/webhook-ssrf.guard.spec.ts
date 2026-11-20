import {
  parseWebhookUrl,
  isUnsafeIp,
  resolveHostname,
  validateWebhookDestination,
  createValidatingDnsLookup,
  DEFAULT_WEBHOOK_PORTS,
  type WebhookUrlOptions,
} from './webhook-ssrf.guard';

const HTTPS_OPTS: WebhookUrlOptions = { requireHttps: true };
const HTTP_OK_OPTS: WebhookUrlOptions = { requireHttps: false };

describe('Webhook SSRF guard', () => {
  // -------------------------------------------------------------------------
  // Structural validation (parseWebhookUrl)
  // -------------------------------------------------------------------------
  describe('parseWebhookUrl — schemes', () => {
    it('rejects non-http(s) schemes', () => {
      for (const url of [
        'ftp://example.com/',
        'file:///etc/passwd',
        'gopher://example.com/',
        'javascript:alert(1)',
        'data:text/html,<x>',
      ]) {
        const res = parseWebhookUrl(url, HTTP_OK_OPTS);
        expect(res.valid).toBe(false);
      }
    });

    it('rejects http when requireHttps is set', () => {
      expect(parseWebhookUrl('http://example.com/', HTTPS_OPTS).valid).toBe(
        false,
      );
    });

    it('accepts https when requireHttps is set', () => {
      expect(parseWebhookUrl('https://example.com/', HTTPS_OPTS).valid).toBe(
        true,
      );
    });

    it('accepts http when requireHttps is false', () => {
      expect(parseWebhookUrl('http://example.com/', HTTP_OK_OPTS).valid).toBe(
        true,
      );
    });
  });

  describe('parseWebhookUrl — credentials and malformed hosts', () => {
    it('rejects embedded credentials', () => {
      expect(
        parseWebhookUrl('https://user:pass@example.com/', HTTPS_OPTS).valid,
      ).toBe(false);
      expect(
        parseWebhookUrl('https://user@example.com/', HTTPS_OPTS).valid,
      ).toBe(false);
    });

    it('rejects empty / malformed hostnames', () => {
      // A non-URL string fails to parse.
      expect(parseWebhookUrl('not a url', HTTPS_OPTS).valid).toBe(false);
      // An empty string is not a valid URL.
      expect(parseWebhookUrl('', HTTPS_OPTS).valid).toBe(false);
    });
  });

  describe('parseWebhookUrl — local / reserved hostnames', () => {
    it('rejects localhost and reserved local suffixes', () => {
      const rejected = [
        'https://localhost/',
        'https://foo.local/',
        'https://bar.localhost/',
        'https://baz.internal/',
        'https://metadata.google.internal/',
        'https://metadata/',
        'https://metadata.aws.internal/',
      ];
      for (const url of rejected) {
        expect(parseWebhookUrl(url, HTTPS_OPTS).valid).toBe(false);
      }
    });
  });

  describe('parseWebhookUrl — ports', () => {
    it('rejects ports outside the allowlist', () => {
      expect(
        parseWebhookUrl('https://example.com:8081/', HTTPS_OPTS).valid,
      ).toBe(false);
      expect(parseWebhookUrl('https://example.com:22/', HTTPS_OPTS).valid).toBe(
        false,
      );
    });

    it('accepts allowlisted ports and the protocol default', () => {
      expect(
        parseWebhookUrl('https://example.com:8443/', HTTPS_OPTS).valid,
      ).toBe(true);
      expect(parseWebhookUrl('https://example.com/', HTTPS_OPTS).valid).toBe(
        true,
      ); // defaults to 443
      expect(
        parseWebhookUrl('http://example.com:8080/', HTTP_OK_OPTS).valid,
      ).toBe(true);
    });

    it('honours a custom allowlist', () => {
      expect(
        parseWebhookUrl('https://example.com:9000/', {
          requireHttps: true,
          allowedPorts: [9000],
        }).valid,
      ).toBe(true);
    });

    it('rejects out-of-range and non-numeric ports', () => {
      expect(
        parseWebhookUrl('https://example.com:99999/', HTTPS_OPTS).valid,
      ).toBe(false);
      expect(
        parseWebhookUrl('https://example.com:abc/', HTTPS_OPTS).valid,
      ).toBe(false);
    });

    it('allows any valid port when allowAnyPort is true', () => {
      expect(
        parseWebhookUrl('https://example.com:9999/', {
          requireHttps: true,
          allowAnyPort: true,
        }).valid,
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // IP classification (isUnsafeIp)
  // -------------------------------------------------------------------------
  describe('isUnsafeIp — IPv4', () => {
    it.each([
      ['127.0.0.1', 'loopback'],
      ['127.1.2.3', 'loopback /8'],
      ['10.0.0.1', 'RFC1918 10/8'],
      ['172.16.0.1', 'RFC1918 172.16/12 lower bound'],
      ['172.31.255.254', 'RFC1918 172.16/12 upper bound'],
      ['192.168.1.1', 'RFC1918 192.168/16'],
      ['169.254.169.254', 'link-local / cloud metadata (AWS/GCP/Azure)'],
      ['0.0.0.0', 'unspecified 0/8'],
      ['0.1.2.3', '0/8'],
      ['100.64.0.1', 'carrier-grade NAT lower bound'],
      ['100.127.255.254', 'carrier-grade NAT upper bound'],
      ['192.0.0.1', 'IETF protocol assignments 192.0.0/24'],
      ['192.0.2.1', 'TEST-NET-1 documentation'],
      ['198.18.0.1', 'benchmarking 198.18/15 lower'],
      ['198.19.255.254', 'benchmarking 198.18/15 upper'],
      ['198.51.100.1', 'TEST-NET-2 documentation'],
      ['203.0.113.1', 'TEST-NET-3 documentation'],
      ['224.0.0.1', 'multicast 224/4'],
      ['239.0.0.1', 'multicast 224/4'],
      ['240.0.0.1', 'reserved 240/4'],
      ['255.255.255.255', 'broadcast / reserved'],
    ])('rejects %s (%s)', (ip) => {
      expect(isUnsafeIp(ip)).toBe(true);
    });

    it.each([
      ['8.8.8.8', 'Google DNS'],
      ['1.1.1.1', 'Cloudflare DNS'],
      ['172.32.0.1', 'just outside 172.16/12'],
      ['11.0.0.1', 'just outside 10/8'],
      ['192.169.0.1', 'just outside 192.168/16'],
    ])('accepts %s (%s)', (ip) => {
      expect(isUnsafeIp(ip)).toBe(false);
    });
  });

  describe('isUnsafeIp — IPv6', () => {
    it.each([
      ['::1', 'loopback'],
      ['::', 'unspecified'],
      ['fc00::1', 'unique local fc00/8'],
      ['fd12:3456:789a::1', 'unique local fd/8'],
      ['fe80::1', 'link-local fe80/10'],
      ['febf::1', 'link-local upper bound'],
      ['fec0::1', 'site-local (deprecated) fec0/10'],
      ['feff::1', 'site-local upper bound'],
      ['ff00::1', 'multicast ff00/8'],
      ['ff02::1', 'multicast link-scope'],
      ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
      ['::ffff:10.0.0.1', 'IPv4-mapped private'],
      ['::ffff:169.254.169.254', 'IPv4-mapped cloud metadata'],
    ])('rejects %s (%s)', (ip) => {
      expect(isUnsafeIp(ip)).toBe(true);
    });

    it.each([
      ['2606:4700:4700::1111', 'Cloudflare DNS'],
      ['2001:4860:4860::8888', 'Google DNS'],
      ['::ffff:8.8.8.8', 'IPv4-mapped public'],
    ])('accepts %s (%s)', (ip) => {
      expect(isUnsafeIp(ip)).toBe(false);
    });
  });

  it('fails closed for non-IP strings', () => {
    expect(isUnsafeIp('example.com')).toBe(true);
    expect(isUnsafeIp('')).toBe(true);
    expect(isUnsafeIp('not-an-ip')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Full destination validation (validateWebhookDestination)
  // -------------------------------------------------------------------------
  describe('validateWebhookDestination', () => {
    it('rejects literal private / loopback / metadata IPs without DNS', async () => {
      for (const url of [
        'https://127.0.0.1/',
        'https://10.0.0.1/',
        'https://192.168.1.1/',
        'https://169.254.169.254/',
        'https://[::1]/',
        'https://[fe80::1]/',
        'https://[fc00::1]/',
      ]) {
        const res = await validateWebhookDestination(url, HTTPS_OPTS);
        expect(res.valid).toBe(false);
      }
    });

    it('accepts a public literal IP', async () => {
      const res = await validateWebhookDestination(
        'https://8.8.8.8/',
        HTTPS_OPTS,
      );
      expect(res.valid).toBe(true);
      expect(res.resolvedAddresses).toEqual(['8.8.8.8']);
    });

    it('rejects a public hostname resolving to a private/reserved address', async () => {
      const resolve = async () => ['10.1.2.3'];
      const res = await validateWebhookDestination(
        'https://public-looking.example/',
        {
          ...HTTPS_OPTS,
          resolve,
        },
      );
      expect(res.valid).toBe(false);
    });

    it('rejects when any resolved address is private (mixed A record set)', async () => {
      const resolve = async () => ['8.8.8.8', '127.0.0.1'];
      const res = await validateWebhookDestination('https://mix.example/', {
        ...HTTPS_OPTS,
        resolve,
      });
      expect(res.valid).toBe(false);
    });

    it('accepts a public hostname resolving to public addresses', async () => {
      const resolve = async () => ['93.184.216.34'];
      const res = await validateWebhookDestination('https://example.com/', {
        ...HTTPS_OPTS,
        resolve,
      });
      expect(res.valid).toBe(true);
      expect(res.resolvedAddresses).toEqual(['93.184.216.34']);
    });

    it('rejects when DNS resolution fails', async () => {
      const resolve = async () => {
        throw new Error('ENOTFOUND');
      };
      const res = await validateWebhookDestination('https://nope.example/', {
        ...HTTPS_OPTS,
        resolve,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('could not be resolved');
    });

    it('rejects when the hostname resolves to no addresses', async () => {
      const resolve = async () => [];
      const res = await validateWebhookDestination('https://empty.example/', {
        ...HTTPS_OPTS,
        resolve,
      });
      expect(res.valid).toBe(false);
    });

    it('rejects cloud metadata hostname by name before resolving', async () => {
      const resolve = jest.fn(async () => ['8.8.8.8']);
      const res = await validateWebhookDestination(
        'https://metadata.google.internal/',
        { ...HTTPS_OPTS, resolve },
      );
      expect(res.valid).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // DNS-rebinding-safe lookup (createValidatingDnsLookup)
  // -------------------------------------------------------------------------
  describe('createValidatingDnsLookup (DNS rebinding protection)', () => {
    it('blocks when the address set changes to private between validation and connection (rebinding)', async () => {
      let calls = 0;
      const resolve = async () => {
        calls += 1;
        // First call (save-time validation) → public; second call (connection
        // lookup) → private. This is the rebinding attack.
        return calls === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
      };

      // Save-time validation passes (public).
      const pre = await validateWebhookDestination('https://rebind.example/', {
        ...HTTPS_OPTS,
        resolve,
      });
      expect(pre.valid).toBe(true);

      // The connection-time lookup uses the SAME resolver and now sees private.
      const lookup = createValidatingDnsLookup(resolve);
      const result = await new Promise<{ err: Error | null; address?: string }>(
        (resolveCb) => {
          lookup('rebind.example', {}, (err, address) =>
            resolveCb({
              err: err as Error | null,
              address: address as string | undefined,
            }),
          );
        },
      );
      expect(result.err).not.toBeNull();
      expect(result.err?.message).toContain('private or internal');
      // When blocked, no address is returned.
      expect(result.address).toBeFalsy();
    });

    it('allows the connection when addresses stay public', async () => {
      const resolve = async () => ['93.184.216.34'];
      const lookup = createValidatingDnsLookup(resolve);
      const result = await new Promise<{
        err: Error | null;
        address?: string;
        family?: number;
      }>((resolveCb) => {
        lookup('example.com', {}, (err, address, family) =>
          resolveCb({
            err: err as Error | null,
            address: address as string | undefined,
            family,
          }),
        );
      });
      expect(result.err).toBeNull();
      expect(result.address).toBe('93.184.216.34');
      expect(result.family).toBe(4);
    });

    it('returns all validated addresses when options.all is set', async () => {
      const resolve = async () => [
        '93.184.216.34',
        '2606:2800:220:1:248:1893:25c8:1946',
      ];
      const lookup = createValidatingDnsLookup(resolve);
      const result = await new Promise<{
        err: Error | null;
        addresses?: unknown[];
      }>((resolveCb) => {
        lookup('example.com', { all: true }, (err, addresses) =>
          resolveCb({
            err: err as Error | null,
            addresses: addresses as unknown[] | undefined,
          }),
        );
      });
      expect(result.err).toBeNull();
      expect(result.addresses).toHaveLength(2);
    });

    it('validates literal-IP hostnames directly without DNS', async () => {
      const resolve = jest.fn(async () => ['8.8.8.8']);
      const lookup = createValidatingDnsLookup(resolve);

      // Unsafe literal → blocked, no DNS call.
      const blocked = await new Promise<{ err: Error | null }>((resolveCb) => {
        lookup('127.0.0.1', {}, (err) =>
          resolveCb({ err: err as Error | null }),
        );
      });
      expect(blocked.err).not.toBeNull();
      expect(resolve).not.toHaveBeenCalled();

      // Safe literal → returned directly, no DNS call.
      const ok = await new Promise<{ err: Error | null; address?: string }>(
        (resolveCb) => {
          lookup('8.8.8.8', {}, (err, address) =>
            resolveCb({
              err: err as Error | null,
              address: address as string | undefined,
            }),
          );
        },
      );
      expect(ok.err).toBeNull();
      expect(ok.address).toBe('8.8.8.8');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('blocks when a resolved address is private even if others are public', async () => {
      const resolve = async () => ['93.184.216.34', '169.254.169.254'];
      const lookup = createValidatingDnsLookup(resolve);
      const result = await new Promise<{ err: Error | null }>((resolveCb) => {
        lookup('mix.example', {}, (err) =>
          resolveCb({ err: err as Error | null }),
        );
      });
      expect(result.err).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Consistency
  // -------------------------------------------------------------------------
  it('exposes a narrow default port allowlist', () => {
    expect([...DEFAULT_WEBHOOK_PORTS]).toEqual([80, 443, 8080, 8443]);
  });

  it('resolveHostname uses the provided resolver', async () => {
    const resolve = async () => ['1.2.3.4'];
    expect(await resolveHostname('x', resolve)).toEqual(['1.2.3.4']);
  });
});
