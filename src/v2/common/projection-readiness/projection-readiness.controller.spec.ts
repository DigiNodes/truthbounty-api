import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ProjectionReadinessController } from './projection-readiness.controller';
import { ProjectionReadinessService } from './projection-readiness.service';

describe('ProjectionReadinessController', () => {
  let controller: ProjectionReadinessController;
  let readiness: jest.Mocked<ProjectionReadinessService>;

  const readyReport = {
    ready: true,
    status: 'ready' as const,
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    projectors: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectionReadinessController],
      providers: [
        {
          provide: ProjectionReadinessService,
          useValue: { evaluate: jest.fn(), evaluateAll: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(ProjectionReadinessController);
    readiness = module.get<ProjectionReadinessService>(
      ProjectionReadinessService,
    ) as jest.Mocked<ProjectionReadinessService>;
  });

  it('exposes no write handlers: readiness cannot be set through the API', () => {
    const prototype = Object.getPrototypeOf(
      controller,
    ) as ProjectionReadinessController;
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methodNames.sort()).toEqual([
      'getProjectorReadiness',
      'getReadiness',
    ]);
  });

  it('returns the aggregate report when every projector is ready', async () => {
    readiness.evaluateAll.mockResolvedValue(readyReport);

    await expect(controller.getReadiness()).resolves.toEqual(readyReport);
  });

  it('reports 503 with the aggregate report when a projector is not ready', async () => {
    const notReady = {
      ...readyReport,
      ready: false,
      status: 'not_ready' as const,
    };
    readiness.evaluateAll.mockResolvedValue(notReady);

    const error = await controller
      .getReadiness()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual(
      notReady,
    );
  });

  it('rejects an unknown projector name as bad input rather than evaluating it', async () => {
    await expect(
      controller.getProjectorReadiness('v2-unknown'),
    ).rejects.toBeInstanceOf(BadRequestException);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock assertion, not a real unbound call
    expect(readiness.evaluate).not.toHaveBeenCalled();
  });

  it('returns the per-projector verdict when ready', async () => {
    const verdict = {
      projector: 'v2-evidence',
      ready: true,
      status: 'ready' as const,
      evaluatedAt: '2026-01-01T00:00:00.000Z',
      cursor: { blockNumber: '10', logIndex: 0 },
      canonicalHead: { blockNumber: '10', logIndex: 0 },
      pendingEvents: 0,
      quarantinedProtocolLogs: 0,
      quarantineThreshold: 0,
      reasons: [],
      checks: [],
    };
    readiness.evaluate.mockResolvedValue(verdict);

    await expect(
      controller.getProjectorReadiness('v2-evidence'),
    ).resolves.toEqual(verdict);
  });

  it('reports 503 for a not-ready projector', async () => {
    readiness.evaluate.mockResolvedValue({
      projector: 'v2-disputes',
      ready: false,
      status: 'not_ready',
      evaluatedAt: '2026-01-01T00:00:00.000Z',
      cursor: null,
      canonicalHead: { blockNumber: '10', logIndex: 0 },
      pendingEvents: 3,
      quarantinedProtocolLogs: 0,
      quarantineThreshold: 0,
      reasons: ['cursor_missing'] as never[],
      checks: [],
    });

    await expect(
      controller.getProjectorReadiness('v2-disputes'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
