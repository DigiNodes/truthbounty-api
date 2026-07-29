import { Module, Global } from '@nestjs/common';
import { ProfilerService } from './profiler.service';
import { ProfilerController } from './profiler.controller';
import { ProfilerInterceptor } from './profiler.interceptor';
import { DatabaseProfiler } from './sub-profilers/database-profiler';
import { RedisProfiler } from './sub-profilers/redis-profiler';
import { BlockchainProfiler } from './sub-profilers/blockchain-profiler';
import { JobProfiler } from './sub-profilers/job-profiler';
import { NotificationProfiler } from './sub-profilers/notification-profiler';

@Global()
@Module({
  controllers: [ProfilerController],
  providers: [
    ProfilerService,
    ProfilerInterceptor,
    DatabaseProfiler,
    RedisProfiler,
    BlockchainProfiler,
    JobProfiler,
    NotificationProfiler,
  ],
  exports: [
    ProfilerService,
    ProfilerInterceptor,
    DatabaseProfiler,
    RedisProfiler,
    BlockchainProfiler,
    JobProfiler,
    NotificationProfiler,
  ],
})
export class ProfilerModule {}
