import { redactProviderUrl } from '../provider-redactor.util';

describe('redactProviderUrl', () => {
  it('redacts credentials in the URL userinfo', () => {
    const redacted = redactProviderUrl(
      'https://user:supersecret@rpc.example.com',
    );
    expect(redacted).not.toContain('supersecret');
  });

  it('redacts Infura-style API keys embedded in the path', () => {
    const redacted = redactProviderUrl(
      'https://mainnet.infura.io/v3/abcdef0123456789abcdef0123456789',
    );
    expect(redacted).not.toContain('abcdef0123456789abcdef0123456789');
    expect(redacted).toMatch(/\.\.\./);
  });

  it('redacts query-string secrets by name', () => {
    const redacted = redactProviderUrl(
      'https://rpc.example.com/?apikey=deadbeef&other=ok',
    );
    expect(redacted).not.toContain('deadbeef');
  });

  it('returns a fixed placeholder for unparseable URLs', () => {
    expect(redactProviderUrl('not a url')).toBe('<unparseable-url>');
  });

  it('returns a fixed placeholder for empty input', () => {
    expect(redactProviderUrl('')).toBe('<empty-url>');
  });
});
