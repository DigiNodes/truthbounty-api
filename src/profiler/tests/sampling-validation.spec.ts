import { Test, TestingModule } from '@nestjs/testing';
import { ProfilerService } from '../profiler.service';

describe('Sampling Validation Tests', () => {
  let service: ProfilerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProfilerService],
    }).compile();

    service = module.get<ProfilerService>(ProfilerService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should obey fixed-rate sampling configuration', () => {
    service.updateSamplingConfig({
      strategy: 'fixed-rate',
      defaultSampleRate: 1.0,
    });
    expect(service.shouldSample()).toBe(true);

    service.updateSamplingConfig({
      defaultSampleRate: 0.0,
    });
    expect(service.shouldSample()).toBe(false);
  });

  it('should override sampling when header is supplied', () => {
    service.updateSamplingConfig({
      strategy: 'fixed-rate',
      defaultSampleRate: 0.0,
      headerOverrideKey: 'x-profile-request',
    });

    const mockReqWithHeader = {
      headers: {
        'x-profile-request': 'true',
      },
    };
    expect(service.shouldSample(mockReqWithHeader)).toBe(true);

    const mockReqWithBypassHeader = {
      headers: {
        'x-profile-request': 'false',
      },
    };
    service.updateSamplingConfig({ defaultSampleRate: 1.0 });
    expect(service.shouldSample(mockReqWithBypassHeader)).toBe(false);
  });

  it('should enforce route-based sampling rates', () => {
    service.updateSamplingConfig({
      strategy: 'route-based',
      defaultSampleRate: 0.0,
      routeSampleRates: {
        '/api/v1/heavy-endpoint': 1.0,
        '/api/v1/light-endpoint': 0.0,
      },
    });

    const heavyReq = { url: '/api/v1/heavy-endpoint', route: { path: '/api/v1/heavy-endpoint' } };
    const lightReq = { url: '/api/v1/light-endpoint', route: { path: '/api/v1/light-endpoint' } };

    expect(service.shouldSample(heavyReq)).toBe(true);
    expect(service.shouldSample(lightReq)).toBe(false);
  });

  it('should dynamically adapt sampling rate during adaptive strategy', () => {
    service.updateSamplingConfig({
      strategy: 'adaptive',
      defaultSampleRate: 1.0,
      targetCpuThresholdPercent: 80,
    });

    const result = service.shouldSample();
    expect(typeof result).toBe('boolean');
  });
});
