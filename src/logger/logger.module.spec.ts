import { ConfigService } from '@nestjs/config';
import { makePinoOptions } from './logger.module';

describe('pino redaction configuration', () => {
  const config = {
    get: jest.fn((key: string) =>
      key === 'LOG_LEVEL' ? 'debug' : key === 'npm_package_version' ? '1.0.0' : undefined,
    ),
  } as unknown as ConfigService;

  it('redacts webhook secrets from structured logs at any nesting depth', () => {
    const options = makePinoOptions(config);
    const paths = options.pinoHttp.redact.paths as string[];

    expect(paths).toContain('req.body.webhookConfig.secret');
    expect(paths).toContain('req.body.secret');
    expect(paths).toContain('beforeState.webhookConfig.secret');
    expect(paths).toContain('afterState.webhookConfig.secret');
    expect(paths).toContain('**.secret');
    expect(options.pinoHttp.redact.censor).toBe('[REDACTED]');
  });
});
