import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisService } from './redis.service';
import { TracingModule } from '../tracing/tracing.module';

/**
 * Redis Module
 * 
 * Provides Redis caching capabilities across the application.
 * Marked as @Global so it can be used without importing in every module.
 */
@Global()
@Module({
  imports: [ConfigModule, TracingModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
