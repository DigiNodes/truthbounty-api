import { IpfsService } from './ipfs.service';

describe('IpfsService gateway sanitization', () => {
  it('allows https gateway URLs', () => {
    const provider: any = {
      getUrl: () => 'https://ipfs.io/ipfs/QmTest',
    };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBe('https://ipfs.io/ipfs/QmTest');
  });

  it('allows http gateway URLs', () => {
    const provider: any = {
      getUrl: () => 'http://example.com/ipfs/QmTest',
    };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBe('http://example.com/ipfs/QmTest');
  });

  it('rejects javascript: URLs', () => {
    const provider: any = { getUrl: () => 'javascript:alert(1)' };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
  });

  it('rejects data: URLs', () => {
    const provider: any = {
      getUrl: () => 'data:text/html,<svg/onload=alert(1)>',
    };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
  });

  it('rejects URLs with angle brackets or newlines', () => {
    const provider: any = {
      getUrl: () => 'https://example.com/?q=<script>',
    };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
  });

  it('rejects loopback, link-local, and private-network gateway URLs', () => {
    for (const url of [
      'http://127.0.0.1/ipfs/QmTest',
      'http://169.254.169.254/latest/meta-data/ipfs/QmTest',
      'http://10.0.0.1/ipfs/QmTest',
    ]) {
      const provider: any = { getUrl: () => url };
      const svc = new IpfsService(provider);

      expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
    }
  });

  it('rejects IPv6 loopback and link-local gateway URLs', () => {
    for (const url of [
      'http://[::1]/ipfs/QmTest',
      'http://[fe80::1]/ipfs/QmTest',
      'http://[::ffff:7f00:1]/ipfs/QmTest',
      'http://[fc00::1]/ipfs/QmTest',
    ]) {
      const provider: any = { getUrl: () => url };
      const svc = new IpfsService(provider);

      expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
    }
  });

  it('rejects gateway URLs with credentials or nonstandard ports', () => {
    for (const url of [
      'https://user:password@gateway.example/ipfs/QmTest',
      'https://gateway.example:8080/ipfs/QmTest',
    ]) {
      const provider: any = { getUrl: () => url };
      const svc = new IpfsService(provider);

      expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
    }
  });

  it('rejects local and internal gateway hostnames', () => {
    for (const url of [
      'http://localhost/ipfs/QmTest',
      'http://node.local/ipfs/QmTest',
      'http://service.internal/ipfs/QmTest',
      'http://metadata.google.internal/ipfs/QmTest',
    ]) {
      const provider: any = { getUrl: () => url };
      const svc = new IpfsService(provider);

      expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
    }
  });

  it('rejects malformed gateway URLs', () => {
    const provider: any = { getUrl: () => 'https://[invalid-host/ipfs/QmTest' };
    const svc = new IpfsService(provider);

    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
  });

  it('returns URL that contains the provided CID', () => {
    const provider: any = {
      getUrl: (cid: string) => `https://gateway.example.com/ipfs/${cid}`,
    };
    const svc = new IpfsService(provider);
    const out = svc.getGatewayUrl('QmExampleCid');
    expect(out).toBeDefined();
    expect(out).toContain('QmExampleCid');
  });

  it('trims provider strings and is idempotent', () => {
    const provider: any = {
      getUrl: () => '  https://trim.example.com/ipfs/QmTrim  ',
    };
    const svc = new IpfsService(provider);
    const first = svc.getGatewayUrl('QmTrim');
    const second = svc.getGatewayUrl('QmTrim');
    expect(first).toBe('https://trim.example.com/ipfs/QmTrim');
    expect(second).toBe(first);
  });

  it('does not log credentials or query values when URL parsing fails', () => {
    const rawUrl =
      'https://user:USERINFO_CANARY@[invalid-host/?token=QUERY_CANARY';
    const svc = new IpfsService({ getUrl: () => rawUrl } as any);
    const warnSpy = jest
      .spyOn(svc['logger'], 'warn')
      .mockImplementation(() => undefined);

    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();

    const warning = warnSpy.mock.calls.flat().join(' ');
    expect(warning).toContain('(invalid_url)');
    expect(warning).not.toContain('USERINFO_CANARY');
    expect(warning).not.toContain('QUERY_CANARY');
    expect(warning).not.toContain(rawUrl);
  });

  it('does not log provider-derived hostnames containing tenant canaries', () => {
    const rawUrl =
      'https://TENANT-HOST-CANARY.gateway.example.com:8443/private/path?token=HOST_QUERY_CANARY';
    const svc = new IpfsService({ getUrl: () => rawUrl } as any);
    const warnSpy = jest
      .spyOn(svc['logger'], 'warn')
      .mockImplementation(() => undefined);

    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();

    const warning = warnSpy.mock.calls.flat().join(' ');
    expect(warning).toContain('(unsupported_port)');
    expect(warning).not.toContain('TENANT-HOST-CANARY');
    expect(warning).not.toContain('gateway.example.com');
    expect(warning).not.toContain('private/path');
    expect(warning).not.toContain('HOST_QUERY_CANARY');
  });

  it('rejects unsafe and malformed URLs without echoing provider data', () => {
    const rawUrls = [
      'https://gateway.example.com/\u0001private?token=CONTROL_CANARY',
      'https://gateway.example.com/\u0085private?token=C1_CANARY',
      'https://gateway.example.com/<script>?token=ANGLE_CANARY',
      'https://gateway.example.com/%E0%A4%A?token=ENCODING_CANARY',
      'https://10.0.0.1/private/path?token=PRIVATE_CANARY',
      'ftp://gateway.example.com/private/path?token=SCHEME_CANARY',
    ];

    for (const rawUrl of rawUrls) {
      const svc = new IpfsService({ getUrl: () => rawUrl } as any);
      const warnSpy = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined);

      expect(svc.getGatewayUrl('QmTest')).toBeUndefined();

      const warning = warnSpy.mock.calls.flat().join(' ');
      expect(warning).not.toContain(rawUrl);
      expect(warning).not.toMatch(
        /CONTROL_CANARY|C1_CANARY|ANGLE_CANARY|ENCODING_CANARY|PRIVATE_CANARY|SCHEME_CANARY/,
      );
      expect(warning).not.toContain('/private/path');
      expect(warning).not.toContain('token=');
    }
  });

  it('normalizes and accepts safe public gateway URLs', () => {
    const svc = new IpfsService({
      getUrl: () => 'HTTPS://Gateway.Example.com:443/ipfs/QmTest',
    } as any);

    expect(svc.getGatewayUrl('QmTest')).toBe(
      'https://gateway.example.com/ipfs/QmTest',
    );
  });

  it('logs provider errors without stringifying their messages', () => {
    const error = new Error(
      'provider failed for https://gateway.example.com/?token=ERROR_CANARY',
    );
    const svc = new IpfsService({
      getUrl: () => {
        throw error;
      },
    } as any);
    const errorSpy = jest
      .spyOn(svc['logger'], 'error')
      .mockImplementation(() => undefined);

    expect(() => svc.getGatewayUrl('QmTest')).toThrow(error);

    const loggedError = errorSpy.mock.calls.flat().join(' ');
    expect(loggedError).toContain('(provider_error)');
    expect(loggedError).not.toContain('ERROR_CANARY');
    expect(loggedError).not.toContain(error.message);
  });
});
