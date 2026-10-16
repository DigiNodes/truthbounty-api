import { Module, Global } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';

export function serializeSafeRequest(request: { method?: string }) {
  return {
    method:
      request.method && /^[A-Z]{1,16}$/.test(request.method)
        ? request.method
        : 'UNKNOWN',
  };
}

export function serializeSafeResponse(response: {
  statusCode?: number;
  getHeader?: (name: string) => string | number | string[] | undefined;
}) {
  const traceId = response.getHeader?.('x-trace-id');
  return {
    statusCode: response.statusCode,
    traceId:
      typeof traceId === 'string' && /^[a-f0-9]{32}$/i.test(traceId)
        ? traceId
        : undefined,
  };
}

export function serializeSafeError(error: { type?: string; name?: string }) {
  const candidate = error.type ?? error.name;
  const allowedTypes = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'TimeoutError',
    'AbortError',
    'HttpException',
    'BadRequestException',
    'UnauthorizedException',
    'ForbiddenException',
    'NotFoundException',
    'ConflictException',
    'InternalServerErrorException',
  ]);
  return {
    type: candidate && allowedTypes.has(candidate) ? candidate : 'Error',
  };
}

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isProduction =
          configService.get<string>('NODE_ENV') === 'production';

        return {
          pinoHttp: {
            level: configService.get<string>(
              'LOG_LEVEL',
              isProduction ? 'info' : 'debug',
            ),
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
              req: serializeSafeRequest,
              res: serializeSafeResponse,
              err: serializeSafeError,
            },
            customProps: () => ({
              service: 'truthbounty-api',
              version: configService.get<string>(
                'npm_package_version',
                '1.0.0',
              ),
            }),
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.token',
                'req.body.privateKey',
              ],
              censor: '[REDACTED]',
            },
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
