import { Module, Global } from '@nestjs/common';
import { ClaimsCache } from './claims.cache';
import { CacheHealthService } from './cache-health.service';
import { CacheKeyRegistryService } from './cache-key-registry.service';
import { RedisModule } from '../redis/redis.module';

@Global()
@Module({
  imports: [RedisModule],
  providers: [ClaimsCache, CacheHealthService, CacheKeyRegistryService],
  exports: [ClaimsCache, CacheHealthService, CacheKeyRegistryService],
})
export class CacheModule {}