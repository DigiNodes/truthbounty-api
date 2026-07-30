import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '../redis/redis.module';
import { FeatureFlagsService } from './feature-flags.service';
import { ConfigurationService } from './configuration.service';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlag } from './entities/feature-flag.entity';
import { ConfigurationValue } from './entities/configuration-value.entity';
import { ConfigurationHistory } from './entities/configuration-history.entity';
import { FeatureFlagsMetricsService } from './metrics/feature-flag.metrics';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FeatureFlag, 
      ConfigurationValue,
      ConfigurationHistory,
    ]),
    RedisModule,
  ],
  providers: [
    FeatureFlagsService, 
    ConfigurationService,
    FeatureFlagsMetricsService,
  ],
  controllers: [FeatureFlagsController],
  exports: [FeatureFlagsService, ConfigurationService, FeatureFlagsMetricsService],
})
export class FeatureFlagsModule {}
