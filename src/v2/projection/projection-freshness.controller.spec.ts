import { Test, TestingModule } from '@nestjs/testing';
import { IS_PUBLIC_KEY } from '../../decorators/public.decorator';
import { ProjectionFreshnessController } from './projection-freshness.controller';
import { ProjectionFreshnessService } from './projection-freshness.service';

describe('ProjectionFreshnessController', () => {
  let controller: ProjectionFreshnessController;
  let service: jest.Mocked<ProjectionFreshnessService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectionFreshnessController],
      providers: [
        {
          provide: ProjectionFreshnessService,
          useValue: { listFreshness: jest.fn(), getFreshness: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(ProjectionFreshnessController);
    service = module.get(ProjectionFreshnessService);
  });

  it('exposes no write handlers: only GET routes exist on this controller', () => {
    const prototype = Object.getPrototypeOf(controller) as object;
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methodNames.sort()).toEqual(['getFreshness', 'listFreshness']);
  });

  it('is public: GET freshness endpoints require no authentication', () => {
    const isPublic = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      ProjectionFreshnessController,
    );
    expect(isPublic).toBe(true);
  });

  it('listFreshness delegates to the service', async () => {
    const payload = { timestamp: '2026-01-01T00:00:00.000Z', items: [] };
    service.listFreshness.mockResolvedValue(payload);

    await expect(controller.listFreshness()).resolves.toEqual(payload);

    expect(service.listFreshness).toHaveBeenCalledWith();
  });

  it('getFreshness delegates by projector name', async () => {
    service.getFreshness.mockResolvedValue({
      projectorName: 'v2-evidence',
    });

    await expect(controller.getFreshness('v2-evidence')).resolves.toEqual({
      projectorName: 'v2-evidence',
    });

    expect(service.getFreshness).toHaveBeenCalledWith('v2-evidence');
  });

  it('propagates service validation failures without masking them', async () => {
    const err = new Error('bad name');
    service.getFreshness.mockRejectedValue(err);

    await expect(controller.getFreshness('bad name')).rejects.toBe(err);
  });
});
