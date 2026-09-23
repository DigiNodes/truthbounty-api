import { Module, Global } from '@nestjs/common';
import { ClaimsCache } from './claims.cache';
import { CacheKeyRegistryService } from './cache-key-registry.service';
import { RedisModule } from '../redis/redis.module';

@Global()
@Module({
    imports: [RedisModule],
    providers: [ClaimsCache, CacheKeyRegistryService],
    exports: [ClaimsCache, CacheKeyRegistryService],
})
export class CacheModule { }