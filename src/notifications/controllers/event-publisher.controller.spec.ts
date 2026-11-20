import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { EventPublisherController } from './event-publisher.controller';
import {
  ServiceOrAdminGuard,
  ServiceOrJwtAuthGuard,
  EventPublisherRequest,
} from '../guards/event-publisher-auth.guard';
import { ServiceAuthGuard } from '../../auth/guards/service-auth.guard';
import { AdminGuard, ADMIN_ONLY_KEY } from '../../auth/guards/admin.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { NotificationEventPublisher } from '../services/notification-event-publisher.service';
import { EventType } from '../enums/event-type.enum';
import {
  PublishEventDto,
  MAX_RECIPIENTS_PER_EVENT,
  MAX_BATCH_EVENTS,
  MAX_BATCH_TOTAL_RECIPIENTS,
} from '../dto/publish-event.dto';

function createExecutionContext(
  request: EventPublisherRequest,
  handler: Function = () => {},
  controllerClass: Function = EventPublisherController,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controllerClass,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function makeValidEvent(overrides: Partial<PublishEventDto> = {}): PublishEventDto {
  return {
    eventType: EventType.CLAIM_CREATED,
    aggregateId: 'claim-123',
    recipientIds: ['user-1'],
    metadata: { claimId: 'claim-123' },
    sourceUserId: 'user-owner',
    ...overrides,
  };
}

describe('EventPublisherController Authorization & Boundary Validation', () => {
  const VALID_SERVICE_KEY = 'test-internal-service-key-secret';

  let reflector: Reflector;
  let serviceAuthGuard: ServiceAuthGuard;
  let jwtAuthGuard: JwtAuthGuard;
  let adminGuard: AdminGuard;
  let serviceOrAdminGuard: ServiceOrAdminGuard;
  let serviceOrJwtAuthGuard: ServiceOrJwtAuthGuard;

  beforeEach(() => {
    reflector = new Reflector();
    process.env.ADMIN_WALLETS = '0xadminwallet';

    const configService = {
      get: jest.fn((key: string, defaultValue = '') =>
        key === 'SERVICE_API_KEY' ? VALID_SERVICE_KEY : defaultValue,
      ),
    } as unknown as ConfigService;

    serviceAuthGuard = new ServiceAuthGuard(configService);
    adminGuard = new AdminGuard(reflector);
    jwtAuthGuard = {
      canActivate: jest.fn((ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest<EventPublisherRequest>();
        if (!req.user) {
          throw new UnauthorizedException('Authentication required');
        }
        return true;
      }),
    } as unknown as JwtAuthGuard;

    serviceOrAdminGuard = new ServiceOrAdminGuard(
      serviceAuthGuard,
      jwtAuthGuard,
      adminGuard,
      reflector,
    );
    serviceOrJwtAuthGuard = new ServiceOrJwtAuthGuard(
      serviceAuthGuard,
      jwtAuthGuard,
    );
  });

  afterEach(() => {
    delete process.env.ADMIN_WALLETS;
  });

  describe('Route metadata contract', () => {
    it('applies @AdminOnly() to publishEvent, publishBatch, and getMetrics', () => {
      const proto = EventPublisherController.prototype;
      expect(Reflect.getMetadata(ADMIN_ONLY_KEY, proto.publishEvent)).toBe(true);
      expect(Reflect.getMetadata(ADMIN_ONLY_KEY, proto.publishBatch)).toBe(true);
      expect(Reflect.getMetadata(ADMIN_ONLY_KEY, proto.getMetrics)).toBe(true);
    });
  });

  describe('ServiceOrAdminGuard (publish, batch, metrics)', () => {
    const publishHandler = EventPublisherController.prototype.publishEvent;
    const batchHandler = EventPublisherController.prototype.publishBatch;

    it('allows authorized service identity via x-service-api-key', async () => {
      const req: EventPublisherRequest = {
        headers: { 'x-service-api-key': VALID_SERVICE_KEY },
      };
      const ctx = createExecutionContext(req, publishHandler);

      await expect(serviceOrAdminGuard.canActivate(ctx)).resolves.toBe(true);
      expect(req.isServiceAuth).toBe(true);
    });

    it('allows explicitly authorized admin user (role=admin)', async () => {
      const req: EventPublisherRequest = {
        headers: {},
        user: {
          address: '0xadmin',
          userId: 'admin-1',
          user: { role: 'admin' },
        },
      };
      const ctx = createExecutionContext(req, publishHandler);

      await expect(serviceOrAdminGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('allows explicitly authorized admin wallet in ADMIN_WALLETS', async () => {
      const req: EventPublisherRequest = {
        headers: {},
        user: {
          address: '0xAdminWallet',
          userId: 'admin-wallet-1',
          user: { role: 'contributor' },
        },
      };
      const ctx = createExecutionContext(req, batchHandler);

      await expect(serviceOrAdminGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('denies ordinary authenticated contributor on publish and batch', async () => {
      const req: EventPublisherRequest = {
        headers: {},
        user: {
          address: '0xcontributor',
          userId: 'contrib-1',
          user: { role: 'contributor' },
        },
      };

      await expect(
        serviceOrAdminGuard.canActivate(createExecutionContext(req, publishHandler)),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        serviceOrAdminGuard.canActivate(createExecutionContext(req, batchHandler)),
      ).rejects.toThrow(ForbiddenException);
    });

    it('denies authenticated moderator without admin capability', async () => {
      const req: EventPublisherRequest = {
        headers: {},
        user: {
          address: '0xmoderator',
          userId: 'mod-1',
          user: { role: 'moderator' },
        },
      };
      const ctx = createExecutionContext(req, publishHandler);

      await expect(serviceOrAdminGuard.canActivate(ctx)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('denies anonymous caller (no service key and no JWT)', async () => {
      const req: EventPublisherRequest = { headers: {} };
      const ctx = createExecutionContext(req, publishHandler);

      await expect(serviceOrAdminGuard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('fails closed on invalid service API key even if admin JWT is present', async () => {
      const req: EventPublisherRequest = {
        headers: { 'x-service-api-key': 'wrong-key' },
        user: {
          address: '0xadmin',
          userId: 'admin-1',
          user: { role: 'admin' },
        },
      };
      const ctx = createExecutionContext(req, publishHandler);

      await expect(serviceOrAdminGuard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('fails closed when @AdminOnly() metadata is missing on route', async () => {
      const unannotatedHandler = () => {};
      const req: EventPublisherRequest = {
        headers: {},
        user: {
          address: '0xadmin',
          userId: 'admin-1',
          user: { role: 'admin' },
        },
      };
      const ctx = createExecutionContext(req, unannotatedHandler, class Dummy {});

      await expect(serviceOrAdminGuard.canActivate(ctx)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('ServiceOrJwtAuthGuard (event status)', () => {
    it('allows valid service API key', async () => {
      const req: EventPublisherRequest = {
        headers: { 'x-service-api-key': VALID_SERVICE_KEY },
      };
      const ctx = createExecutionContext(req);

      await expect(serviceOrJwtAuthGuard.canActivate(ctx)).resolves.toBe(true);
      expect(req.isServiceAuth).toBe(true);
    });

    it('fails closed on invalid service API key', async () => {
      const req: EventPublisherRequest = {
        headers: { 'x-service-api-key': 'invalid-key' },
      };
      const ctx = createExecutionContext(req);

      await expect(serviceOrJwtAuthGuard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('allows authenticated JWT caller', async () => {
      const req: EventPublisherRequest = {
        headers: {},
        user: { address: '0xuser', userId: 'user-1', user: { role: 'contributor' } },
      };
      const ctx = createExecutionContext(req);

      await expect(serviceOrJwtAuthGuard.canActivate(ctx)).resolves.toBe(true);
    });

    it('denies anonymous caller', async () => {
      const req: EventPublisherRequest = { headers: {} };
      const ctx = createExecutionContext(req);

      await expect(serviceOrJwtAuthGuard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Event status ownership & capability enforcement', () => {
    let outboxRepo: { findOne: jest.Mock; save: jest.Mock };
    let publisherService: NotificationEventPublisher;
    let controller: EventPublisherController;

    const storedEvent = {
      id: 'evt-1',
      status: 'DISPATCHED',
      retryCount: 0,
      processedAt: new Date('2026-01-01T00:00:00Z'),
      lastError: undefined,
      payload: {
        eventType: EventType.CLAIM_CREATED,
        aggregateId: 'claim-1',
        sourceUserId: 'user-owner',
        recipientIds: ['user-recipient-1', 'user-recipient-2'],
      },
    };

    beforeEach(() => {
      outboxRepo = {
        findOne: jest.fn().mockResolvedValue(storedEvent),
        save: jest.fn().mockImplementation(async (e) => ({ id: 'saved-1', ...e })),
      };
      publisherService = new NotificationEventPublisher(outboxRepo as any);
      const transactionRunner = {
        run: jest.fn((cb: any) => cb({ getRepository: () => outboxRepo })),
      };
      controller = new EventPublisherController(
        publisherService,
        transactionRunner as any,
      );
    });

    it('allows event source owner to inspect event status', async () => {
      const req: EventPublisherRequest = {
        user: { address: '0xowner', userId: 'user-owner', user: { role: 'contributor' } },
      };
      const status = await controller.getEventStatus('evt-1', req, req.user);
      expect(status?.id).toBe('evt-1');
    });

    it('allows event recipient to inspect event status', async () => {
      const req: EventPublisherRequest = {
        user: {
          address: '0xrecip',
          userId: 'user-recipient-1',
          user: { role: 'contributor' },
        },
      };
      const status = await controller.getEventStatus('evt-1', req, req.user);
      expect(status?.id).toBe('evt-1');
    });

    it('denies cross-user event status lookup for unrelated contributor', async () => {
      const req: EventPublisherRequest = {
        user: {
          address: '0xother',
          userId: 'user-attacker',
          user: { role: 'contributor' },
        },
      };
      await expect(
        controller.getEventStatus('evt-1', req, req.user),
      ).rejects.toThrow(ForbiddenException);
    });

    it('denies cross-user event status lookup for unrelated moderator', async () => {
      const req: EventPublisherRequest = {
        user: {
          address: '0xmod',
          userId: 'mod-other',
          user: { role: 'moderator' },
        },
      };
      await expect(
        controller.getEventStatus('evt-1', req, req.user),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows admin to inspect any event status', async () => {
      const req: EventPublisherRequest = {
        user: { address: '0xadmin', userId: 'admin-1', user: { role: 'admin' } },
      };
      const status = await controller.getEventStatus('evt-1', req, req.user);
      expect(status?.id).toBe('evt-1');
    });

    it('allows service identity to inspect any event status', async () => {
      const req: EventPublisherRequest = { isServiceAuth: true };
      const status = await controller.getEventStatus('evt-1', req, undefined);
      expect(status?.id).toBe('evt-1');
    });

    it('fails closed when caller context is missing in service', async () => {
      await expect(publisherService.getEventStatus('evt-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('Boundary validation (event types, recipients, batch bounds)', () => {
    let outboxRepo: { save: jest.Mock };
    let publisherService: NotificationEventPublisher;

    beforeEach(() => {
      outboxRepo = {
        save: jest.fn().mockImplementation(async (e) => ({ id: 'saved-1', ...e })),
      };
      publisherService = new NotificationEventPublisher(outboxRepo as any);
    });

    it('rejects invalid event type', async () => {
      const badEvent = makeValidEvent({ eventType: 'INVALID_EVENT' as EventType });
      await expect(publisherService.publishEvent(badEvent)).rejects.toThrow(
        BadRequestException,
      );
      expect(outboxRepo.save).not.toHaveBeenCalled();
    });

    it('rejects empty recipient list and blank recipient IDs', async () => {
      await expect(
        publisherService.publishEvent(makeValidEvent({ recipientIds: [] })),
      ).rejects.toThrow(BadRequestException);

      await expect(
        publisherService.publishEvent(makeValidEvent({ recipientIds: ['  '] })),
      ).rejects.toThrow(BadRequestException);
    });

    it('enforces maximum recipients per event', async () => {
      const tooMany = Array.from(
        { length: MAX_RECIPIENTS_PER_EVENT + 1 },
        (_, i) => `user-${i}`,
      );
      await expect(
        publisherService.publishEvent(makeValidEvent({ recipientIds: tooMany })),
      ).rejects.toThrow(BadRequestException);
    });

    it('enforces batch size bounds', async () => {
      await expect(publisherService.publishEvents([])).rejects.toThrow(
        BadRequestException,
      );

      const tooManyEvents = Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, i) =>
        makeValidEvent({ aggregateId: `agg-${i}` }),
      );
      await expect(publisherService.publishEvents(tooManyEvents)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('enforces total batch recipient count bound', async () => {
      const perEvent = MAX_RECIPIENTS_PER_EVENT;
      const eventCount = Math.floor(MAX_BATCH_TOTAL_RECIPIENTS / perEvent) + 1;
      const events = Array.from({ length: eventCount }, (_, i) =>
        makeValidEvent({
          aggregateId: `agg-${i}`,
          recipientIds: Array.from({ length: perEvent }, (_, j) => `u-${i}-${j}`),
        }),
      );

      await expect(publisherService.publishEvents(events)).rejects.toThrow(
        BadRequestException,
      );
      expect(outboxRepo.save).not.toHaveBeenCalled();
    });

    it('rejects entire batch if any event has an invalid event type', async () => {
      const events = [
        makeValidEvent({ aggregateId: 'agg-1' }),
        makeValidEvent({
          aggregateId: 'agg-2',
          eventType: 'UNKNOWN_TYPE' as EventType,
        }),
      ];

      await expect(publisherService.publishEvents(events)).rejects.toThrow(
        BadRequestException,
      );
      expect(outboxRepo.save).not.toHaveBeenCalled();
    });
  });
});
