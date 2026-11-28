import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationsRetentionService } from './notifications-retention.service';
import { Notification } from './entities/notification.entity';
import { DeliveryHistory } from './entities/delivery-history.entity';
import { NotificationStatus } from './enums/notification-status.enum';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRepo<T>(overrides: Partial<jest.Mocked<Repository<T>>> = {}): jest.Mocked<Repository<T>> {
  return {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  } as unknown as jest.Mocked<Repository<T>>;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('NotificationsRetentionService', () => {
  let service: NotificationsRetentionService;
  let notificationRepo: jest.Mocked<Repository<Notification>>;
  let deliveryRepo: jest.Mocked<Repository<DeliveryHistory>>;

  beforeEach(async () => {
    notificationRepo = makeRepo<Notification>();
    deliveryRepo = makeRepo<DeliveryHistory>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsRetentionService,
        { provide: getRepositoryToken(Notification), useValue: notificationRepo },
        { provide: getRepositoryToken(DeliveryHistory), useValue: deliveryRepo },
      ],
    }).compile();

    service = module.get(NotificationsRetentionService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── basic operation ─────────────────────────────────────────────────────────

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('calls delete on both repositories and returns counts', async () => {
    notificationRepo.delete.mockResolvedValue({ affected: 5 } as any);
    deliveryRepo.delete.mockResolvedValue({ affected: 12 } as any);

    const result = await service.runRetentionCleanup();

    expect(result.notificationsDeleted).toBe(5);
    expect(result.deliveriesDeleted).toBe(12);
    expect(notificationRepo.delete).toHaveBeenCalledTimes(1);
    expect(deliveryRepo.delete).toHaveBeenCalledTimes(1);
  });

  // ── idempotency: non-expired records not deleted ─────────────────────────────

  it('queries deliveries by createdAt < cutoff (not all deliveries)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T12:00:00Z'));

    deliveryRepo.delete.mockResolvedValue({ affected: 0 } as any);
    notificationRepo.delete.mockResolvedValue({ affected: 0 } as any);

    await service.runRetentionCleanup(90, 180);

    const deliveryCall = deliveryRepo.delete.mock.calls[0][0] as any;
    // The cutoff for deliveries (180 days) must be in the past
    expect(deliveryCall.createdAt.value).toBeDefined();
    const cutoffDate = new Date(deliveryCall.createdAt.value);
    expect(cutoffDate.getTime()).toBeLessThan(new Date('2026-06-15T12:00:00Z').getTime());

    jest.useRealTimers();
  });

  it('queries notifications with only terminal statuses', async () => {
    notificationRepo.delete.mockResolvedValue({ affected: 0 } as any);
    deliveryRepo.delete.mockResolvedValue({ affected: 0 } as any);

    await service.runRetentionCleanup();

    const notifCall = notificationRepo.delete.mock.calls[0][0] as any;
    const statuses: string[] = notifCall.status.value as string[];

    // Must include all terminal statuses
    expect(statuses).toContain(NotificationStatus.DELIVERED);
    expect(statuses).toContain(NotificationStatus.READ);
    expect(statuses).toContain(NotificationStatus.DISMISSED);
    expect(statuses).toContain(NotificationStatus.FAILED);

    // Must NOT include active/in-flight status
    expect(statuses).not.toContain(NotificationStatus.QUEUED);
  });

  it('is idempotent: calling twice does not change result when nothing is left to delete', async () => {
    notificationRepo.delete.mockResolvedValue({ affected: 0 } as any);
    deliveryRepo.delete.mockResolvedValue({ affected: 0 } as any);

    const r1 = await service.runRetentionCleanup();
    const r2 = await service.runRetentionCleanup();

    expect(r1).toEqual({ notificationsDeleted: 0, deliveriesDeleted: 0 });
    expect(r2).toEqual({ notificationsDeleted: 0, deliveriesDeleted: 0 });
  });

  // ── cutoff window boundary ───────────────────────────────────────────────────

  it('notification cutoff is exactly N days before now', () => {
    jest.useFakeTimers();
    const now = new Date('2026-06-15T00:00:00Z');
    jest.setSystemTime(now);

    // Access private method via cast
    const cutoff = (service as any).cutoffDate(90) as Date;
    const expectedMs = now.getTime() - 90 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBe(expectedMs);

    jest.useRealTimers();
  });

  it('delivery cutoff is distinct from notification cutoff when different days configured', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T00:00:00Z'));

    deliveryRepo.delete.mockResolvedValue({ affected: 0 } as any);
    notificationRepo.delete.mockResolvedValue({ affected: 0 } as any);

    await service.runRetentionCleanup(30, 180);

    const deliveryCutoff = new Date((deliveryRepo.delete.mock.calls[0][0] as any).createdAt.value);
    const notifCutoff = new Date((notificationRepo.delete.mock.calls[0][0] as any).createdAt.value);

    // 180 days is older (earlier) than 30 days
    expect(deliveryCutoff.getTime()).toBeLessThan(notifCutoff.getTime());

    jest.useRealTimers();
  });

  // ── input validation ─────────────────────────────────────────────────────────

  it('throws when notificationRetentionDays is 0', async () => {
    await expect(service.runRetentionCleanup(0)).rejects.toThrow(
      'notificationRetentionDays must be a positive finite number',
    );
  });

  it('throws when notificationRetentionDays is negative', async () => {
    await expect(service.runRetentionCleanup(-5)).rejects.toThrow(
      'notificationRetentionDays must be a positive finite number',
    );
  });

  it('throws when deliveryRetentionDays is Infinity', async () => {
    await expect(service.runRetentionCleanup(90, Infinity)).rejects.toThrow(
      'deliveryRetentionDays must be a positive finite number',
    );
  });

  // ── delivery rows deleted before notification rows (FK safety) ───────────────

  it('deletes delivery history before notifications to respect FK constraints', async () => {
    const callOrder: string[] = [];
    deliveryRepo.delete.mockImplementation(async () => {
      callOrder.push('delivery');
      return { affected: 0 } as any;
    });
    notificationRepo.delete.mockImplementation(async () => {
      callOrder.push('notification');
      return { affected: 0 } as any;
    });

    await service.runRetentionCleanup();

    expect(callOrder[0]).toBe('delivery');
    expect(callOrder[1]).toBe('notification');
  });

  // ── returns 0 gracefully when affected is undefined ──────────────────────────

  it('returns 0 when delete returns undefined affected', async () => {
    notificationRepo.delete.mockResolvedValue({ affected: undefined } as any);
    deliveryRepo.delete.mockResolvedValue({ affected: undefined } as any);

    const result = await service.runRetentionCleanup();

    expect(result.notificationsDeleted).toBe(0);
    expect(result.deliveriesDeleted).toBe(0);
  });
});
