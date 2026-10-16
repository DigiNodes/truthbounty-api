import { ValidationPipe } from '@nestjs/common';
import { configureApp } from './bootstrap';
import { TracingService } from './tracing/tracing.service';

jest.mock('@nestjs/swagger', () => {
  const actual = jest.requireActual('@nestjs/swagger');
  return {
    ...actual,
    SwaggerModule: {
      createDocument: jest.fn().mockReturnValue({}),
      setup: jest.fn(),
    },
  };
});

describe('configureApp', () => {
  it('registers a single strict global validation pipe', () => {
    const httpAdapter = { set: jest.fn() };
    const app = {
      useLogger: jest.fn(),
      use: jest.fn(),
      get: jest.fn(),
      getHttpAdapter: jest.fn().mockReturnValue({ getInstance: () => httpAdapter }),
      useGlobalPipes: jest.fn(),
    } as any;
    app.get.mockImplementation((token: unknown) =>
      token === TracingService
        ? { createHttpMiddleware: jest.fn().mockReturnValue(jest.fn()) }
        : { log: jest.fn() },
    );

    configureApp(app);

    expect(app.useGlobalPipes).toHaveBeenCalledTimes(1);

    const [pipe] = app.useGlobalPipes.mock.calls[0];
    const validationPipe = pipe as ValidationPipe & {
      validatorOptions?: Record<string, unknown>;
      transformOptions?: Record<string, unknown>;
      isTransformEnabled?: boolean;
    };

    expect(validationPipe).toBeInstanceOf(ValidationPipe);
    expect(validationPipe.validatorOptions).toMatchObject({
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(validationPipe.isTransformEnabled).toBe(true);
    expect(validationPipe.transformOptions).toMatchObject({
      enableImplicitConversion: true,
    });
  });
});