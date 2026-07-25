import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisService } from './redis/redis.service';
import { DataSource } from 'typeorm';

jest.mock('./prisma/prisma.service', () => {
  return {
    PrismaService: jest.fn().mockImplementation(() => ({
      $queryRaw: jest.fn().mockResolvedValue([1]),
    })),
  };
});

import { PrismaService } from './prisma/prisma.service';

describe('AppController', () => {
  let appController: AppController;
  let redisService: RedisService;
  let prismaService: PrismaService;
  let dataSource: DataSource;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: RedisService,
          useValue: {
            isHealthy: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn().mockResolvedValue([1]),
          },
        },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn().mockResolvedValue([1]),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
    redisService = app.get<RedisService>(RedisService);
    prismaService = app.get<PrismaService>(PrismaService);
    dataSource = app.get<DataSource>(DataSource);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('should return healthy status when all services are healthy', async () => {
      const health = await appController.getHealth();

      expect(health.status).toBe('OK');
      expect(health.services.database).toBe('healthy');
      expect(health.services.prisma).toBe('healthy');
      expect(health.services.redis).toBe('healthy');
    });

    it('should return error status when TypeORM database is unhealthy', async () => {
      jest.spyOn(dataSource, 'query').mockRejectedValueOnce(new Error('Connection lost'));

      const health = await appController.getHealth();

      expect(health.status).toBe('Error');
      expect(health.services.database).toContain('unhealthy');
      expect(health.services.prisma).toBe('healthy');
      expect(health.services.redis).toBe('healthy');
    });

    it('should return error status when Prisma database is unhealthy', async () => {
      jest.spyOn(prismaService, '$queryRaw').mockRejectedValueOnce(new Error('Prisma error'));

      const health = await appController.getHealth();

      expect(health.status).toBe('Error');
      expect(health.services.database).toBe('healthy');
      expect(health.services.prisma).toContain('unhealthy');
      expect(health.services.redis).toBe('healthy');
    });

    it('should return error status when Redis is unhealthy', async () => {
      jest.spyOn(redisService, 'isHealthy').mockResolvedValueOnce(false);

      const health = await appController.getHealth();

      expect(health.status).toBe('Error');
      expect(health.services.database).toBe('healthy');
      expect(health.services.prisma).toBe('healthy');
      expect(health.services.redis).toBe('unhealthy');
    });
  });
});
