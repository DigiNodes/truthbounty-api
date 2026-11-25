import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeliveryTracker } from './delivery-tracker.service';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import { RedisService } from '../../redis/redis.service';

describe('DeliveryTracker.getUserDeliveryHistory', () => {
  let service: DeliveryTracker;
  let deliveryHistoryRepository: any;
  let queryBuilder: any;

  beforeEach(async () => {
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    deliveryHistoryRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      find: jest.fn(),
      findAndCount: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryTracker,
        {
          provide: getRepositoryToken(DeliveryHistory),
          useValue: deliveryHistoryRepository,
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            setnx: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DeliveryTracker>(DeliveryTracker);
  });

  it('constrains the page and count query to the owning notification user', async () => {
    const items = [{ id: 'history-1', notificationId: 'notification-1' }];
    queryBuilder.getManyAndCount.mockResolvedValue([items, 1]);

    const result = await service.getUserDeliveryHistory('user-a');

    expect(deliveryHistoryRepository.createQueryBuilder).toHaveBeenCalledWith(
      'history',
    );
    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      'history.notification',
      'notification',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'notification.userId = :userId',
      { userId: 'user-a' },
    );
    expect(queryBuilder.getManyAndCount).toHaveBeenCalledTimes(1);
    expect(deliveryHistoryRepository.find).not.toHaveBeenCalled();
    expect(deliveryHistoryRepository.findAndCount).not.toHaveBeenCalled();
    expect(result).toEqual({ items, total: 1 });
  });

  it('returns only authorized delivery fields with stable ordering', async () => {
    await service.getUserDeliveryHistory('user-a');

    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'history.createdAt',
      'DESC',
    );
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('history.id', 'DESC');

    const selected = queryBuilder.select.mock.calls[0][0];
    expect(selected).toEqual(
      expect.arrayContaining([
        'history.id',
        'history.notificationId',
        'history.channel',
        'history.status',
        'history.retryAttempts',
        'history.lastRetryAt',
        'history.deliveredAt',
        'history.failureReason',
        'history.createdAt',
      ]),
    );
    expect(selected).not.toContain('history.metadata');
    expect(selected).not.toContain('history.idempotencyKey');
    expect(selected).not.toContain('notification');
  });

  it('bounds pagination inputs', async () => {
    await service.getUserDeliveryHistory('user-a', -10, 10000);

    expect(queryBuilder.skip).toHaveBeenCalledWith(0);
    expect(queryBuilder.take).toHaveBeenCalledWith(100);

    await service.getUserDeliveryHistory('user-a', 2.9, 0);

    expect(queryBuilder.skip).toHaveBeenLastCalledWith(2);
    expect(queryBuilder.take).toHaveBeenLastCalledWith(1);
  });

  it('uses safe defaults for non-finite pagination inputs', async () => {
    await service.getUserDeliveryHistory(
      'user-a',
      Number.NaN,
      Number.POSITIVE_INFINITY,
    );

    expect(queryBuilder.skip).toHaveBeenCalledWith(0);
    expect(queryBuilder.take).toHaveBeenCalledWith(50);
  });
});
