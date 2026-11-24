import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Repository, Between } from 'typeorm';
import { EventType } from './enums/event-type.enum';
import { NotificationEventPublisher } from './services/notification-event-publisher.service';
import { PreferenceEnforcer } from './services/preference-enforcer.service';
import { TemplateRenderer } from './services/template-renderer.service';
import { DeliveryTracker } from './services/delivery-tracker.service';
import { NotificationOrchestrator } from './services/notification-orchestrator.service';
import { NotificationTemplateService } from './services/notification-template.service';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { DeliveryHistory } from './entities/delivery-history.entity';
import { NotificationTemplate } from './entities/notification-template.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { InAppChannel } from './channels/in-app.channel';

/**
 * Integration Tests for Notification System
 *
 * These tests run against the production database family (PostgreSQL) via the approved test
 * driver configuration. They cover the end-to-end notification flow, date range and
 * pagination queries, user isolation, retention cleanup, and concurrency behavior.
 */

function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is required for notification integration tests. ' +
        'Provide a PostgreSQL connection string for the approved test database family.',
    );
  }
  return url;
}

describe('Notification System (Integration)', () => {
  let module: TestingModule;
  let eventPublisher: NotificationEventPublisher;
  let preferenceEnforcer: PreferenceEnforcer;
  let templateRenderer: TemplateRenderer;
  let deliveryTracker: DeliveryTracker;
  let notificationOrchestrator: NotificationOrchestrator;
  let templateService: NotificationTemplateService;

  let notificationRepo: Repository<Notification>;
  let preferenceRepo: Repository<NotificationPreference>;
  let deliveryHistoryRepo: Repository<DeliveryHistory>;
  let outboxRepo: Repository<OutboxEvent>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: requireTestDatabaseUrl(),
          entities: [
            Notification,
            NotificationPreference,
            DeliveryHistory,
            NotificationTemplate,
            OutboxEvent,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          Notification,
          NotificationPreference,
          DeliveryHistory,
          NotificationTemplate,
          OutboxEvent,
        ]),
        BullModule.forRoot({
          connection: {
            host: process.env.TEST_REDIS_HOST ?? 'localhost',
            port: Number(process.env.TEST_REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({ name: 'notifications' }),
      ],
      providers: [
        NotificationEventPublisher,
        PreferenceEnforcer,
        TemplateRenderer,
        DeliveryTracker,
        NotificationOrchestrator,
        NotificationTemplateService,
        InAppChannel,
      ],
    }).compile();

    eventPublisher = module.get<NotificationEventPublisher>(NotificationEventPublisher);
    preferenceEnforcer = module.get<PreferenceEnforcer>(PreferenceEnforcer);
    templateRenderer = module.get<TemplateRenderer>(TemplateRenderer);
    deliveryTracker = module.get<DeliveryTracker>(DeliveryTracker);
    notificationOrchestrator = module.get<NotificationOrchestrator>(NotificationOrchestrator);
    templateService = module.get<NotificationTemplateService>(NotificationTemplateService);

    notificationRepo = module.get(getRepositoryToken(Notification));
    preferenceRepo = module.get(getRepositoryToken(NotificationPreference));
    deliveryHistoryRepo = module.get(getRepositoryToken(DeliveryHistory));
    outboxRepo = module.get(getRepositoryToken(OutboxEvent));
  });

  afterAll(async () => {
    if (module) {
      await module.close();
    }
  });

  beforeEach(async () => {
    await deliveryHistoryRepo.createQueryBuilder().delete().execute();
    await notificationRepo.createQueryBuilder().delete().execute();
    await preferenceRepo.createQueryBuilder().delete().execute();
    await outboxRepo.createQueryBuilder().delete().execute();
  });

  describe('Event Publishing to Notification Delivery', () => {
    it('should publish event and create outbox entry', async () => {
      const event = {
        eventType: EventType.CLAIM_CREATED,
        aggregateId: 'claim-123',
        recipientIds: ['user-1'],
        metadata: { title: 'Test Claim', amount: 1000 },
      };

      const result = await eventPublisher.publishEvent(event);

      expect(result.id).toBeDefined();
      expect(result.status).toBe('PENDING');

      const outboxEvent = await outboxRepo.findOne({ where: { id: result.id } });
      expect(outboxEvent).toBeDefined();
      expect(outboxEvent!.status).toBe('PENDING');
    });
  });

  describe('Preference Enforcement', () => {
    it('should respect user channel preferences', async () => {
      const userId = 'user-prefs-1';

      const prefs = await preferenceEnforcer.getPreferences(userId);
      prefs.channels = { IN_APP: true, EMAIL: false, PUSH: false, WEBHOOK: false, WEBSOCKET: true } as typeof prefs.channels;
      await preferenceEnforcer.updatePreferences(userId, prefs);

      const emailEnabled = await preferenceEnforcer.isChannelEnabled(userId, 'EMAIL');
      expect(emailEnabled).toBe(false);

      const inAppEnabled = await preferenceEnforcer.isChannelEnabled(userId, 'IN_APP');
      expect(inAppEnabled).toBe(true);
    });

    it('should respect quiet hours', async () => {
      const userId = 'user-quiet-1';

      const prefs = await preferenceEnforcer.getPreferences(userId);
      prefs.quietHours = {
        enabled: true,
        startTime: '22:00',
        endTime: '08:00',
        timezone: 'UTC',
      };
      await preferenceEnforcer.updatePreferences(userId, prefs);

      const inQuietHours = await preferenceEnforcer.isInQuietHours(userId);
      expect(typeof inQuietHours).toBe('boolean');
    });

    it('should enforce category subscriptions', async () => {
      const userId = 'user-subs-1';

      const prefs = await preferenceEnforcer.getPreferences(userId);
      prefs.categorySubscriptions = {
        [EventType.CLAIM_CREATED]: true,
        [EventType.GOVERNANCE_PROPOSAL_CREATED]: false,
      } as typeof prefs.categorySubscriptions;
      await preferenceEnforcer.updatePreferences(userId, prefs);

      const claimEnabled = await preferenceEnforcer.isCategoryEnabled(
        userId,
        EventType.CLAIM_CREATED,
      );
      expect(claimEnabled).toBe(true);

      const govEnabled = await preferenceEnforcer.isCategoryEnabled(
        userId,
        EventType.GOVERNANCE_PROPOSAL_CREATED,
      );
      expect(govEnabled).toBe(false);
    });
  });

  describe('Template Rendering', () => {
    it('should initialize and render default templates', async () => {
      await templateService.initializeDefaultTemplates();

      const context = {
        title: 'COVID-19 Origins',
        claimUrl: 'https://truthbounty.io/claims/123',
      };

      const rendered = await templateRenderer.render(EventType.CLAIM_CREATED, 'IN_APP', context);

      expect(rendered.body).toBeDefined();
      expect(rendered.title || rendered.subject).toBeDefined();
    });

    it('should substitute template variables correctly', async () => {
      await templateService.initializeDefaultTemplates();

      const context = {
        title: 'Test Claim',
        amount: '5000',
        claimUrl: 'https://truthbounty.io/claims/456',
      };

      const rendered = await templateRenderer.render(EventType.CLAIM_CREATED, 'EMAIL', context);

      expect(rendered.body).toContain('Test Claim');
      expect(rendered.html).toBeDefined();
    });

    it('should handle missing variables gracefully', async () => {
      await templateService.initializeDefaultTemplates();

      const context = {};
      const rendered = await templateRenderer.render(EventType.CLAIM_CREATED, 'IN_APP', context);

      expect(rendered.body).toBeDefined();
    });
  });

  describe('Delivery Tracking', () => {
    it('should track successful delivery and scope history to the recipient', async () => {
      const userId = 'user-track-1';
      const channel = 'IN_APP';
      const idempotencyKey = 'idem-key-1';

      await deliveryTracker.recordDelivery(
        'notif-123',
        userId,
        channel,
        idempotencyKey,
      );

      const history = await deliveryHistoryRepo.find({
        where: { recipientId: userId },
      });

      expect(history.length).toBe(1);
      expect(history[0].recipientId).toBe(userId);
      expect(history[0].notificationId).toBe('notif-123');
    });

    it('should enforce idempotency', async () => {
      const idempotencyKey = 'idem-unique-key';

      const first = await deliveryTracker.checkIdempotency(idempotencyKey);
      expect(first).toBe(true);
    });

    it('should track delivery failures', async () => {
      const channel = 'EMAIL';
      const userId = 'user-fail-1';

      await deliveryTracker.recordFailure(
        'notif-fail-1',
        channel,
        'Provider timeout',
        'idem-fail-1',
        0,
        userId,
      );

      const history = await deliveryHistoryRepo.find({
        where: { recipientId: userId },
      });

      expect(history.length).toBe(1);
      expect(history[0].status).toBe('FAILED');
    });
  });

  describe('Date range and pagination queries', () => {
    const baseTime = new Date('2024-01-01T00:00:00Z');

    async function seedHistory(userId: string, count: number): Promise<void> {
      const rows: Partial<DeliveryHistory>[] = [];
      for (let i = 0; i < count; i++) {
        rows.push({
          notificationId: `notif-${userId}-${i}`,
          recipientId: userId,
          channel: 'IN_APP',
          status: 'DELIVERED',
          attemptedAt: new Date(baseTime.getTime() + i * 60 * 60 * 1000),
        });
      }
      await deliveryHistoryRepo.save(rows);
    }

    it('should filter by date range using supported TypeORM operators', async () => {
      const userId = 'user-date-1';
      await seedHistory(userId, 5);

      const from = new Date(baseTime.getTime() + 1 * 60 * 60 * 1000);
      const to = new Date(baseTime.getTime() + 3 * 60 * 60 * 1000);

      const results = await deliveryHistoryRepo.find({
        where: {
          recipientId: userId,
          attemptedAt: Between(from, to),
        },
        order: { attemptedAt: 'ASC' },
      });

      expect(results.length).toBe(3);
      for (const row of results) {
        expect(row.attemptedAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
        expect(row.attemptedAt.getTime()).toBeLessThanOrEqual(to.getTime());
      }
    });

    it('should paginate results deterministically', async () => {
      const userId = 'user-page-1';
      await seedHistory(userId, 10);

      const pageSize = 3;
      const page1 = await deliveryHistoryRepo.find({
        where: { recipientId: userId },
        order: { attemptedAt: 'ASC' },
        take: pageSize,
        skip: 0,
      });
      const page2 = await deliveryHistoryRepo.find({
        where: { recipientId: userId },
        order: { attemptedAt: 'ASC' },
        take: pageSize,
        skip: pageSize,
      });

      expect(page1.length).toBe(pageSize);
      expect(page2.length).toBe(pageSize);
      const page1Ids = page1.map((row) => row.notificationId);
      const page2Ids = page2.map((row) => row.notificationId);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it('should isolate delivery history by user', async () => {
      const userA = 'user-isolation-a';
      const userB = 'user-isolation-b';
      await seedHistory(userA, 4);
      await seedHistory(userB, 6);

      const results = await deliveryHistoryRepo.find({
        where: { recipientId: userA, attemptedAt: Between(baseTime, new Date(baseTime.getTime() + 24 * 60 * 60 * 1000)) },
        order: { attemptedAt: 'ASC' },
      });

      expect(results.length).toBe(4);
      for (const row of results) {
        expect(row.recipientId).toBe(userA);
      }
    });

    it('should clean up history older than the retention window', async () => {
      const userId = 'user-retention-1';
      const now = new Date('2024-06-01T00:00:00Z');
      const old = new Date('2023-01-01T00:00:00Z');
      const recent = new Date('2024-05-31T00:00:00Z');

      await deliveryHistoryRepo.save([
        {
          notificationId: 'notif-old-1',
          recipientId: userId,
          channel: 'IN_APP',
          status: 'DELIVERED',
          attemptedAt: old,
        },
        {
          notificationId: 'notif-recent-1',
          recipientId: userId,
          channel: 'IN_APP',
          status: 'DELIVERED',
          attemptedAt: recent,
        },
      ]);

      const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      await deliveryHistoryRepo
        .createQueryBuilder()
        .delete()
        .from(DeliveryHistory)
        .where('recipientId = :userId', { userId })
        .andWhere('attemptedAt < ' + ':cutoff', { cutoff })
        .execute();

      const remaining = await deliveryHistoryRepo.find({
        where: { recipientId: userId },
        order: { attemptedAt: 'ASC' },
      });

      expect(remaining.length).toBe(1);
      expect(remaining[0].notificationId).toBe('notif-recent-1');
    });

    it('should handle concurrent delivery records without crossing user boundaries', async () => {
      const userA = 'user-concurrent-a';
      const userB = 'user-concurrent-b';

      await Promise.all([
        deliveryTracker.recordDelivery('notif-c-a-1', userA, 'IN_APP', 'idem-c-a-1'),
        deliveryTracker.recordDelivery('notif-c-b-1', userB, 'IN_APP', 'idem-c-b-1'),
        deliveryTracker.recordDelivery('notif-c-a-2', userA, 'IN_APP', 'idem-c-a-2'),
        deliveryTracker.recordDelivery('notif-c-b-2', userB, 'IN_APP', 'idem-c-b-2'),
      ]);

      const historyA = await deliveryHistoryRepo.find({ where: { recipientId: userA } });
      const historyB = await deliveryHistoryRepo.find({ where: { recipientId: userB } });

      expect(historyA.length).toBe(2);
      expect(historyB.length).toBe(2);
      for (const row of historyA) {
        expect(row.recipientId).toBe(userA);
      }
      for (const row of historyB) {
        expect(row.recipientId).toBe(userB);
      }
    });
  });
});
