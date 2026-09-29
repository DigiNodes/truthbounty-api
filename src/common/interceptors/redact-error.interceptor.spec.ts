import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { RedactErrorInterceptor } from './redact-error.interceptor';

describe('RedactErrorInterceptor', () => {
  let interceptor: RedactErrorInterceptor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RedactErrorInterceptor],
    }).compile();

    interceptor = module.get<RedactErrorInterceptor>(RedactErrorInterceptor);
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  describe('intercept', () => {
    it('should pass through successful responses', (done) => {
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({}),
          getResponse: () => ({}),
        }),
      } as unknown as ExecutionContext;

      const callHandler = {
        handle: () => of({ data: 'success' }),
      } as unknown as CallHandler;

      interceptor.intercept(context, callHandler).subscribe({
        next: (value) => {
          expect(value).toEqual({ data: 'success' });
          done();
        },
        error: (err) => {
          done.fail('Should not error');
        },
      });
    });

    it('should redact sensitive data in error responses', (done) => {
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({}),
          getResponse: () => ({}),
        }),
      } as unknown as ExecutionContext;

      const error = {
        message: 'Database error',
        password: 'secret123',
        token: 'abc123',
      };

      const callHandler = {
        handle: () => throwError(() => error),
      } as unknown as CallHandler;

      interceptor.intercept(context, callHandler).subscribe({
        next: () => {
          done.fail('Should not succeed');
        },
        error: (err) => {
          expect(err.message).toBe('Database error');
          expect(err.password).toBe('[REDACTED]');
          expect(err.token).toBe('[REDACTED]');
          done();
        },
      });
    });
  });
});