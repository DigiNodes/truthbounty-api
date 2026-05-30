import { Module, Global } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => makePinoOptions(configService),
    }),
  ],
})
export class LoggerModule {}

export function makePinoOptions(configService: ConfigService) {
  const isProduction = configService.get('NODE_ENV') === 'production';

  return {
    pinoHttp: {
      level: configService.get('LOG_LEVEL', isProduction ? 'info' : 'debug'),
      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
      formatters: {
        level: (label: string) => ({ level: label }),
        bindings: () => ({}),
      },
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          query: req.query,
          params: req.params,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
        err: (err) => ({
          type: err.constructor?.name,
          message: err.message,
          stack: isProduction ? undefined : err.stack,
        }),
      },
      customProps: () => ({
        service: 'truthbounty-api',
        version: configService.get('npm_package_version', '1.0.0'),
      }),
      redact: {
        paths: [
          // common request secrets
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-api-key',
          'req.headers.api-key',
          // body fields that commonly hold secrets
          'req.body.password',
          'req.body.token',
          'req.body.privateKey',
          // IPFS provider / pinning service secrets
          'req.body.apiKey',
          'req.body.api_key',
          'req.body.ipfsApiKey',
          'req.body.pinataApiKey',
          // generic config locations (when configs are logged)
          'config.ipfs.apiKey',
          'config.ipfs.api_key',
        ],
        censor: '[REDACTED]',
      },
    },
  };
}
