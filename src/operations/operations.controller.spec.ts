import { Test } from '@nestjs/testing';
import { PublicErrorCode } from '../common/constants/error-codes';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RolesGuard } from '../admin/guards/roles.guard';
import { OperationsController } from './operations.controller';
import { OperationsError, OperationsService } from './operations.service';
import { OperationalCapability, RetryDenialReason } from './operations.types';

describe('OperationsController (UX-BE-004)', () => {
  let controller: OperationsController;
  let service: jest.Mocked<OperationsService>;

  beforeEach(async () => {
    service = {
      listQueue: jest.fn(),
      getItem: jest.fn(),
      getRetryEligibility: jest.fn(),
      submitRetry: jest.fn(),
      getAuditRecord: jest.fn(),
    } as unknown as jest.Mocked<OperationsService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [OperationsController],
      providers: [{ provide: OperationsService, useValue: service }],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(OperationsController);
  });

  it('delegates reads to the service', async () => {
    service.listQueue.mockResolvedValue({
      releaseId: 'v2.0.0-sepolia',
      generatedAt: new Date(0).toISOString(),
      total: 0,
      countsByStatus: {} as never,
      items: [],
    });

    await expect(controller.listQueue()).resolves.toMatchObject({
      releaseId: 'v2.0.0-sepolia',
    });
    expect(service.listQueue).toHaveBeenCalledTimes(1);
  });

  it('forwards the retry headers and body into the service input', async () => {
    service.submitRetry.mockResolvedValue({
      id: 'queue-001',
      accepted: true,
      auditId: 'audit-1',
      replayed: 1,
      skipped: 0,
      failed: 0,
      detail: null,
    });

    await controller.submitRetry(
      'queue-001',
      { preconditionToken: 'token-1' },
      'idem-1',
      'token-1',
      OperationalCapability.RETRY_SUBMIT,
      new Date(Date.now() + 1000).toISOString(),
      { admin: { id: 'admin-1' } },
    );

    expect(service.submitRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'queue-001',
        preconditionToken: 'token-1',
        idempotencyKey: 'idem-1',
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
        actorId: 'admin-1',
      }),
    );
  });

  it('maps an operations rejection to a canonical error body with the audit id', async () => {
    service.submitRetry.mockRejectedValue(
      new OperationsError(
        409,
        PublicErrorCode.STALE_PRECONDITION,
        RetryDenialReason.CONFLICT,
        'audit-rejected',
        'stale',
      ),
    );

    await expect(
      controller.submitRetry(
        'queue-001',
        { preconditionToken: 'stale' },
        'idem-1',
        'stale',
        OperationalCapability.RETRY_SUBMIT,
        new Date(Date.now() + 1000).toISOString(),
        {},
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        statusCode: 409,
        errorCode: PublicErrorCode.STALE_PRECONDITION,
        auditId: 'audit-rejected',
      }),
    });
  });

  it('exposes no handler that edits protocol state', () => {
    const handlers = Object.getOwnPropertyNames(
      OperationsController.prototype,
    ).filter((name) => name !== 'constructor' && !name.startsWith('run'));

    expect(handlers.sort()).toEqual(
      [
        'getAuditRecord',
        'getItem',
        'getRetryEligibility',
        'listQueue',
        'submitRetry',
      ].sort(),
    );

    for (const handler of handlers) {
      expect(handler).not.toMatch(
        /delete|update|edit|settle|resolve|mint|pause|treasury|governance|dispute|reward/i,
      );
    }
  });
});
