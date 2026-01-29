import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from '../src/redis/redis.module';
import { RedisService } from '../src/redis/redis.service';

describe('Redis Connectivity (e2e)', () => {
  let app: INestApplication;
  let redisService: RedisService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
        }),
        RedisModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    redisService = moduleFixture.get<RedisService>(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Redis Connection', () => {
    it('should have RedisService available', () => {
      expect(redisService).toBeDefined();
    });

    it('should report connection status', () => {
      const status = redisService.getStatus();
      expect(status).toBeDefined();
      expect(status).toHaveProperty('connected');
      expect(status).toHaveProperty('enabled');
    });

    it('should perform health check', async () => {
      const isHealthy = await redisService.isHealthy();
      // Redis might not be available in CI/CD, so we just check the method works
      expect(typeof isHealthy).toBe('boolean');
    });
  });

  describe('Redis Operations (if available)', () => {
    beforeEach(async () => {
      // Clean up test keys
      await redisService.del('test:key');
      await redisService.del('test:ttl');
    });

    it('should set and get a value', async () => {
      const status = redisService.getStatus();
      
      if (!status.connected) {
        console.log('⚠️  Redis not available, skipping set/get test');
        return;
      }

      const setResult = await redisService.set('test:key', 'test-value');
      expect(setResult).toBe(true);

      const getValue = await redisService.get('test:key');
      expect(getValue).toBe('test-value');
    });

    it('should set value with TTL', async () => {
      const status = redisService.getStatus();
      
      if (!status.connected) {
        console.log('⚠️  Redis not available, skipping TTL test');
        return;
      }

      const setResult = await redisService.set('test:ttl', 'expires-soon', 2);
      expect(setResult).toBe(true);

      const getValue = await redisService.get('test:ttl');
      expect(getValue).toBe('expires-soon');

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 2100));

      const expiredValue = await redisService.get('test:ttl');
      expect(expiredValue).toBeNull();
    });

    it('should delete a key', async () => {
      const status = redisService.getStatus();
      
      if (!status.connected) {
        console.log('⚠️  Redis not available, skipping delete test');
        return;
      }

      await redisService.set('test:delete', 'to-be-deleted');
      const deleteResult = await redisService.del('test:delete');
      expect(deleteResult).toBe(true);

      const getValue = await redisService.get('test:delete');
      expect(getValue).toBeNull();
    });

    it('should handle missing keys gracefully', async () => {
      const status = redisService.getStatus();
      
      if (!status.connected) {
        console.log('⚠️  Redis not available, skipping missing key test');
        return;
      }

      const getValue = await redisService.get('test:nonexistent');
      expect(getValue).toBeNull();
    });
  });

  describe('Graceful Degradation', () => {
    it('should not throw errors when Redis is unavailable', async () => {
      // These operations should not throw even if Redis is down
      await expect(redisService.get('any:key')).resolves.not.toThrow();
      await expect(redisService.set('any:key', 'value')).resolves.not.toThrow();
      await expect(redisService.del('any:key')).resolves.not.toThrow();
    });

    it('should return false/null when Redis operations fail', async () => {
      const status = redisService.getStatus();
      
      if (status.connected) {
        console.log('✅ Redis is connected, skipping degradation test');
        return;
      }

      // When Redis is unavailable, operations should return false/null
      const getValue = await redisService.get('test:key');
      expect(getValue).toBeNull();

      const setResult = await redisService.set('test:key', 'value');
      expect(setResult).toBe(false);

      const delResult = await redisService.del('test:key');
      expect(delResult).toBe(false);
    });
  });
});
