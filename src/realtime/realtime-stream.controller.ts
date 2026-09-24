import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  MessageEvent,
  Post,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RealtimeService, RealtimeBackpressureError } from './realtime.service';
import { RealtimeConfigService } from './realtime-config.service';
import { PublishProjectionDto } from './dto/publish-projection.dto';
import { RealtimeEnvelopeType } from './realtime.enums';

/**
 * Serves the projection-backed realtime event stream.
 *
 *  - Authentication: the stream endpoint is protected by {@link JwtAuthGuard}
 *    (Bearer token), so only authenticated clients may subscribe.
 *  - Resume cursor: a client supplies `Last-Event-ID` to resume after a
 *    disconnect; the service replays committed outbox rows after that cursor.
 *  - Heartbeat + backpressure: handled inside {@link RealtimeService}.
 *
 * A separate authenticated `POST` endpoint allows internal services to record
 * projection changes. It is intentionally narrow and validated.
 */
@ApiTags('realtime')
@ApiBearerAuth('JWT-auth')
@Controller('realtime')
@UseGuards(JwtAuthGuard)
export class RealtimeStreamController {
  private readonly logger = new Logger(RealtimeStreamController.name);

  constructor(
    private readonly realtime: RealtimeService,
    private readonly configService: RealtimeConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Open a realtime projection stream via Server-Sent Events.
   */
  @Sse('events')
  @ApiOperation({
    summary: 'Realtime projection event stream (Server-Sent Events)',
    description:
      'Authenticated SSE stream of normalized projection changes. Send the ' +
      '"Last-Event-ID" header to resume after a cursor.',
  })
  stream(@Req() request: Request): Observable<MessageEvent> {
    const afterId = this.parseCursor(request.headers['last-event-id']);
    const config = this.configService.getConfig();

    return new Observable<MessageEvent>((subscriber) => {
      const source = this.realtime.streamFrom({
        afterId,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        maxBacklog: config.maxBacklog,
      });

      const subscription = source.subscribe({
        next: (envelope) => {
          if (envelope.type === RealtimeEnvelopeType.HEARTBEAT) {
            subscriber.next({ type: envelope.type, data: {} });
            return;
          }
          subscriber.next({
            type: envelope.type,
            data: envelope,
          });
        },
        error: (err) => {
          if (err instanceof RealtimeBackpressureError) {
            this.logger.warn(`Stream closed for slow client: ${err.message}`);
            subscriber.error(
              new HttpException(
                {
                  statusCode: HttpStatus.SERVICE_UNAVAILABLE,
                  code: 'BACKPRESSURE',
                  message: err.message,
                },
                HttpStatus.SERVICE_UNAVAILABLE,
              ),
            );
            return;
          }
          this.logger.error(`Stream error: ${(err as Error)?.message ?? err}`);
          subscriber.error(err);
        },
        complete: () => subscriber.complete(),
      });

      return () => subscription.unsubscribe();
    });
  }

  /**
   * Record a normalized projection change. Body is validated at the boundary.
   * The change is written to the outbox within the request transaction so it
   * is committed (and thus only visible to the publisher) after success —
   * preserving the "publish after commit" guarantee.
   */
  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Record a projection change (internal)',
    description:
      'Stores a normalized projection change for realtime delivery after the ' +
      'database transaction commits.',
  })
  async publish(
    @Body() dto: PublishProjectionDto,
  ): Promise<{ accepted: boolean; cursor?: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const result = await this.realtime.emitWithinTransaction(
        queryRunner.manager,
        dto,
      );
      await queryRunner.commitTransaction();
      this.logger.log(
        `Projection change recorded (#${result.id}, ${dto.eventType}) for ${dto.aggregateType}:${dto.aggregateId}`,
      );
      return { accepted: true, cursor: result.id };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          code: 'INVALID_PROJECTION',
          message: (err as Error).message,
        },
        HttpStatus.BAD_REQUEST,
      );
    } finally {
      await queryRunner.release();
    }
  }

  private parseCursor(header: string | string[] | undefined): number {
    if (header === undefined) {
      return 0;
    }
    const raw = Array.isArray(header) ? header[0] : header;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Math.floor(parsed);
  }
}
