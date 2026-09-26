import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockchainModule } from '../../blockchain/blockchain.module';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { ProjectionFreshnessController } from './projection-freshness.controller';
import { ProjectionFreshnessService } from './projection-freshness.service';

/**
 * V2 projection freshness module (issue408).
 *
 * Read-only: registers existing `ProjectorCursor` / `EventCheckpoint`
 * repositories for reads (no new TypeORM entities, no migrations) and
 * consumes the sanitized `BlockchainStateService` snapshot. Prisma remains
 * the canonical persistence layer for any future writes.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ProjectorCursor, EventCheckpoint]),
    BlockchainModule,
  ],
  controllers: [ProjectionFreshnessController],
  providers: [ProjectionFreshnessService],
  exports: [ProjectionFreshnessService],
})
export class V2ProjectionModule {}
