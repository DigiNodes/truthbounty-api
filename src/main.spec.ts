import { bootstrap } from './main';

jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));

jest.mock('./bootstrap', () => ({
  configureApp: jest.fn(),
}));

jest.mock('./app.module', () => ({
  AppModule: Symbol('AppModule'),
}));

const mockApp = {
  enableShutdownHooks: jest.fn(),
  listen: jest.fn().mockResolvedValue(undefined),
};

describe('bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enables shutdown hooks and starts the application', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('./app.module');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const createMock = NestFactory.create as jest.Mock;
    createMock.mockResolvedValue(mockApp);

    await bootstrap();

    expect(createMock).toHaveBeenCalledWith(AppModule, {
      bufferLogs: true,
    });
    expect(mockApp.enableShutdownHooks).toHaveBeenCalled();
    expect(mockApp.listen).toHaveBeenCalledWith(process.env.PORT ?? 3000);
  });
});
