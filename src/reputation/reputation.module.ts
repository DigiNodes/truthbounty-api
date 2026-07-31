import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReputationController } from './reputation.controller';
import { ReputationService } from './reputation.service';
import { ReputationCache } from './reputation.cache';
import { ReputationRecord, ReputationEvent } from './entities/reputation.entity';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReputationRecord, ReputationEvent]),
    CacheModule,
  ],
  controllers: [ReputationController],
  providers: [ReputationService, ReputationCache],
  exports: [ReputationService],
})
export class ReputationModule {}
