import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CanonicalEvent } from '../../events/entities/canonical-event.entity';
import { ContractArtifact } from '../../events/entities/contract-artifact.entity';
import { EventQuarantine } from '../../events/entities/event-quarantine.entity';
import { ProjectorCursor } from '../entities/projector-cursor.entity';
import { ProjectionReadinessService } from './projection-readiness.service';
import { ProjectionReadinessController } from './projection-readiness.controller';

/**
 * Exposes the Projection Readiness Gate as an injectable guard for V2 read
 * paths and as a read-only operator endpoint.
 *
 * It owns no data of its own: every input is an existing canonical-stream,
 * cursor, or quarantine table, so the gate adds an enforcement layer without
 * introducing a second source of truth for protocol state.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CanonicalEvent,
      ContractArtifact,
      EventQuarantine,
      ProjectorCursor,
    ]),
  ],
  controllers: [ProjectionReadinessController],
  providers: [ProjectionReadinessService],
  exports: [ProjectionReadinessService],
})
export class ProjectionReadinessModule {}
