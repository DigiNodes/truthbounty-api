import { Module, Global } from '@nestjs/common';
import { ClaimsCache } from './claims.cache';
import { CacheHealthService } from './cache-health.service';
import { CacheKeyRegistryService } from './cache-key-registry.service';
import { CacheScanService } from './cache-scan.service';
import { RedisModule } from '../redis/redis.module';

@Module()
@Global()
@Module({
  imports: [RedisModule],
  providers: [
    ClaimsCache,
    CacheHealthService,
    CacheKeyRegistryService,
    CacheScanService,
  ],
  exports: [
    ClaimsCache,
    CacheHealthService,
    CacheKeyRegistryService,
    CacheScanService,
  ],
})
export class CacheModule {}
