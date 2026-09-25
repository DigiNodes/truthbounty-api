import { Module, Global } from '@nestjs/common';
import { ClaimsCache } from './claims.cache';
import { CacheHealthService } from './cache-health.service';
import { RedisModule } from '../redis/redis.module';

@Global()
@Module({
    imports: [RedisModule],
    providers: [ClaimsCache, CacheHealthService],
    exports: [ClaimsCache, CacheHealthService],
})
export class CacheModule { }
