import { bootstrap, ShutdownSignalSource } from './main';

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

const mockShutdown = {
  validateAll: jest.fn().mockResolvedValue(undefined),
  setSchedulerRegistry: jest.fn(),
  registerStopHook: jest.fn(),
  middleware: jest.fn(),
  getProviders: jest.fn().mockReturnValue([]),
  shutdown: jest.fn().mockImplementation(() => {
    mockShutdown.isDraining = true;
    return Promise.resolve({ failed: false, timedOut: false });
  }),
  isDraining: false,
};

const mockApp = {
  get: jest.fn().mockReturnValue(mockShutdown),
  use: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  listen: jest.fn().mockResolvedValue(undefined),
};

describe('bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShutdown.isDraining = false;
  });

  it('installs signal handlers and starts the application', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('./app.module');
    const signalSource: ShutdownSignalSource = { on: jest.fn() };

    const createMock = NestFactory.create as jest.Mock;
    createMock.mockResolvedValue(mockApp);

    await bootstrap(signalSource);

    expect(createMock).toHaveBeenCalledWith(AppModule, {
      bufferLogs: true,
    });
    expect(signalSource.on).toHaveBeenCalledWith(
      'SIGTERM',
      expect.any(Function),
    );
    expect(signalSource.on).toHaveBeenCalledWith(
      'SIGINT',
      expect.any(Function),
    );
    expect(mockApp.use).toHaveBeenCalledWith(expect.any(Function));
    expect(mockApp.listen).toHaveBeenCalledWith(process.env.PORT ?? 3000);

    const signalHandler = (signalSource.on as jest.Mock).mock.calls.find(
      ([signal]) => signal === 'SIGTERM',
    )?.[1] as (() => void) | undefined;
    expect(signalHandler).toBeDefined();
    signalHandler?.();
    await Promise.resolve();
    expect(mockShutdown.shutdown).toHaveBeenCalledWith(expect.any(Function));
  });

  it('does not start listening when SIGTERM arrives during startup validation', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const signalSource: ShutdownSignalSource = { on: jest.fn() };
    const createMock = NestFactory.create as jest.Mock;
    createMock.mockResolvedValue(mockApp);
    mockShutdown.validateAll.mockImplementationOnce(() => {
      const signalHandler = (signalSource.on as jest.Mock).mock.calls.find(
        ([signal]) => signal === 'SIGTERM',
      )?.[1] as (() => void) | undefined;
      signalHandler?.();
    });

    await bootstrap(signalSource);

    expect(mockShutdown.shutdown).toHaveBeenCalledTimes(1);
    expect(mockApp.listen).not.toHaveBeenCalled();
  });
});
