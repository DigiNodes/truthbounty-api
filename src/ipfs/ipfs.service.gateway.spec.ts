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
});
