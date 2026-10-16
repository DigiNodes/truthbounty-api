import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, Observable, of } from 'rxjs';
import { PinoLogger } from 'nestjs-pino';
import { LoggingInterceptor } from './logging.interceptor';
import { TracingService } from '../tracing/tracing.service';

describe('LoggingInterceptor privacy', () => {
  it('logs a trace reference without request data or raw error messages', async () => {
    const logger = {
      setContext: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    };
    const tracing = { getSupportReference: () => 'a'.repeat(32) };
    const response = { statusCode: 200 };
    const request = {
      id: 'untrusted-request-id',
      method: 'GET',
      url: '/claims/secret-id?token=secret-token',
      body: { password: 'secret-password' },
      query: { token: 'secret-token' },
      params: { id: 'secret-id' },
      headers: { authorization: 'Bearer secret-token' },
      ip: '192.0.2.99',
    };
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ExecutionContext;
    const next = { handle: () => of('ok') } as CallHandler;
    const interceptor = new LoggingInterceptor(
      logger as unknown as PinoLogger,
      tracing as unknown as TracingService,
    );

    await firstValueFrom(interceptor.intercept(executionContext, next));

    const logArguments = JSON.stringify([
      logger.info.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logArguments).toContain('a'.repeat(32));
    expect(logArguments).not.toMatch(
      /secret-id|secret-token|secret-password|192\.0\.2\.99|untrusted-request-id|authorization/i,
    );
  });

  it('omits raw exception text from error logs', async () => {
    const logger = {
      setContext: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    };
    const tracing = { getSupportReference: () => 'b'.repeat(32) };
    const request = { method: 'POST', headers: {} };
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: 500 }),
      }),
    } as ExecutionContext;
    const next = {
      handle: () =>
        new Observable((subscriber) =>
          subscriber.error(new Error('credential=do-not-log')),
        ),
    } as CallHandler;
    const interceptor = new LoggingInterceptor(
      logger as unknown as PinoLogger,
      tracing as unknown as TracingService,
    );

    await expect(
      firstValueFrom(interceptor.intercept(executionContext, next)),
    ).rejects.toThrow('credential=do-not-log');

    const errorArguments = JSON.stringify(logger.error.mock.calls);
    expect(errorArguments).toContain('b'.repeat(32));
    expect(errorArguments).not.toContain('credential=do-not-log');
  });
});
