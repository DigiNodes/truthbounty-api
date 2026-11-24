import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { configureApp } from './bootstrap';

jest.mock('@nestjs/swagger', () => ({
  SwaggerModule: {
    createDocument: jest.fn().mockReturnValue({}),
    setup: jest.fn(),
  },
  DocumentBuilder: jest.fn().mockImplementation(() => ({
    setTitle: jest.fn().mockReturnThis(),
    setDescription: jest.fn().mockReturnThis(),
    setVersion: jest.fn().mockReturnThis(),
    addBearerAuth: jest.fn().mockReturnThis(),
    addTag: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
}));

describe('configureApp', () => {
  it('registers strict global validation and bounded body parsers', () => {
    const httpAdapter = {
      set: jest.fn(),
      use: jest.fn(),
    };

    const app = {
      useLogger: jest.fn(),
      get: jest.fn(),
      getHttpAdapter: jest.fn().mockReturnValue({
        getInstance: () => httpAdapter,
      }),
      useGlobalPipes: jest.fn(),
    } as any;

    configureApp(app);

    expect(httpAdapter.use).toHaveBeenCalledTimes(2);

    const [jsonParser] = httpAdapter.use.mock.calls[0];
    const [urlencodedParser] = httpAdapter.use.mock.calls[1];

    expect(jsonParser).toHaveProperty('name', 'jsonParser');
    expect(urlencodedParser).toHaveProperty('name', 'urlencodedParser');

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
