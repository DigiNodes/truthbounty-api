import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectionEvent } from './entities/projection-event.entity';
import { RealtimeService } from './realtime.service';
import { RealtimeBusService } from './realtime-bus.service';
import { RealtimePublisherService } from './realtime-publisher.service';
import { RealtimeConfigService } from './realtime-config.service';
import { RealtimeStreamController } from './realtime-stream.controller';

/**
 * Projection-backed realtime event stream.
 *
 * Outbox rows persisted in `projection_events` are delivered to authenticated
 * subscribers (SSE) only after their database transaction commits, with resume
 * cursors, heartbeat, bounded backpressure, and rollback/replacement messages.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectionEvent])],
  controllers: [RealtimeStreamController],
  providers: [
    RealtimeService,
    RealtimeBusService,
    RealtimePublisherService,
    RealtimeConfigService,
  ],
  exports: [RealtimeService, RealtimeBusService, RealtimePublisherService],
})
export class RealtimeModule {}
