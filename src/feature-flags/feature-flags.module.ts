import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '../redis/redis.module';
import { FeatureFlagsService } from './feature-flags.service';
import { ConfigurationService } from './configuration.service';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlag } from './entities/feature-flag.entity';
import { ConfigurationValue } from './entities/configuration-value.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([FeatureFlag, ConfigurationValue]),
    RedisModule,
  ],
  providers: [FeatureFlagsService, ConfigurationService],
  controllers: [FeatureFlagsController],
  exports: [FeatureFlagsService, ConfigurationService],
})
export class FeatureFlagsModule {}
