import { ConfigService } from '@nestjs/config';
import { makePinoOptions } from './logger.module';

describe('LoggerModule Pino options', () => {
  it('includes IPFS and API-key redaction paths', () => {
    const mockConfig: Partial<ConfigService> = {
      get: jest.fn().mockImplementation((key: string, def?: any) => {
        if (key === 'NODE_ENV') return 'development';
        return def;
      }),
    } as unknown as ConfigService;

    const opts = makePinoOptions(mockConfig as ConfigService);
    expect(opts).toBeDefined();
    const paths = opts.pinoHttp.redact.paths;
    expect(Array.isArray(paths)).toBe(true);

    // Ensure common API key locations are redacted
    expect(paths).toContain('req.headers.x-api-key');
    expect(paths).toContain('req.headers.api-key');
    expect(paths).toContain('req.body.apiKey');
    expect(paths).toContain('req.body.ipfsApiKey');
    expect(paths).toContain('req.body.pinataApiKey');
    expect(paths).toContain('config.ipfs.apiKey');
  });
});
