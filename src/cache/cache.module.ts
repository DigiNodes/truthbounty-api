import { Module, Global } from '@nestjs/common';
import { ClaimsCache } from './claims.cache';
import { CacheHealthService } from './cache-health.service';
import { RedisModule } from '../redis/redis.module';
import { GovernanceModule } from '../governance/governance.module';
import { ReputationModule } from '../reputation/reputation.module';

@Global()
@Module({
    imports: [RedisModule, GovernanceModule, ReputationModule],
    providers: [ClaimsCache, CacheHealthService],
    exports: [ClaimsCache, CacheHealthService],
})
export class CacheModule { }
