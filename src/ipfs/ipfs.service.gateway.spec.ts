import { IpfsService } from './ipfs.service';

describe('IpfsService gateway sanitization', () => {
  it('allows https gateway URLs', () => {
    const provider: any = { getUrl: (_cid: string) => 'https://ipfs.io/ipfs/QmTest' };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBe('https://ipfs.io/ipfs/QmTest');
  });

  it('allows http gateway URLs', () => {
    const provider: any = { getUrl: (_cid: string) => 'http://example.com/ipfs/QmTest' };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBe('http://example.com/ipfs/QmTest');
  });

  it('rejects javascript: URLs', () => {
    const provider: any = { getUrl: (_cid: string) => 'javascript:alert(1)' };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
  });

  it('rejects data: URLs', () => {
    const provider: any = { getUrl: (_cid: string) => 'data:text/html,<svg/onload=alert(1)>' };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
  });

  it('rejects URLs with angle brackets or newlines', () => {
    const provider: any = { getUrl: (_cid: string) => 'https://example.com/?q=<script>' };
    const svc = new IpfsService(provider);
    expect(svc.getGatewayUrl('QmTest')).toBeUndefined();
  });

  it('returns URL that contains the provided CID', () => {
    const provider: any = { getUrl: (cid: string) => `https://gateway.example.com/ipfs/${cid}` };
    const svc = new IpfsService(provider);
    const out = svc.getGatewayUrl('QmExampleCid');
    expect(out).toBeDefined();
    expect(out).toContain('QmExampleCid');
  });

  it('trims provider strings and is idempotent', () => {
    const provider: any = { getUrl: (_: string) => '  https://trim.example.com/ipfs/QmTrim  ' };
    const svc = new IpfsService(provider);
    const first = svc.getGatewayUrl('QmTrim');
    const second = svc.getGatewayUrl('QmTrim');
    expect(first).toBe('https://trim.example.com/ipfs/QmTrim');
    expect(second).toBe(first);
  });
});
